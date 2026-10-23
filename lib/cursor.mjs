import { writeHistory } from './state-store.mjs';
import { imageContent, imageRecords, messageImages } from './attachments.mjs';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CursorRpc } from './cursor-rpc.mjs';
import { readCursorCredential, cursorCredentialPath, withoutCursorCredentials } from './cursor-auth.mjs';
import { summarizeProgress } from './progress.mjs';
import { observeAction } from './turn-facts.mjs';

const active = new Set(['starting', 'running', 'waiting']);
const modes = { 'workspace-write': 'agent', plan: 'plan', ask: 'ask' };
const now = () => new Date().toISOString();
const clip = (value, max = 20_000) => String(value ?? '').slice(0, max);
const values = option => (option?.options || []).flatMap(entry => entry.options || [entry]).filter(entry => typeof entry.value === 'string');

/** The ACP catalogue exposes model-specific parameter IDs; never infer effort slugs. */
export function parseCursorModels(catalogue) {
  if (!Array.isArray(catalogue?.models)) throw new Error('O Cursor não devolveu um catálogo válido.');
  const models = [];
  for (const entry of catalogue.models) {
    if (!/^(?:cursor-)?grok-\d[\w.-]*$/.test(entry.value || '')) continue;
    const options = entry.configOptions || [];
    const effort = options.find(o => ['reasoning_effort', 'effort'].includes(o.id));
    const efforts = values(effort).map(o => o.value);
    if (!efforts.length) continue;
    const context = options.find(o => o.id === 'context');
    const contexts = values(context).map(o => o.value);
    const fast = options.find(o => o.id === 'fast');
    const fastValues = values(fast).map(o => o.value);
    models.push({ id: entry.value, name: entry.name || entry.value, efforts,
      defaultEffort: efforts.includes(effort.currentValue) ? effort.currentValue : efforts[0], effortParameter: effort.id,
      contexts, defaultContext: contexts.includes('500k') ? '500k' : contexts.includes(context?.currentValue) ? context.currentValue : contexts[0] || null,
      supportsFast: fastValues.includes('false') && fastValues.includes('true'),
      isDefault: entry.value === 'grok-4.7', description: 'Grok pela sessão original do Cursor. Contexto e Fast configuráveis quando anunciados pelo cliente.' });
  }
  if (!models.length) throw new Error('O catálogo nativo do Cursor não anuncia modelos Grok com parâmetros suportados.');
  return models;
}

export class Cursor extends EventEmitter {
  constructor({ dataDir, defaultCwd, executable = process.env.HYDRAQ_CURSOR_BIN || 'agent', prefixArgs = [], env = process.env, credentialFile = cursorCredentialPath(env), adapter = null }) {
    super();
    Object.assign(this, { dataDir, defaultCwd, executable, prefixArgs, credentialFile });
    this.adapter = adapter; this.label=adapter?.label || 'Cursor';
    this.env = withoutCursorCredentials(env);
    for (const key of Object.keys(this.env)) if (/^(OPENAI|ANTHROPIC|GEMINI|GOOGLE_API|XAI|GROK_API|AWS_BEDROCK|VERTEX)/.test(key)) delete this.env[key];
    this.nativeDir = path.join(dataDir, 'native');
    this.conversations = []; this.models = []; this.approvals = new Map();
    this.connection = 'disconnected'; this.connectionError = null; this.saveChain = Promise.resolve();
    this.session = null; this.processes = new Set();
  }
  async load() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(path.join(this.dataDir, 'state.json'), 'utf8'));
      if (!Array.isArray(saved.conversations)) throw new Error(`Histórico ${this.label} inválido.`);
      this.conversations = saved.conversations;
      for (const c of this.conversations) {
        for (const turn of c.turns || []) for (const interaction of turn.interactions || []) if (['pending', 'responding'].includes(interaction.status)) interaction.status = 'expired';
        if (!active.has(c.status)) continue;
        c.status = 'uncertain'; c.turnId = null;
        c.error = `O HYDRAQ reiniciou sem confirmar o resultado do ${this.label}. O pedido não foi reenviado.`;
        for (const turn of c.turns) if (active.has(turn.status)) turn.status = 'uncertain';
        for (const message of c.messages) message.streaming = false;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  snapshot() {
    return { connection: this.connection, connectionError: this.connectionError, models: this.models,
      account: this.connection === 'connected' ? { type: 'cursor', planType: 'Conta do Cursor' } : null, defaultCwd: this.defaultCwd,
      capabilities: { steer: false, nativeApprovals: true, images:this.supportsImages===true, questions: true, plans: true, tokenUsage: false, accessModes: Object.keys(modes) },
      conversations: this.conversations.map(c => ({ ...c, progress: summarizeProgress(c) })),
      approvals: [...this.approvals.values()].map(({ session, nativeId, interaction, ...request }) => request) };
  }
  changed() {
    this.historyRevision=(this.historyRevision||0)+1;
    if (!this.changeTimer) this.changeTimer = setTimeout(() => { this.changeTimer = null; this.emit('state', this.snapshot()); }, 50);
    if (!this.saveTimer) this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist().catch(() => { this.connectionError = `Não foi possível guardar o histórico do ${this.label}.`; this.emit('state', this.snapshot()); });
    }, 500);
  }
  persist() {
    const contents = JSON.stringify({ version: 1, conversations: this.conversations }, null, 2);
    this.saveChain = this.saveChain.catch(() => {}).then(async () => {
      await writeHistory(this.dataDir, contents);
    });
    return this.saveChain;
  }
  async #process(cwd,contextMcp) {
    if(this.adapter){const rpc=await this.adapter.process(this,cwd,contextMcp);this.processes.add(rpc);rpc.closed.then(()=>this.processes.delete(rpc));return rpc;}
    const secret = await readCursorCredential(this.credentialFile);
    await mkdir(this.nativeDir, { recursive: true, mode: 0o700 });
    // Keep native sessions in one private namespace; changing conversations never changes the auth origin.
    const configFile = path.join(this.nativeDir, 'cli-config.json');
    let permissions = { allow: [], deny: [] };
    try {
      const previous = JSON.parse(await readFile(configFile, 'utf8'));
      if (previous.permissions && ['allow','deny'].every(k => Array.isArray(previous.permissions[k]) && previous.permissions[k].every(v => typeof v === 'string'))) permissions = previous.permissions;
    } catch (error) { if (error.code !== 'ENOENT') throw new Error(`Configuração privada do ${this.label} inválida.`); }
    if(contextMcp)permissions={...permissions,allow:[...new Set([...permissions.allow,...contextMcp.names.map(name=>`Mcp(${contextMcp.name}:${name})`)])]};
    await writeFile(configFile, JSON.stringify({ version: 1, editor: { vimMode: false },
      approvalMode: 'allowlist', sandbox: { mode: 'enabled', readBoundary: 'workspace' }, permissions }), { mode: 0o600 });
    const rpc = new CursorRpc({ executable: this.executable, args: this.prefixArgs, cwd, secret,
      env: { ...this.env, CURSOR_CONFIG_DIR: this.nativeDir, CURSOR_DATA_DIR: path.join(this.nativeDir, 'data'), NO_OPEN_BROWSER: '1' } });
    this.processes.add(rpc); rpc.closed.then(() => this.processes.delete(rpc));
    return rpc;
  }
  async connect() {
    if(this.adapter)return this.adapter.connect(this);
    if (this.connection === 'connecting') throw new Error(`A ligação ao ${this.label} já está em curso.`);
    if (this.submitting || this.conversations.some(c => active.has(c.status))) throw new Error(`Aguarda que o pedido do ${this.label} termine.`);
    this.connection = 'connecting'; this.connectionError = null; this.changed();
    let rpc;
    try {
      const cwd = path.join(this.dataDir, 'catalog'); await mkdir(cwd, { recursive: true, mode: 0o700 });
      rpc = await this.#process(cwd);
      rpc.on('request', m => { rpc.reply(m.id, undefined, { code: -32601, message: 'Sem ferramentas durante a ligação.' }).catch(() => {}); });
      this.supportsImages=(await rpc.initialize())?.agentCapabilities?.promptCapabilities?.image===true;
      const catalogue = await rpc.call('cursor/list_available_models');
      const models = parseCursorModels(catalogue);
      // `status` can report unusable saved tokens; successful native session creation is required.
      const session = await rpc.call('session/new', { cwd, mcpServers: [] });
      if (typeof session?.sessionId !== 'string' || !session.sessionId) throw new Error(`O ${this.label} não confirmou uma sessão autenticada.`);
      this.models = models; this.connection = 'connected';
    } catch (error) {
      this.connection = 'disconnected'; this.models = [];
      this.connectionError = rpc ? rpc.redact(`Não foi possível ligar o Cursor: ${error.message}`) : error.message;
      this.changed(); throw new Error(this.connectionError);
    } finally { await rpc?.close(); }
    this.changed(); return this.snapshot();
  }
  conversation(id) { const c = this.conversations.find(c => c.id === id); if (!c) throw new Error('Conversa não encontrada.'); return c; }
  #ready() { if (this.connection !== 'connected') throw new Error(`Liga primeiro o ${this.label}.`); }
  validateSettings(conversation, settings = {}) {
    if(this.adapter)return this.adapter.validate(this,conversation,settings);
    const model = this.models.find(m => m.id === (settings.model ?? conversation?.model));
    if (!model) throw new Error(`Escolhe um Grok do catálogo nativo do ${this.label}.`);
    const effort = settings.effort ?? (model.efforts.includes(conversation?.effort) ? conversation.effort : model.defaultEffort);
    if (!model.efforts.includes(effort)) throw new Error('Raciocínio indisponível neste Grok.');
    const sandbox = settings.sandbox ?? conversation?.sandbox ?? 'workspace-write';
    if (!modes[sandbox]) throw new Error(`No ${this.label} escolhe Executar, Planear ou Perguntar.`);
    const context = settings.context ?? (model.contexts.includes(conversation?.context) ? conversation.context : model.defaultContext);
    if (model.contexts.length ? !model.contexts.includes(context) : context !== null && context !== undefined)
      throw new Error('Contexto indisponível neste Grok.');
    const fast = settings.fast ?? (model.supportsFast ? conversation?.fast ?? false : false);
    if (typeof fast !== 'boolean' || (fast && !model.supportsFast)) throw new Error('Opção Fast indisponível neste Grok.');
    return { model: model.id, effort, sandbox, context: context ?? null, fast };
  }
  async create(body) {
    this.#ready();
    const settings = this.validateSettings(null, body);
    if (typeof body.cwd !== 'string' || !path.isAbsolute(body.cwd)) throw new Error('Indica o caminho absoluto do projeto.');
    const cwd = await realpath(body.cwd); if (!(await stat(cwd)).isDirectory()) throw new Error('O projeto não é uma pasta.');
    const c = { id: randomUUID(), provider: this.adapter?.id || 'cursor', threadId: null, turnId: null, ...settings, cwd,
      title: 'Nova conversa', status: 'idle', createdAt: now(), updatedAt: now(), messages: [], items: [], turns: [], diff: '', error: null };
    this.conversations.unshift(c); await this.persist(); this.changed(); return c;
  }
  async #configure(session, settings) {
    if(this.adapter)return this.adapter.configure(this,session,settings);
    const { rpc, conversation: c } = session;
    const model = this.models.find(m => m.id === settings.model);
    const changes = [['model', model.id], [model.effortParameter, settings.effort]];
    if (model.contexts.length) changes.push(['context', settings.context]);
    if (model.supportsFast) changes.push(['fast', String(settings.fast)]);
    changes.push(['mode', modes[settings.sandbox]]);
    let state;
    for (const [configId, value] of changes) {
      if (session.stopping || !active.has(c.status)) throw new Error(`Preparação do ${this.label} interrompida.`);
      state = await rpc.call('session/set_config_option', { sessionId: c.threadId, configId, value });
      if (!state?.configOptions?.some(o => o.id === configId && o.currentValue === value)) throw new Error(`O Cursor não confirmou a configuração ${configId}.`);
    }
    for (const [configId, value] of changes) if (!state.configOptions.some(o => o.id === configId && o.currentValue === value))
      throw new Error(`A configuração ${configId} mudou durante a preparação do Cursor.`);
  }
  async #start(c, turn, contextMcp) {
    if(this.session&&this.session.contextMcpKey!==(contextMcp?.file||null)){await this.session.rpc.close();this.session=null;}
    if (this.session?.conversation !== c) { await this.session?.rpc.close(); this.session = null; }
    if (!active.has(turn.status)) throw new Error(`Preparação do ${this.label} interrompida.`);
    if (this.session && !this.session.rpc.ended) { this.session.turn = turn; this.session.phase = 'preparing'; this.session.stopping = false; this.session.publicTail = ''; return this.session; }
    const rpc = await this.#process(c.cwd,contextMcp);
    if (!active.has(turn.status)) { await rpc.close(); throw new Error(`Preparação do ${this.label} interrompida.`); }
    const session = { rpc, contextMcpKey:contextMcp?.file||null, conversation: c, turn, phase: 'preparing', stopping: false };
    this.session = session;
    rpc.on('notification', m => this.#notification(session, m));
    rpc.on('request', m => this.#request(session, m));
    rpc.on('lost', error => {
      if (active.has(session.turn?.status)) this.#finish(session, session.turn.delivery === 'sending' ? 'uncertain' : session.stopping ? 'interrupted' : 'failed', error.message);
      this.#expire(session);
      if (this.session === session) this.session = null;
    });
    try {
      session.supportsImages=(await rpc.initialize())?.agentCapabilities?.promptCapabilities?.image===true;
      if (session.stopping || !active.has(turn.status)) throw new Error(`Preparação do ${this.label} interrompida.`);
      const mcpServers=contextMcp?[{name:contextMcp.name,command:contextMcp.command,args:contextMcp.args,env:Object.entries(contextMcp.env).map(([name,value])=>({name,value}))}]:[];
      if (c.threadId) await rpc.call(this.adapter ? 'session/resume' : 'session/load', { sessionId: c.threadId, cwd: c.cwd, mcpServers });
      else {
        const result = await rpc.call('session/new', { cwd: c.cwd, mcpServers });
        if (typeof result?.sessionId !== 'string' || !result.sessionId) throw new Error(`O ${this.label} não confirmou o ID da sessão.`);
        c.threadId = result.sessionId; await this.persist();
      }
      return session;
    } catch (error) {
      await rpc.close();
      if (this.session === session) this.session = null;
      throw error;
    }
  }
  async send(id, text, requestId, settings = {}) {
    this.#ready();
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw new Error('Escreve um pedido com até 100 000 caracteres.');
    if (typeof requestId !== 'string' || !requestId || requestId.length > 100) throw new Error('Identificador do pedido inválido.');
    const c = this.conversation(id), shown = (settings.displayText ?? text).trim();
    const previous = c.messages.find(m => m.requestId === requestId);
    if (previous) { if (previous.text !== shown) throw new Error('Identificador já usado para outro texto.'); return { accepted: true, duplicate: true }; }
    if (this.submitting || this.conversations.some(c => active.has(c.status))) throw new Error('Já há uma tarefa em curso.');
    if (c.status === 'uncertain') throw new Error('O resultado anterior é incerto. Revê o projeto e continua noutro cliente ou cria uma conversa.');
    const selected = this.validateSettings(c, settings);
    this.submitting = true;
    const turn = { id: randomUUID(), requestId, ...selected, startedAt: now(), completedAt: null, status: 'starting', delivery: 'preparing', usage: null,
      interactions: [], ...(settings.internal ? { internal: settings.internal } : {}) };
    Object.assign(c, selected, { error: null, status: 'starting', turnId: turn.id, updatedAt: now(), diff: '' });
    if(settings.projectDelivery)turn.projectDelivery=settings.projectDelivery;
    c.turns.push(turn);
    if(settings.images?.length)turn.inputAttachments=imageRecords(settings.images);
    c.messages.push({ id: randomUUID(), requestId, turnId: turn.id, role: 'user', text: shown, at: now(), ...selected,
      ...(settings.internal ? { internal: settings.internal } : {}), ...(settings.handoffContext ? { handoffContext: settings.handoffContext } : {}) });
    if(messageImages(settings).length)c.messages.at(-1).attachments=imageRecords(messageImages(settings));
      if(settings.projectContext)c.messages.at(-1).projectContext=settings.projectContext;
      if(settings.contextImages?.length)c.messages.at(-1).contextImages=settings.contextImages;
    if (c.title === 'Nova conversa' && !settings.internal) c.title = shown.replace(/\s+/g, ' ').slice(0, 66);
    this.changed();
    let session;
    try {
      await this.persist();
      session = await this.#start(c, turn, settings.contextMcp);
      if(settings.images?.length && !session.supportsImages)throw new Error(`Este ${this.label} não anunciou suporte a imagens. Nada foi enviado.`);
      await this.#configure(session, selected);
      if (session.stopping || !active.has(turn.status)) return { accepted: true, interrupted: true };
      // Persist the ambiguity boundary before sending any prompt bytes. A crash never causes replay.
      turn.delivery = 'sending'; c.status = turn.status = 'running'; await this.persist();
      if (session.stopping || !active.has(turn.status)) return { accepted: true, interrupted: true };
      session.phase = 'prompt';
      session.rpc.call('session/prompt', { sessionId: c.threadId, prompt: [{ type: 'text', text: text.trim() },...imageContent(settings.images,'cursor')] }, 0)
        .then(result => {
          if (!active.has(turn.status)) return;
          this.adapter?.result?.(this,session,result);
          if (result?.stopReason === 'end_turn') this.#finish(session, 'completed');
          else if (result?.stopReason === 'cancelled') this.#finish(session, 'interrupted');
          else this.#finish(session, 'failed', `O ${this.label} terminou com ${clip(result?.stopReason || 'resultado inválido', 100)}.`);
        }).catch(error => { if (active.has(turn.status)) this.#finish(session, error.nativeResponse ? 'failed' : 'uncertain', error.message); });
      this.changed(); return { accepted: true };
    } catch (error) {
      if (turn.status === 'interrupted' && turn.cancelRequested) return { accepted: true, interrupted: true };
      if (active.has(turn.status)) this.#finish(session || { conversation: c, turn }, turn.delivery === 'sending' ? 'uncertain' : 'failed', session?.rpc.redact(error.message) || error.message);
      await session?.rpc.close(); await this.persist(); throw new Error(c.error || `Preparação do ${this.label} interrompida.`);
    } finally { this.submitting = false; }
  }
  #message(session, text, final = false) {
    const sanitized = session.rpc.streamText((session.publicTail || '') + text, final);
    session.publicTail = sanitized.tail; text = sanitized.visible;
    if (!text) return;
    const { conversation: c, turn } = session;
    let message = c.messages.findLast(m => m.role === 'assistant' && m.turnId === turn.id && m.streaming);
    if (!message) {
      message = { id: randomUUID(), role: 'assistant', turnId: turn.id, requestId: turn.requestId, model: turn.model, effort: turn.effort, phase: 'commentary', streaming: true, text: '', at: now(), ...(turn.internal ? { internal: turn.internal } : {}) };
      c.messages.push(message);
    }
    if (message.text.length + text.length > 1_000_000) throw new Error(`Resposta pública do ${this.label} demasiado grande.`);
    message.text += text;
  }
  #tool(session, update) {
    const { conversation: c, turn } = session;
    const id = `${turn.id}:${update.toolCallId}`;
    let item = c.items.find(i => i.id === id);
    if (!item) { item = { id, nativeId: update.toolCallId, type: 'mcpToolCall', server: this.label, tool: update.title || 'Ferramenta', turnId: turn.id, at: now(), status: 'inProgress' }; c.items.push(item); }
    if (update.kind) item.nativeKind = update.kind;
    if (update.title) item.tool = update.title;
    if (update.rawInput) item.parameters = update.rawInput;
    if (update.locations) item.locations = update.locations;
    const kind = item.nativeKind;
    if (kind === 'execute') { item.type = 'commandExecution'; item.command = clip(item.parameters?.command || item.tool); }
    else if (kind === 'edit' || kind === 'delete' || kind === 'move') {
      item.type = 'fileChange'; item.changes ||= [];
      // OpenCode may report write/edit paths only in rawInput, without ACP
      // locations or diff blocks. They count only after native completion below.
      const input=item.parameters||{};
      const paths=[...(item.locations||[]).map(l=>l.path),input.path,input.file_path,input.filePath,input.oldPath,input.newPath];
      for (const file of paths) if (typeof file==='string'&&file.length<=4096&&!file.includes('\0')&&!item.changes.some(change=>change.path===file)) item.changes.push({path:file,diff:''});
    } else if (['search', 'fetch'].includes(kind)) { item.type = 'webSearch'; item.query = item.tool; }
    if (update.content) {
      const output = update.content.map(block => block.type === 'content' && block.content?.type === 'text' ? block.content.text : block.type === 'text' ? block.text : '').filter(Boolean).join('\n');
      item.aggregatedOutput = clip(output);
      const diffs = update.content.filter(block => block.type === 'diff' && typeof block.path === 'string');
      if (item.type === 'fileChange') for (const block of diffs) {
        const change = item.changes.find(change => change.path === block.path);
        if (change) change.diff = clip(block.newText || '');
        else item.changes.push({ path: block.path, diff: clip(block.newText || '') });
      }
    }
    if (update.status) item.status = ({ pending: 'inProgress', in_progress: 'inProgress', completed: 'completed', failed: 'failed' })[update.status] || 'inProgress';
    if (item.denied || turn.deniedToolCalls?.includes(update.toolCallId)) { item.denied = true; item.permissionDenied = true; item.status = 'declined'; }
    if (Number.isInteger(update.rawOutput?.exitCode)) item.exitCode = update.rawOutput.exitCode;
    if (item.status === 'completed' && item.exitCode) item.status = 'failed';
    observeAction(c, turn, item);
    if (c.items.length > 200) c.items.splice(0, c.items.length - 200);
  }
  #notification(session, message) {
    const { conversation: c, turn } = session;
    if (message.params?.sessionId && c.threadId && message.params.sessionId !== c.threadId) throw new Error(`O ${this.label} respondeu noutra sessão. Nada será reenviado.`);
    if (session.phase !== 'prompt' || !active.has(turn.status)) return; // session/load replays history; never count it twice.
    if (message.method === 'session/update') {
      const update = message.params?.update || {};
      this.adapter?.notification?.(this,session,update);
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') this.#message(session, update.content.text);
      else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') this.#tool(session, update);
      else if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) turn.plan = { steps: update.entries.map(e => ({ step: e.content, status: ({ pending: 'pending', in_progress: 'inProgress', completed: 'completed' })[e.status] || 'pending' })) };
      else if (update.sessionUpdate === 'agent_thought_chunk' && !c.items.some(i => i.id === `${turn.id}:thinking`)) c.items.push({ id: `${turn.id}:thinking`, turnId: turn.id, type: 'reasoning', status: 'inProgress', at: now() });
    } else if (message.method === 'cursor/update_todos' && Array.isArray(message.params?.todos)) turn.plan = { steps: message.params.todos.map(e => ({ step: e.content, status: ({ in_progress: 'inProgress', completed: 'completed' })[e.status] || 'pending' })) };
    if (c.items.length > 200) c.items.splice(0, c.items.length - 200);
    this.changed();
  }
  #request(session, message) {
    const { rpc, conversation: c, turn } = session;
    const method = message.method;
    if (session.phase !== 'prompt' || !active.has(turn.status) || session.stopping) {
      rpc.reply(message.id, undefined, { code: -32601, message: 'Sem pedido ativo no HYDRAQ.' }).catch(() => {}); return;
    }
    if (!['session/request_permission', 'cursor/ask_question', 'cursor/create_plan', ...(this.adapter ? ['elicitation/create'] : [])].includes(method)) {
      rpc.reply(message.id, undefined, { code: -32601, message: 'O HYDRAQ não suporta este método ACP; nenhuma ação foi autorizada.' }).catch(() => {}); return;
    }
    const params = message.params || {};
    if (params.sessionId && params.sessionId !== c.threadId) throw new Error(`Pedido ${this.label} recebido para outra sessão.`);
    const questions = params.questions;
    const invalidQuestion = method === 'cursor/ask_question' && (!Array.isArray(questions) || !questions.length || questions.length > 50 || questions.some(q => typeof q.id !== 'string' || !Array.isArray(q.options) || !q.options.length || q.options.some(o => typeof o.id !== 'string')));
    const invalidPermission = method === 'session/request_permission' && (!Array.isArray(params.options) || !params.options.length || params.options.some(o => typeof o.optionId !== 'string'));
    const invalidForm=method==='elicitation/create'&&(params.mode!=='form'||!params.requestedSchema||params.requestedSchema.type!=='object'||JSON.stringify(params.requestedSchema).length>16000);
    if (invalidForm || invalidQuestion || invalidPermission || (method === 'cursor/create_plan' && typeof params.plan !== 'string')) {
      rpc.reply(message.id, method==='elicitation/create'?{action:'cancel'}:{ outcome: { outcome: 'cancelled' } }).catch(() => {});
      c.items.push({ id: randomUUID(), turnId: turn.id, type: 'mcpToolCall', tool: method, server: this.label, status: 'declined', summary: 'Pedido nativo com formato não suportado; cancelado sem autorização.', at: now() }); this.changed(); return;
    }
    const id = randomUUID();
    const interaction = { id, method, status: 'pending', at: now() }; turn.interactions.push(interaction);
    this.approvals.set(id, { id, method, conversationId: c.id, nativeId: message.id, session, interaction, params: { ...params, turnId: turn.id } });
    c.status = turn.status = 'waiting'; this.changed();
  }
  #expire(session) {
    for (const [id, request] of this.approvals) if (request.session === session) { request.interaction.status = 'expired'; this.approvals.delete(id); }
  }
  #finish(session, status, error = null) {
    const { conversation: c, turn } = session;
    if (!turn || !active.has(turn.status)) return;
    if (session.rpc && session.publicTail) this.#message(session, '', true);
    turn.status = c.status = status; turn.completedAt = now(); turn.delivery = status === 'completed' ? 'confirmed' : turn.delivery;
    c.error = error ? session.rpc?.redact(error) || error : null; c.turnId = null; c.updatedAt = now();
    for (const message of c.messages) if (message.turnId === turn.id) message.streaming = false;
    if (status === 'completed') {
      turn.finalAnswer = c.messages.filter(m => m.role === 'assistant' && m.turnId === turn.id).map(m => m.text).join('\n\n');
      const last = c.messages.findLast(m => m.role === 'assistant' && m.turnId === turn.id); if (last) last.phase = 'final_answer';
    }
    for (const item of c.items) if (item.turnId === turn.id && item.status === 'inProgress') {
      item.status = item.type === 'reasoning' && status === 'completed' ? 'completed' : 'interrupted'; observeAction(c, turn, item);
    }
    this.#expire(session); session.phase = 'idle'; clearTimeout(session.stopTimer); this.changed();
    this.persist().catch(() => {});
  }
  async respond(id, body) {
    const request = this.approvals.get(String(id));
    if (!request || request.resolving) throw new Error('Este pedido já foi resolvido ou deixou de estar ativo.');
    const { session, nativeId, interaction, params, method } = request;
    if (session !== this.session || !active.has(session.turn.status) || params.turnId !== session.turn.id) throw new Error('Este pedido pertence a um turno que já terminou.');
    let result;
    if(method==='elicitation/create')result=this.adapter.formResult(params,body);
    else if (body.decision === 'cancel') result = { outcome: { outcome: 'cancelled' } };
    else if (method === 'session/request_permission') {
      const option = params.options.find(o => o.optionId === body.optionId);
      if (!option) throw new Error(`Escolhe uma das autorizações anunciadas pelo ${this.label}.`);
      result = { outcome: { outcome: 'selected', optionId: option.optionId } };
    } else if (method === 'cursor/create_plan') {
      if (!['accept', 'decline'].includes(body.decision)) throw new Error('Escolhe aceitar ou rejeitar o plano.');
      result = { outcome: { outcome: body.decision === 'accept' ? 'accepted' : 'rejected', ...(body.decision === 'decline' ? { reason: 'Plano rejeitado no HYDRAQ.' } : {}) } };
    } else {
      if (!Array.isArray(body.answers) || body.answers.length !== params.questions.length) throw new Error(`Responde a todas as perguntas do ${this.label}.`);
      const answers = params.questions.map(question => {
        const answer = body.answers.find(a => a.questionId === question.id);
        const ids = answer?.selectedOptionIds;
        if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || (!question.allowMultiple && ids.length !== 1) || ids.some(id => !question.options.some(o => o.id === id))) throw new Error('Escolhe as opções válidas de cada pergunta.');
        return { questionId: question.id, selectedOptionIds: ids };
      });
      result = { outcome: { outcome: 'answered', answers } };
    }
    request.resolving = true; interaction.status = 'responding';
    try { await this.persist(); } catch (error) { request.resolving = false; interaction.status = 'pending'; throw error; }
    // Consume once before the write; an ambiguous response is never replayed.
    this.approvals.delete(request.id);
    if (session.stopping || !active.has(session.turn.status) || params.turnId !== session.turn.id) result = method==='elicitation/create'?{action:'cancel'}:{ outcome: { outcome: 'cancelled' } };
    try {
      await session.rpc.reply(nativeId, result); interaction.status = 'answered'; interaction.outcome = result.outcome || {action:result.action,...(result.content?{content:result.content}:{})};
      if (method === 'session/request_permission' && (body.decision === 'cancel' || params.options.find(o => o.optionId === body.optionId)?.kind?.startsWith('reject'))) {
        const denied = session.turn.deniedToolCalls ||= [];
        if (params.toolCall?.toolCallId && !denied.includes(params.toolCall.toolCallId)) denied.push(params.toolCall.toolCallId);
        const item = session.conversation.items.find(i => i.nativeId === params.toolCall?.toolCallId && i.turnId === session.turn.id);
        if (item) { item.denied = true; item.permissionDenied = true; item.status = 'declined'; observeAction(session.conversation, session.turn, item); }
      }
      if (![...this.approvals.values()].some(r => r.session === session) && session.conversation.status === 'waiting') session.conversation.status = session.turn.status = 'running';
      this.changed();
      if (body.decision === 'cancel' && active.has(session.conversation.status)) await this.interrupt(session.conversation.id);
      return { sent: true };
    } catch (error) { interaction.status = 'uncertain'; this.#finish(session, 'uncertain', `A resposta ao ${this.label} não ficou confirmada. Nada foi reenviado.`); await session.rpc.close(); throw new Error(`Sem confirmação da resposta ao ${this.label}.`); }
  }
  async interrupt(id) {
    const c = this.conversation(id), session = this.session;
    if (!active.has(c.status)) throw new Error(`Não há tarefa do ${this.label} para interromper.`);
    const turn = c.turns.at(-1);
    if (turn?.delivery === 'preparing' || (session?.turn === turn && session.phase === 'preparing')) {
      turn.cancelRequested = true;
      if (session?.turn === turn) { session.stopping = true; this.#finish(session, 'interrupted'); await session.rpc.close(); }
      else this.#finish({ conversation: c, turn }, 'interrupted');
      await this.persist(); return { requested: true };
    }
    if (!session || session.conversation !== c) {
      const turn = c.turns.at(-1); this.#finish({ conversation: c, turn }, 'interrupted'); return { requested: true };
    }
    session.stopping = true;
    for (const [key, request] of [...this.approvals]) if (request.session === session && !request.resolving) {
      this.approvals.delete(key); request.interaction.status = 'cancelled';
      await session.rpc.reply(request.nativeId, request.method==='elicitation/create'?{action:'cancel'}:{ outcome: { outcome: 'cancelled' } }).catch(() => {});
    }
    if (session.phase !== 'prompt') { this.#finish(session, 'interrupted'); await session.rpc.close(); return { requested: true }; }
    try { await session.rpc.notify('session/cancel', { sessionId: c.threadId }); }
    catch { this.#finish(session, 'uncertain', `A paragem do ${this.label} não ficou confirmada. Nada foi reenviado.`); await session.rpc.close(); }
    if (active.has(c.status)) session.stopTimer = setTimeout(() => { session.rpc.fail(`O ${this.label} não confirmou a paragem. Revê o resultado antes de continuar.`); }, 8000);
    return { requested: true };
  }
  async steer() { throw new Error(`O ${this.label} ACP não anuncia orientação do turno ativo. Aguarda ou interrompe o pedido.`); }
  async close() {
    this.closing = true;
    await Promise.all([...this.processes].map(rpc => rpc.close()));
    clearTimeout(this.changeTimer); clearTimeout(this.saveTimer); await this.persist();
  }
}
