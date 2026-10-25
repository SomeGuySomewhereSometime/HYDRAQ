import { writeHistory } from './state-store.mjs';
import { imageContent, imageRecords, messageImages } from './attachments.mjs';
import { withoutCursorCredentials } from './cursor-auth.mjs';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { attachTerminalContextReads } from './terminal-context-reads.mjs';
import { mkdir, readFile, realpath, stat, access, lstat, readdir } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { summarizeProgress } from './progress.mjs';
import { observeAction } from './turn-facts.mjs';
import { SESSION_ID, MAX_TRANSCRIPT, claudeHome, projectDirectory, parseLines, activeChain, transcriptTurns } from './claude-transcript.mjs';

const active = new Set(['starting', 'running', 'waiting']);
const now = () => new Date().toISOString();
const limit = (value, size = 60_000) => String(value ?? '').slice(-size);
const effortsOrder = ['low', 'medium', 'high', 'xhigh', 'max'];
const modes = { 'workspace-write': 'default', 'accept-edits': 'acceptEdits', plan: 'plan' };
const fileTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const webTools = new Set(['WebSearch', 'WebFetch']);
// The last group identifies an enclosing Claude session; a child would inherit its identity and
// messaging token, and a TUI started with them does not save its turns.
const removedEnv = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_EFFORT'];
const denial = /requested permissions|haven't granted|doesn't want to proceed|was rejected|recusad/i;

/** Claude's clarifying questions (1–4, each with options); anything else is refused, not guessed. */
function askedQuestions(input) {
  const questions = input?.questions;
  if (!Array.isArray(questions) || !questions.length || questions.length > 4) return null;
  const parsed = questions.map(q => {
    if (!q || typeof q.question !== 'string' || !q.question.trim() || q.question.length > 2000 || !Array.isArray(q.options) || !q.options.length || q.options.length > 6) return null;
    const options = q.options.map(o => o && typeof o.label === 'string' && o.label.trim() && o.label.length <= 300 ? { label: o.label, description: typeof o.description === 'string' ? o.description.slice(0, 1000) : '' } : null);
    if (options.includes(null)) return null;
    return { question: q.question, header: typeof q.header === 'string' ? q.header.slice(0, 60) : '', multiSelect: q.multiSelect === true, options };
  });
  return parsed.includes(null) || new Set(parsed.map(q => q.question)).size !== parsed.length ? null : parsed;
}

/** Answers keyed by question text: an option label, several labels joined, or the person's own text. */
function answeredQuestions(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('Responde às perguntas ou escolhe «Não responder».');
  return Object.fromEntries(questions.map(q => {
    const raw = answers[q.question];
    const values = (Array.isArray(raw) ? raw : [raw]).map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean);
    if (!values.length) throw new Error(`Responde a «${q.question.slice(0, 80)}» ou escolhe «Não responder».`);
    if (values.length > 1 && !q.multiSelect) throw new Error('Esta pergunta aceita só uma resposta.');
    const value = values.join(', ');
    if (value.length > 5000) throw new Error('Resposta demasiado longa (máximo 5000 caracteres).');
    return [q.question, value];
  }));
}

/** Native catalog from the `initialize` control response; aliases resolve to the account's current models. */
export function parseClaudeModels(models) {
  if (!Array.isArray(models)) throw new Error('O Claude Code não devolveu o catálogo de modelos.');
  const preferred = models.find(model => model.value === 'default')?.resolvedModel;
  const parsed = models.filter(model => typeof model?.value === 'string' && model.value !== 'default').map(model => {
    const efforts = (model.supportsEffort && Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels : []).filter(effort => effortsOrder.includes(effort)).sort((a, b) => effortsOrder.indexOf(a) - effortsOrder.indexOf(b));
    return {
      id: model.value, name: model.displayName || model.value, resolvedModel: model.resolvedModel || model.value,
      description: `${model.description || 'Claude Code original'} · sessão claude.ai`,
      efforts: efforts.length ? efforts : ['medium'], defaultEffort: efforts.includes('high') ? 'high' : (efforts.at(-1) || 'medium'),
      isDefault: Boolean(preferred && model.resolvedModel === preferred), supportsReasoningEffortUpdates: null,
    };
  });
  if (!parsed.length) throw new Error('O catálogo do Claude Code está vazio. Confirma a sessão no CLI original.');
  if (!parsed.some(model => model.isDefault)) parsed[0].isDefault = true;
  return parsed;
}

/** One request's usage, already scoped to the turn by the CLI; cache counters map onto the Codex view. */
export function claudeTurnUsage(usage) {
  const keys = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'];
  if (!usage || !['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
    || !keys.every(key => Number.isSafeInteger(usage[key] ?? 0) && (usage[key] ?? 0) >= 0)) return null;
  const [fresh, read, write, output] = keys.map(key => usage[key] ?? 0);
  const inputTokens = fresh + read + write;
  const reasoning = usage.output_tokens_details?.thinking_tokens ?? 0;
  return {
    inputTokens, cachedInputTokens: read, cacheWriteInputTokens: write, uncachedInputTokens: fresh + write,
    outputTokens: output, reasoningOutputTokens: Number.isSafeInteger(reasoning) ? reasoning : 0, totalTokens: inputTokens + output,
    cachePercent: inputTokens ? Math.round(read / inputTokens * 100) : 0,
  };
}

function toolText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(block => block?.type === 'text' ? block.text : '').filter(Boolean).join('\n');
  return '';
}

function classifyTool(block, item) {
  const input = block.input || {};
  Object.assign(item, { tool: block.name, server: 'Claude Code', parameters: input });
  if (block.name === 'Bash') { item.type = 'commandExecution'; item.command = input.command || 'Bash'; }
  else if (fileTools.has(block.name)) { item.type = 'fileChange'; item.changes = [{ path: String(input.file_path || input.notebook_path || block.name), diff: limit(input.new_string ?? input.content ?? '', 20_000) }]; }
  else if (webTools.has(block.name)) { item.type = 'webSearch'; item.query = input.query || input.url || block.name; }
  else if (block.name === 'Task' || block.name === 'Agent') { item.type = 'subagent'; item.detail = input.description || input.subagent_type || 'Subagente'; }
  else if (block.name === 'AskUserQuestion') { item.type = 'mcpToolCall'; item.summary = 'Perguntas ao utilizador'; }
  else { item.type = 'mcpToolCall'; const target = input.file_path || input.path || input.pattern || ''; if (target) item.summary = String(target); }
}

/** Original Claude Code process (`claude -p`) over its stream-json control protocol; no retries or fallback models. */
export class ClaudeCode extends EventEmitter {
  constructor({ dataDir, defaultCwd, executable = process.env.HYDRAQ_CLAUDE_BIN || 'claude', prefixArgs = [], env = process.env, readOnly = false, questions = false }) {
    super();
    Object.assign(this, { dataDir, defaultCwd, executable, prefixArgs, readOnly, questions });
    this.env = withoutCursorCredentials(env);
    for (const key of removedEnv) delete this.env[key];
    this.conversations = [];
    this.models = [];
    this.connection = 'disconnected';
    this.connectionError = null;
    this.account = null;
    this.approvals = new Map();
    this.saveChain = Promise.resolve();
    this.session = null;
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(path.join(this.dataDir, 'state.json'), 'utf8'));
      if (!Array.isArray(saved.conversations)) throw new Error('Histórico inválido.');
      this.conversations = saved.conversations;
      for (const conversation of this.conversations) if (active.has(conversation.status)) {
        conversation.status = 'uncertain';
        conversation.turnId = null;
        conversation.error = 'O HYDRAQ terminou sem confirmar o resultado. O pedido não foi reenviado.';
        for (const turn of conversation.turns) if (active.has(turn.status)) turn.status = 'uncertain';
        for (const message of conversation.messages) {
          message.streaming = false;
          if(['steer','peer-notice'].includes(message.kind)&&['sending','preparing'].includes(message.delivery)){message.delivery='uncertain';message.error='O HYDRAQ reiniciou antes de confirmar a orientação. Nada foi reenviado.';}
        }
      }
      for(const c of this.conversations)for(const m of c.messages)if(['steer','peer-notice'].includes(m.kind)&&['sending','preparing'].includes(m.delivery)){m.delivery='uncertain';m.error='Reinício antes da confirmação da orientação. Nada foi reenviado.';}
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  snapshot() {
    return {
      connection: this.connection, connectionError: this.connectionError, account: this.account,
      models: this.models.map(({ resolvedModel, ...model }) => model), defaultCwd: this.defaultCwd,
      capabilities: { steer: !this.readOnly, nativeApprovals: true, images:true },
      conversations: this.conversations.map(c => ({ ...c, progress: summarizeProgress(c) })),
      approvals: [...this.approvals.values()].map(({ session, ...request }) => request),
    };
  }

  changed() {
    this.historyRevision=(this.historyRevision||0)+1;
    if (!this.changeTimer) this.changeTimer = setTimeout(() => { this.changeTimer = null; this.emit('state', this.snapshot()); }, 75);
    if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = null; this.persist().catch(error => { this.connectionError = `Não foi possível guardar o histórico: ${error.message}`; this.emit('state', this.snapshot()); }); }, 600);
  }

  persist() {
    const contents = JSON.stringify({ version: 1, conversations: this.conversations }, null, 2);
    this.saveChain = this.saveChain.catch(() => {}).then(async () => {
      await writeHistory(this.dataDir, contents);
    });
    return this.saveChain;
  }

  /** `initialize` alone sends no prompt: it returns the account and the catalog without inference. */
  readOnlyArgs() {
    return this.readOnly ? ['--restricted', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read', 'Glob', 'Grep', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'] : [];
  }
  /** Other local Claude sessions could otherwise message this process and start a turn HYDRAQ never sent. */
  settingsArgs(claudex=false) {
    return ['--settings', JSON.stringify({ ...((this.readOnly||claudex) ? { disableAllHooks: true } : {}), crossSessionInbound: 'refuse' })];
  }
  async connect() {
    if (this.connection === 'connecting') throw new Error('A ligação ao Claude Code já está em curso.');
    this.connection = 'connecting'; this.connectionError = null; this.changed();
    try {
      const info = await new Promise((resolve, reject) => {
        const child = spawn(this.executable, [...this.prefixArgs, ...this.readOnlyArgs(), ...this.settingsArgs(), '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'], { cwd: this.defaultCwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
        this.catalogProcess = child;
        let buffer = '', stderr = '', done = false;
        const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); child.stdin.end(); setTimeout(() => this.#kill(child), 500).unref(); error ? reject(error) : resolve(value); };
        const timer = setTimeout(() => finish(new Error('O Claude Code não confirmou a sessão. Abre o CLI original e verifica o login.')), 30_000);
        child.stdin.on('error', () => {});
        child.stdout.on('data', data => {
          buffer += data;
          if (buffer.length > 4_000_000) return finish(new Error('Resposta do Claude Code demasiado grande.'));
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
            let event; try { event = JSON.parse(line); } catch { continue; }
            if (event.type === 'control_response' && event.response?.request_id === 'hydraq-init') {
              if (event.response.subtype !== 'success') return finish(new Error(event.response.error || 'O Claude Code recusou a inicialização.'));
              return finish(null, event.response.response);
            }
          }
        });
        child.stderr.on('data', data => { stderr = limit(stderr + data, 3000); });
        child.once('error', error => finish(new Error(`Não foi possível executar o Claude Code (claude): ${error.message}`)));
        child.once('close', code => { if (this.catalogProcess === child) this.catalogProcess = null; finish(new Error(stderr.trim() || `O claude terminou (${code}) antes de confirmar a sessão.`)); });
        child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'hydraq-init', request: { subtype: 'initialize' } }) + '\n');
      });
      const account = info?.account || {};
      if (account.apiProvider && account.apiProvider !== 'firstParty') throw new Error('Esta integração usa apenas a sessão claude.ai do Claude Code, sem Bedrock, Vertex ou outros fornecedores.');
      if (!account.subscriptionType) throw new Error('É necessária uma subscrição claude.ai no Claude Code original. Não são aceites chaves API. Abre o claude e inicia sessão.');
      this.models = parseClaudeModels(info.models);
      this.version = info.claude_code_version || null;
      this.account = { type: 'claude.ai', planType: account.subscriptionType };
      this.connection = 'connected';
    } catch (error) {
      this.connection = 'disconnected'; this.models = []; this.account = null; this.connectionError = error.message;
      this.changed(); throw error;
    }
    this.changed(); return this.snapshot();
  }

  conversation(id) { const c = this.conversations.find(c => c.id === id); if (!c) throw new Error('Conversa não encontrada.'); return c; }
  #ready() { if (this.connection !== 'connected') throw new Error('Liga primeiro o Claude Code. Se necessário, inicia sessão no claude original.'); }

  async create({ cwd, model, effort, sandbox = 'workspace-write' }) {
    this.#ready();
    const selected = this.models.find(m => m.id === model);
    if (!selected || (effort && !selected.efforts.includes(effort))) throw new Error('Escolhe modelo e raciocínio do catálogo do Claude Code.');
    if (!modes[sandbox]) throw new Error('No Claude Code escolhe autorizações na conversa, aceitação de edições ou planeamento nativo.');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Indica o caminho absoluto do projeto.');
    const folder = await realpath(cwd);
    if (!(await stat(folder)).isDirectory()) throw new Error('O projeto não é uma pasta.');
    // The native session ID is chosen here and only becomes resumable after the CLI confirms it.
    const c = { id: randomUUID(), provider: 'claude', threadId: randomUUID(), sessionStarted: false, turnId: null, title: 'Nova conversa', cwd: folder, model, effort: effort || selected.defaultEffort, sandbox, status: 'idle', createdAt: now(), updatedAt: now(), messages: [], items: [], turns: [], diff: '', error: null };
    this.conversations.unshift(c); await this.persist(); this.changed(); return c;
  }

  async send(id, text, requestId, settings = {}) {
    this.#ready();
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw new Error('Escreve um pedido com até 100 000 caracteres.');
    if (typeof requestId !== 'string' || !requestId || requestId.length > 100) throw new Error('Identificador do pedido inválido.');
    const c = this.conversation(id);
    if (c.terminal) throw new Error('Esta conversa está no Claude original (terminal). Usa «Continuar na HYDRAQ» antes de enviar daqui.');
    const shown = (settings.displayText ?? text).trim();
    const previous = c.messages.find(m => m.requestId === requestId);
    if (previous) { if (previous.text !== shown) throw new Error('Identificador já usado para outro texto.'); return { accepted: true, duplicate: true }; }
    if (this.submitting || this.conversations.some(c => active.has(c.status))) throw new Error('Já há uma tarefa em curso.');
    if (c.status === 'uncertain') throw new Error('O resultado anterior é incerto. Cria outra conversa para evitar repetição de trabalho.');
    const model = this.models.find(m => m.id === (settings.model ?? c.model));
    const effort = settings.effort ?? (model?.efforts.includes(c.effort) ? c.effort : model?.defaultEffort);
    if (!model?.efforts.includes(effort)) throw new Error('Combinação de modelo e raciocínio indisponível no Claude Code.');
    const sandbox = settings.sandbox ?? c.sandbox;
    if (!modes[sandbox]) throw new Error('Modo de acesso inválido no Claude Code.');
    this.submitting = true;
    try {
      // An approved plan leaves Claude Code's plan mode for the whole session; a new process restores the chosen mode.
      const retire = this.session && (this.session.contextMcpKey!==(settings.contextMcp?.file||null) || this.session.conversation !== c || this.session.model !== model.id || this.session.effort !== effort || c.sandbox !== sandbox || this.session.permissionMode !== modes[sandbox]);
      c.model = model.id; c.effort = effort; c.sandbox = sandbox; c.error = null; c.status = 'starting'; c.turnId = randomUUID(); c.updatedAt = now();
      const turn = { id: c.turnId, requestId, model: c.model, effort, sandbox, status: 'starting', delivery: 'preparing', startedAt: now(), completedAt: null, usage: null, ...(settings.internal ? { internal: settings.internal } : {}), ...(sandbox === 'plan' && settings.planOnly ? { planOnly: true } : {}) };
      if(settings.projectDelivery)turn.projectDelivery=settings.projectDelivery;
    c.turns.push(turn);
      if(settings.images?.length)turn.inputAttachments=imageRecords(settings.images);
      c.messages.push({ id: randomUUID(), requestId, role: 'user', text: shown, at: now(), model: c.model, effort, turnId: turn.id, ...(settings.internal ? { internal: settings.internal } : {}), ...(settings.handoffContext ? { handoffContext: settings.handoffContext } : {}) });
      if(messageImages(settings).length)c.messages.at(-1).attachments=imageRecords(messageImages(settings));
      if(settings.projectContext)c.messages.at(-1).projectContext=settings.projectContext;
      if(settings.contextImages?.length)c.messages.at(-1).contextImages=settings.contextImages;
      if (c.title === 'Nova conversa' && !settings.internal) c.title = shown.replace(/\s+/g, ' ').slice(0, 66);
      this.changed();
      try {
        if (retire) await this.#retire();
        if (turn.cancelRequested) return { accepted: true, interrupted: true };
        await this.persist();
        if (turn.cancelRequested) return { accepted: true, interrupted: true };
        if (!this.session) await this.#start(c, model, effort, settings.contextMcp);
        if (turn.cancelRequested) { await this.#retire(); return { accepted: true, interrupted: true }; }
        this.session.turn = turn;
        turn.delivery = 'sending';
        await this.#write(this.session, { type: 'user', uuid:turn.id, message: { role: 'user', content: settings.images?.length ? [{type:'text',text:text.trim()},...imageContent(settings.images,'claude')] : text.trim() } });
        if (c.status === 'starting') { c.status = 'running'; turn.status = 'running'; }
        this.changed(); return { accepted: true };
      } catch (error) {
        if (turn.cancelRequested && turn.delivery === 'preparing') return { accepted: true, interrupted: true };
        if (active.has(c.status)) { c.status = turn.delivery === 'sending' ? 'uncertain' : 'failed'; turn.status = c.status; c.turnId = null; }
        c.error = turn.delivery === 'sending' ? `Sem confirmação do Claude Code: ${error.message}. O pedido não foi reenviado.` : `Não foi possível preparar o Claude Code: ${error.message}`;
        if (turn.delivery === 'preparing') await this.#retire();
        this.changed(); await this.persist(); throw error;
      }
    } finally { this.submitting = false; }
  }

  #write(session, payload) {
    return new Promise((resolve, reject) => {
      const { child } = session;
      if (!child.stdin || child.stdin.destroyed || child.exitCode !== null) { reject(new Error(session.protocolError || limit(session.stderr, 2000) || 'O processo do claude terminou antes de receber o pedido.')); return; }
      child.stdin.write(JSON.stringify(payload) + '\n', error => error ? reject(error) : resolve());
    });
  }

  async #start(c, model, effort, contextMcp) {
    const args = [...this.prefixArgs, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages',
      '--model', model.id, '--effort', effort, '--permission-mode', modes[c.sandbox] || 'default', '--permission-prompt-tool', 'stdio', ...this.settingsArgs(c.turns.at(-1)?.internal==='claudex')];
    // Only the main client shows questions; reviewers and other unattended runs never get the tool.
    if (!this.questions || this.readOnly) args.push('--disallowedTools', 'AskUserQuestion');
    if(c.turns.at(-1)?.internal==='claudex')args.push('--tools','Read,Glob,Grep,WebSearch,WebFetch,AskUserQuestion','--strict-mcp-config');
    if(this.readOnly)args.push(...this.readOnlyArgs());
    else if(contextMcp)args.push('--mcp-config',JSON.stringify({mcpServers:{[contextMcp.name]:{command:contextMcp.command,args:contextMcp.args,env:contextMcp.env}}}),'--allowedTools',...contextMcp.names.map(name=>`mcp__${contextMcp.name}__${name}`));
    args.push(...(c.sessionStarted ? ['--resume', c.threadId] : ['--session-id', c.threadId]));
    // Claude Code reads CLAUDE.md, not AGENTS.md; point it at the project's instructions without creating files.
    const hasAgents = await access(path.join(c.cwd, 'AGENTS.md')).then(() => true, () => false);
    const hasClaude = await access(path.join(c.cwd, 'CLAUDE.md')).then(() => true, () => false);
    if (hasAgents && !hasClaude) args.push('--append-system-prompt', 'Este projeto tem instruções em AGENTS.md na raiz. Lê esse ficheiro antes de trabalhar e segue-o como instruções do projeto.');
    const child = spawn(this.executable, args, { cwd: c.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const session = { child, contextMcpKey:contextMcp?.file||null, conversation: c, model: model.id, resolvedModel: model.resolvedModel, effort, permissionMode: modes[c.sandbox] || 'default', claudexTools:contextMcp?.names.map(name=>`mcp__${contextMcp.name}__${name}`)||[], turn: null, buffer: '', stderr: '', decoder: new StringDecoder('utf8'), stopping: false, currentMessage: null };
    session.closed = new Promise(resolve => session.resolveClosed = resolve);
    this.session = session;
    child.stdin.on('error', () => {});
    const line = raw => {
      const text = raw.trim();
      if (!text) return;
      try { this.#event(session, JSON.parse(text)); }
      catch (error) { session.protocolError = error.message; this.#kill(child); }
    };
    child.stdout.on('data', data => {
      session.buffer += session.decoder.write(data);
      // A valid 20 MB image delivery can be echoed as about 28 MB of base64 JSON.
      if (session.buffer.length > 32_000_000) { session.protocolError = 'Evento do claude demasiado grande.'; this.#kill(child); return; }
      let newline;
      while ((newline = session.buffer.indexOf('\n')) >= 0 && !session.protocolError) { const raw = session.buffer.slice(0, newline); session.buffer = session.buffer.slice(newline + 1); line(raw); }
    });
    child.stderr.on('data', data => { session.stderr = limit(session.stderr + data, 6000); });
    child.once('error', error => { session.protocolError = `Não foi possível executar o claude: ${error.message}`; });
    child.once('close', (code, signal) => {
      session.rejectInit?.(new Error(session.protocolError || limit(session.stderr, 2000) || 'O Claude Code terminou antes de confirmar a preparação da sessão.'));
      if (!session.protocolError) for (const raw of (session.buffer + session.decoder.end()).split(/\r?\n/)) line(raw);
      session.buffer = '';
      for (const [key, request] of this.approvals) if (request.session === session) this.approvals.delete(key);
      if (session.turn && active.has(session.turn.status)) {
        const status = session.stopping ? 'interrupted' : 'uncertain';
        session.turn.status = status; session.turn.completedAt = now(); c.status = status; c.turnId = null;
        c.error = session.stopping ? null : (session.protocolError || limit(session.stderr, 2000) || `O claude terminou (${signal || code}) sem confirmar o resultado. O pedido não foi reenviado.`);
        for (const message of c.messages) if (message.turnId === session.turn.id) message.streaming = false;
        this.changed();
      }
      for(const message of c.messages)if(['steer','peer-notice'].includes(message.kind)&&message.turnId===session.turn?.id&&message.delivery==='sending'){message.delivery='uncertain';message.error='O Claude Code terminou sem confirmar a orientação.';this.changed();}
      clearTimeout(session.stopTimer);
      if (this.session === session) this.session = null;
      session.resolveClosed();
    });
    session.initRequestId = `init-${randomUUID()}`;
    session.initializing = true;
    const initialized = new Promise((resolve,reject)=>{session.resolveInit=resolve;session.rejectInit=reject;});
    initialized.catch(()=>{}); // A failed pipe write can finish before the close event rejects initialization.
    const timeout = setTimeout(()=>session.rejectInit(new Error('O Claude Code não confirmou a preparação da sessão.')),30000);
    try {
      await this.#write(session, { type: 'control_request', request_id: session.initRequestId, request: { subtype: 'initialize' } });
      const info = await initialized;
      if (!info?.account?.subscriptionType || (info.account.apiProvider && info.account.apiProvider !== 'firstParty')) throw new Error('A sessão preparada pelo Claude Code não confirmou uma subscrição claude.ai.');
    } finally { clearTimeout(timeout);session.initializing=false;session.rejectInit=null;session.resolveInit=null; }
  }

  #assistantMessage(session, apiId) {
    const c = session.conversation, turn = session.turn;
    const id = `${turn.id}:${apiId}`;
    let message = c.messages.find(m => m.id === id);
    if (!message) { message = { id, role: 'assistant', text: '', at: now(), turnId: turn.id, requestId: turn.requestId, model: c.model, effort: c.effort, phase: 'commentary', streaming: true, ...(turn.internal ? { internal: turn.internal } : {}) }; c.messages.push(message); }
    return message;
  }

  #event(session, event) {
    const c = session.conversation, turn = session.turn;
    if (event.session_id && event.session_id !== c.threadId) throw new Error('O Claude Code respondeu noutra sessão. Nenhum pedido será reenviado.');
    if (event.type === 'control_response') {
      if (event.response?.request_id === session.initRequestId && session.initializing) {
        if (event.response.subtype === 'success') session.resolveInit(event.response.response);
        else session.rejectInit(new Error(event.response.error || 'O Claude Code recusou a preparação da sessão.'));
      }
      return;
    }
    if (event.type === 'control_request') return this.#controlRequest(session, event);
    if(event.type==='system'&&event.subtype==='compact_boundary'){c.contextEpoch=(c.contextEpoch||0)+1;this.changed();return;}
    if (event.type === 'system' && event.subtype === 'init') {
      if (this.readOnly && turn) turn.reviewTools = Array.isArray(event.tools) ? event.tools : null;
      const expected = String(session.resolvedModel || '').replace(/\[.*\]$/, '');
      if (event.model && expected && !event.model.startsWith(expected) && event.model !== session.model) throw new Error('O Claude Code indicou um modelo diferente do solicitado.');
      c.sessionStarted = true;
      if (event.permissionMode) c.permissionMode = session.permissionMode = event.permissionMode;
      this.changed(); return;
    }
    if (event.type === 'rate_limit_event') {
      const info = event.rate_limit_info || {};
      c.rateLimit = { status: info.status, type: info.rateLimitType, resetsAt: info.resetsAt, usingOverage: Boolean(info.isUsingOverage) };
      this.changed(); return;
    }
    if (!turn || !active.has(turn.status)) return;
    if (event.type === 'stream_event') {
      const inner = event.event || {};
      if (event.parent_tool_use_id) return;
      if (inner.type === 'message_start') session.currentMessage = inner.message?.id || null;
      else if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && session.currentMessage) {
        const message = this.#assistantMessage(session, session.currentMessage);
        message.text += inner.delta.text || ''; message.streaming = true; this.changed();
      }
      return;
    }
    if (event.type === 'assistant') {
      const blocks = event.message?.content || [];
      const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('');
      if (text.trim() && !event.parent_tool_use_id) { const message = this.#assistantMessage(session, event.message.id); message.text = text; message.streaming = false; }
      for (const block of blocks.filter(block => block.type === 'tool_use')) {
        let item = c.items.find(entry => entry.id === block.id);
        if (!item) { item = { id: block.id, turnId: turn.id, at: now(), status: 'inProgress' }; c.items.push(item); if (c.items.length > 200) c.items.shift(); }
        classifyTool(block, item);
        if (event.parent_tool_use_id) item.parentToolUseId = event.parent_tool_use_id;
        observeAction(c, turn, item);
      }
      this.changed(); return;
    }
    if (event.type === 'user') {
      // The pipe write only confirms local delivery; the native echo confirms admission.
      if(!event.parent_tool_use_id){const steer=c.messages.find(m=>['steer','peer-notice'].includes(m.kind)&&m.nativeInputId===event.uuid&&m.turnId===turn.id);if(steer){steer.delivery='accepted';steer.receivedAt=now();this.changed();}}
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const block of content.filter(block => block.type === 'tool_result')) {
        const item = c.items.find(entry => entry.id === block.tool_use_id);
        if (!item) continue;
        const output = toolText(block.content);
        const denied = item.denied || /requested permissions|haven't granted|recusad/i.test(output);
        item.status = block.is_error && !item.planKept ? (denied ? 'declined' : 'failed') : 'completed';
        item.permissionDenied = Boolean(block.is_error && denied);
        item.aggregatedOutput = limit(output);
        item.completedAt = now();
        observeAction(c, turn, item);
      }
      this.changed(); return;
    }
    if (event.type === 'system' && event.subtype === 'permission_denied') {
      const item = c.items.find(entry => entry.id === event.tool_use_id);
      if (item) { item.denied = true; item.permissionDenied = true; observeAction(c, turn, item); }
      this.changed(); return;
    }
    if (event.type === 'result') {
      const steers=c.messages.filter(m=>['steer','peer-notice'].includes(m.kind)&&m.turnId===turn.id&&['sending','accepted','uncertain'].includes(m.delivery));
      const uuids=event.user_message_uuids||(event.user_message_uuid?[event.user_message_uuid]:[]);
      for(const steer of steers)if(uuids.includes(steer.nativeInputId)){steer.delivery='accepted';steer.answered=true;steer.receivedAt||=now();}
      const usage=claudeTurnUsage(event.usage);
      if(!usage)turn.usagePartial=true;
      if(usage){
        turn.cycleUsage ||= [];
        turn.cycleUsage.push(usage);
        const keys=['inputTokens','cachedInputTokens','cacheWriteInputTokens','uncachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];
        turn.usage=Object.fromEntries(keys.map(k=>[k,turn.cycleUsage.reduce((sum,u)=>sum+(u[k]||0),0)]));
        turn.usage.cachePercent=turn.usage.inputTokens?Math.round(turn.usage.cachedInputTokens/turn.usage.inputTokens*100):0;
        const total=c.sessionUsage||{inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0};
        for(const key of Object.keys(total))total[key]+=usage[key]||0;
        c.sessionUsage=total;
      }
      // priority:'now' can finish one generation and start another. That intermediate
      // result belongs to the same HYDRAQ task until every injected uuid is answered.
      if(steers.some(m=>!m.answered)&&!session.stopping){
        turn.nativeCycles=(turn.nativeCycles||0)+1;
        if(!uuids.length){turn.protocolWarning='Resultado sem identificadores da orientação; conclusão por confirmar.';}
        this.changed();return;
      }
      const interrupted = session.stopping || /^aborted/.test(event.terminal_reason || '');
      const status = event.subtype === 'success' && !event.is_error ? 'completed' : interrupted ? 'interrupted' : 'failed';
      if (status === 'completed' && typeof event.result !== 'string') throw new Error('Resposta nativa inválida; conclusão não confirmada.');
      turn.status = status; turn.completedAt = now(); c.status = status; c.turnId = null; c.updatedAt = now();
      session.stopping = false; clearTimeout(session.stopTimer);
      c.error = status === 'failed' ? (limit(event.result || (event.errors || []).join('\n') || 'O Claude Code terminou sem confirmar a conclusão.', 4000)) : null;
      for (const message of c.messages) if (message.turnId === turn.id) message.streaming = false;
      c.messages = c.messages.filter(message => message.turnId !== turn.id || message.role !== 'assistant' || message.text.trim());
      if (status === 'completed' && event.result.trim()) {
        const last = c.messages.findLast(m => m.turnId === turn.id && m.role === 'assistant');
        if (last && last.text.trim() === event.result.trim()) last.phase = 'final_answer';
        else c.messages.push({ id: `${turn.id}:final`, role: 'assistant', text: event.result, at: now(), turnId: turn.id, requestId: turn.requestId, model: c.model, effort: c.effort, phase: 'final_answer', ...(turn.internal ? { internal: turn.internal } : {}) });
      }
      turn.usageUnavailable = turn.usage ? (turn.usagePartial?'Contadores parciais: o Claude não comunicou o consumo de todos os ciclos.':null) : 'O Claude Code não comunicou contadores válidos para este pedido.';
      for(const steer of steers)if(!steer.answered){steer.delivery='uncertain';steer.error='O turno terminou sem confirmar o processamento desta orientação.';}
      for (const item of c.items) if (item.turnId === turn.id && item.status === 'inProgress' && status !== 'completed') { item.status = 'interrupted'; observeAction(c, turn, item); }
      for (const [key, request] of this.approvals) if (request.conversationId === c.id) this.approvals.delete(key);
      this.changed();
    }
  }

  #controlRequest(session, event) {
    const request = event.request || {};
    const c = session.conversation, turn = session.turn;
    if (request.subtype !== 'can_use_tool' || !turn || !active.has(turn.status)) {
      this.#write(session, { type: 'control_response', response: { subtype: 'error', request_id: event.request_id, error: `O HYDRAQ não suporta este pedido: ${request.subtype}. Nenhuma autorização foi concedida.` } }).catch(() => {});
      return;
    }
    if(turn.internal==='claudex'&&session.claudexTools.includes(request.tool_name)){
      this.#write(session,{type:'control_response',response:{subtype:'success',request_id:event.request_id,response:{behavior:'allow',updatedInput:request.input}}}).catch(()=>{});return;
    }
    if ((turn.internal==='claudex'&&!['Read','Glob','Grep','WebSearch','WebFetch','AskUserQuestion',...session.claudexTools].includes(request.tool_name)) || (this.readOnly && !['Read', 'Glob', 'Grep'].includes(request.tool_name))) {
      const item = c.items.find(i => i.id === request.tool_use_id);
      if (item) { item.denied = true; item.permissionDenied = true; item.status = 'declined'; observeAction(c, turn, item); }
      this.#write(session, { type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: { behavior: 'deny', message: turn.internal==='claudex'?'ClaudeX só permite leitura, pesquisa e comunicação da tarefa. Ação recusada.':'Este revisor só pode ler ficheiros, pesquisar texto e procurar caminhos. Ação recusada pelo HYDRAQ.' } } }).catch(() => {});
      this.changed();
      return;
    }
    if (request.tool_name === 'ExitPlanMode' && turn.planOnly) {
      // A dual request stays in Planear: leaving plan mode is refused without asking, and the plan becomes the answer.
      const item = c.items.find(i => i.id === request.tool_use_id);
      if (item) item.planKept = true;
      this.#write(session, { type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: { behavior: 'deny', message: 'Plano registado. Esta conversa dual continua em Planear: não alteres ficheiros nem saias do modo de planeamento. Escreve o plano completo na resposta final, porque é essa resposta que o utilizador e o outro modelo leem. A implementação, se o utilizador a quiser, segue num pedido próprio ao principal.' } } }).catch(() => {});
      this.changed();
      return;
    }
    if (request.tool_name === 'AskUserQuestion') {
      const questions = this.questions && askedQuestions(request.input);
      if (!questions) {
        this.#write(session, { type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: { behavior: 'deny', message: 'O HYDRAQ não conseguiu apresentar estas perguntas. Continua sem resposta e indica na resposta final o que precisas de saber.' } } }).catch(() => {});
        return;
      }
      this.approvals.set(event.request_id, { id: event.request_id, method: 'claude/askUserQuestion', conversationId: c.id, session, params: { turnId: turn.id, toolUseId: request.tool_use_id, questions, input: request.input } });
      c.status = 'waiting'; turn.status = 'waiting';
      this.changed();
      return;
    }
    this.approvals.set(event.request_id, {
      id: event.request_id, method: 'claude/canUseTool', conversationId: c.id, session,
      params: { turnId: turn.id, toolName: request.tool_name, displayName: request.display_name || request.tool_name, description: request.description || '', input: request.input || {}, toolUseId: request.tool_use_id, blockedPath: request.blocked_path || null },
    });
    c.status = 'waiting'; turn.status = 'waiting';
    this.changed();
  }

  respond(requestId, body) {
    const request = this.approvals.get(String(requestId));
    if (!request) throw new Error('Este pedido já foi resolvido ou deixou de estar ativo.');
    if (!['accept', 'decline', 'cancel'].includes(body.decision)) throw new Error('Decisão inválida.');
    const session = request.session, question = request.method === 'claude/askUserQuestion';
    const response = body.decision === 'accept'
      ? { behavior: 'allow', updatedInput: question ? { ...request.params.input, answers: answeredQuestions(request.params.questions, body.answers) } : request.params.input }
      : { behavior: 'deny', message: body.decision === 'cancel' ? 'O utilizador parou a tarefa.' : question ? 'O utilizador preferiu não responder a estas perguntas no HYDRAQ.' : 'O utilizador recusou esta ação no HYDRAQ.', interrupt: body.decision === 'cancel' };
    this.#write(session, { type: 'control_response', response: { subtype: 'success', request_id: request.id, response } }).catch(() => {});
    // Claude Code leaves plan mode once its plan is approved; the next request with Planear starts a new process.
    if (body.decision === 'accept' && request.params.toolName === 'ExitPlanMode') session.permissionMode = 'default';
    this.approvals.delete(request.id);
    const c = this.conversation(request.conversationId);
    if (body.decision !== 'accept') { const item = c.items.find(i => i.id === request.params.toolUseId); if (item) { item.denied = true; observeAction(c, session.turn, item); } }
    if (![...this.approvals.values()].some(entry => entry.conversationId === c.id) && c.status === 'waiting') {
      c.status = 'running';
      const turn = c.turns.find(entry => entry.id === request.params.turnId);
      if (turn?.status === 'waiting') turn.status = 'running';
    }
    if (body.decision === 'cancel') { session.stopping = true; session.stopTimer = setTimeout(() => this.#kill(session.child, 'SIGKILL'), 8000); }
    this.changed();
    return { sent: true };
  }

  /** The session's native transcript; the launch folder normally names its directory. */
  async transcriptPath(sessionId, cwd) {
    if (!SESSION_ID.test(String(sessionId))) throw new Error('Identificador de sessão Claude inválido.');
    const name = `${sessionId}.jsonl`, root = path.join(claudeHome(this.env), 'projects');
    const candidates = [path.join(projectDirectory(this.env, cwd), name), ...(await readdir(root).catch(() => [])).map(folder => path.join(root, folder, name))];
    for (const file of new Set(candidates)) {
      const info = await lstat(file).catch(error => { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; });
      if (!info) continue;
      if (!info.isFile()) throw new Error('A transcrição nativa do Claude não é um ficheiro normal.');
      if (info.size > MAX_TRANSCRIPT) throw new Error('A transcrição nativa excede 256 MB. Continua essa sessão no Claude original.');
      return file;
    }
    return null;
  }

  async transcript(sessionId, cwd) {
    const file = await this.transcriptPath(sessionId, cwd);
    return file ? { file, ...parseLines(await readFile(file, 'utf8')) } : null;
  }

  /** Open sessions as the CLI lists them (interactive, background and other local clients). */
  async liveSessions() {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(this.executable, [...this.prefixArgs, 'agents', '--json'], { cwd: this.defaultCwd, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('O Claude Code não listou as sessões abertas a tempo.')); }, 15_000);
      child.stdout.on('data', data => { out += data; if (out.length > 4_000_000) child.kill('SIGKILL'); });
      child.stderr.on('data', data => { err = limit(err + data, 2000); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(err.trim() || `claude agents terminou (${code}).`)); });
    });
    const sessions = JSON.parse(output);
    if (!Array.isArray(sessions)) throw new Error('O Claude Code devolveu uma lista de sessões inválida.');
    return sessions.filter(session => session && typeof session.sessionId === 'string' && Number.isInteger(session.pid));
  }

  /** A live owner keeps HYDRAQ from writing to the session. Both checks only read. Without the CLI's
   * listing the answer is unknown (a session picked inside the TUI has no ID in its arguments), so
   * this fails closed unless the person confirms the original client is closed (`unverified`). */
  async sessionOpen(sessionId, { unverified = false } = {}) {
    let failure = null;
    try { const listed = (await this.liveSessions()).find(session => session.sessionId === sessionId); if (listed) return { pid: listed.pid, kind: listed.kind || 'interactive' }; }
    catch (error) { failure = error; }
    if (process.platform === 'linux') for (const pid of await readdir('/proc').catch(() => [])) {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0');
      if (argv.includes(sessionId) && (path.basename(argv[0]) === 'claude' || argv[0] === this.executable || argv[0].includes('/claude/versions/'))) return { pid: Number(pid), kind: 'process' };
    }
    if (failure && !unverified) throw Object.assign(new Error(`Não foi possível confirmar que nenhum Claude tem esta sessão aberta (${limit(failure.message, 300)}). Confirma que fechaste o Claude original antes de continuar.`), { status: 409, code: 'CLAUDE_CONFIRM', confirm: 'closed' });
    return null;
  }

  /** Ends HYDRAQ's own process for this session so the original client can continue it. */
  async releaseSession(id) {
    const c = this.conversation(id);
    if (this.submitting || active.has(c.status) || [...this.approvals.values()].some(request => request.conversationId === id)) throw new Error('Aguarda a conclusão da tarefa e das decisões pendentes antes de mudar de interface.');
    if (this.session?.conversation === c) await this.#retire();
  }

  /** Appends the requests the original client added after `baseline.leaf` (all of them without one). */
  async importNative(id, baseline = {}, read = null) {
    const c = this.conversation(id);
    const transcript = read || await this.transcript(c.threadId, c.cwd);
    if (!transcript) return { turns: 0, missing: true };
    const chain = activeChain(transcript.entries), order = new Map(transcript.entries.map((entry, index) => [entry, index]));
    let from = 0, rewound = false;
    if (baseline.leaf) {
      from = chain.findIndex(entry => entry.uuid === baseline.leaf) + 1;
      // A rewind behind the hand-off point takes the old leaf off the branch: only later lines are new.
      if (!from) { rewound = true; from = chain.findIndex(entry => order.get(entry) >= (baseline.lines || 0)); if (from < 0) from = chain.length; }
    }
    const { turns, compactions } = transcriptTurns(chain.slice(from), transcript.entries);
    const known = this.models.map(model => [model.id, String(model.resolvedModel || model.id).replace(/\[.*\]$/, '')]);
    const modelId = raw => known.find(([, resolved]) => raw && raw.startsWith(resolved))?.[0] || raw || c.model;
    let added = 0;
    for (const parsed of turns) {
      const key = parsed.prompt?.uuid || parsed.messages[0]?.id || parsed.tools[0]?.id, requestId = `terminal:${key}`;
      if (!key || c.turns.some(turn => turn.requestId === requestId)) continue;
      const turn = { id: randomUUID(), requestId, source: 'terminal', model: modelId(parsed.model), effort: null, sandbox: c.sandbox, status: parsed.status, delivery: 'accepted',
        startedAt: parsed.startedAt || now(), completedAt: parsed.completedAt || parsed.startedAt || now(), usage: null, usageUnavailable: 'Pedido feito no Claude original; o consumo fica registado nessa sessão.',
        ...(parsed.unconfirmed ? { unconfirmed: true, error: 'O Claude original não confirmou a conclusão deste pedido; o texto e as ações podem estar incompletos.' }
          : parsed.status === 'failed' ? { error: 'O pedido terminou com erro ou recusa no Claude original.' } : {}) };
      c.turns.push(turn);
      const images = parsed.prompt?.images ? ` [${parsed.prompt.images} imagem(ns) enviada(s) no Claude original]` : '';
      c.messages.push({ id: `terminal:${key}`, requestId, role: 'user', text: parsed.prompt ? `${parsed.prompt.text}${images}`.trim() : 'Continuação no Claude original', at: turn.startedAt, model: turn.model, turnId: turn.id, source: 'terminal' });
      parsed.messages.forEach((message, index) => c.messages.push({ id: `${turn.id}:${message.id}`, role: 'assistant', text: message.text, at: message.at || turn.completedAt, turnId: turn.id, requestId, model: turn.model, source: 'terminal',
        phase: index === parsed.messages.length - 1 && parsed.status === 'completed' ? 'final_answer' : 'commentary' }));
      for (const tool of parsed.tools) {
        if (c.items.some(item => item.id === tool.id)) continue;
        const declined = tool.isError && denial.test(tool.result);
        const item = { id: tool.id, turnId: turn.id, at: tool.at || turn.startedAt, source: 'terminal', status: !tool.done ? 'interrupted' : declined ? 'declined' : tool.isError ? 'failed' : 'completed', permissionDenied: declined, aggregatedOutput: limit(tool.result) };
        classifyTool({ name: tool.name, input: tool.input }, item);
        c.items.push(item); if (c.items.length > 200) c.items.shift();
        observeAction(c, turn, item);
      }
      if (c.title === 'Nova conversa' && parsed.prompt?.text) c.title = parsed.prompt.text.replace(/\s+/g, ' ').slice(0, 66);
      added++;
    }
    attachTerminalContextReads(c,turns);
    if (compactions) c.contextEpoch = (c.contextEpoch || 0) + compactions;
    c.sessionStarted = true;
    if (added) { const last = c.turns.at(-1); c.status = last.status; c.turnId = null; c.error = last.error || null; c.updatedAt = now(); }
    this.changed(); await this.persist();
    return { turns: added, rewound, skipped: transcript.skipped, compactions };
  }

  #kill(child, signal = 'SIGTERM') { if (!child?.pid) return; try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } }

  async #retire() {
    const session = this.session; if (!session) return;
    if (this.session === session) this.session = null;
    session.child.stdin.end();
    // Background tasks can keep the CLI alive after stdin closes; the process group is ours.
    const timer = setTimeout(() => this.#kill(session.child), 1500);
    const force = setTimeout(() => this.#kill(session.child, 'SIGKILL'), 4000);
    await session.closed; clearTimeout(timer); clearTimeout(force);
  }

  async interrupt(id) {
    const c = this.conversation(id), session = this.session;
    const turn = c.turns.at(-1);
    if (active.has(c.status) && turn?.delivery === 'preparing') {
      turn.cancelRequested = true; turn.status = c.status = 'interrupted'; turn.completedAt = now(); c.turnId = null;
      if (session?.conversation === c && session.initializing) this.#kill(session.child);
      this.changed(); await this.persist(); return { requested: true };
    }
    if (!active.has(c.status) || session?.conversation !== c) throw new Error('Não há uma tarefa do Claude Code ativa.');
    session.stopping = true;
    for (const [key, request] of this.approvals) if (request.session === session) {
      this.#write(session, { type: 'control_response', response: { subtype: 'success', request_id: request.id, response: { behavior: 'deny', message: 'O utilizador parou a tarefa.', interrupt: true } } }).catch(() => {});
      this.approvals.delete(key);
    }
    await this.#write(session, { type: 'control_request', request_id: `interrupt-${randomUUID()}`, request: { subtype: 'interrupt', cancel_queued: true } });
    clearTimeout(session.stopTimer);
    session.stopTimer = setTimeout(() => this.#kill(session.child, 'SIGINT'), 8000);
    return { requested: true };
  }

  async steer(id,text,requestId,expectedTurnId,mode='next',peer=null) {
    this.#ready();
    if(this.readOnly||!id)throw Error('Este cliente não aceita orientações; a fila é gerida pelo HYDRAQ.');
    if(typeof text!=='string'||!text.trim()||text.length>100000||typeof requestId!=='string'||!requestId||requestId.length>100||!['next','now'].includes(mode))throw Error('Orientação inválida.');
    const c=this.conversation(id),session=this.session;
    const old=c.messages.find(m=>m.requestId===requestId);
    if(old){if(old.kind!==(peer?'peer-notice':'steer')||old.text!==text.trim()||old.turnId!==expectedTurnId||old.mode!==mode)throw Error('Identificador já usado para outra orientação.');return {accepted:true,delivery:old.delivery,duplicate:true};}
    const running=()=>c.turnId===expectedTurnId&&['running','waiting'].includes(c.status)&&session===this.session&&!session?.stopping;
    if(!expectedTurnId||session?.conversation!==c||!running())throw Error('Esse turno já terminou. A orientação não iniciou um pedido novo.');
    if(c.messages.some(m=>['steer','peer-notice'].includes(m.kind)&&m.delivery==='sending'))throw Error('Já há uma orientação a aguardar confirmação.');
    if(mode==='now'&&[...this.approvals.values()].some(r=>r.conversationId===id))throw Error('Responde primeiro à autorização pendente ou usa orientar na próxima oportunidade. Redirecionar agora não aprova ações.');
    const message={id:randomUUID(),nativeInputId:randomUUID(),requestId,role:'user',kind:peer?'peer-notice':'steer',...(peer?{source:'coordinator',claudexTask:peer.taskId,internal:'claudex'}:{}),mode,text:text.trim(),turnId:expectedTurnId,model:c.model,effort:c.effort,at:now(),delivery:'preparing'};
    c.messages.push(message);this.changed();
    try{
      await this.persist();
      if(!running())throw Error('O turno terminou antes de receber a orientação.');
      if(mode==='now'&&[...this.approvals.values()].some(r=>r.conversationId===id))throw Error('Existe uma autorização pendente. Responde-lhe primeiro.');
      message.delivery='sending';
      await this.#write(session,{type:'user',uuid:message.nativeInputId,priority:mode,...(peer?{}:{origin:{kind:'human'}}),client_composed:true,parent_tool_use_id:null,message:{role:'user',content:message.text}});
    }catch(e){message.delivery=message.delivery==='sending'?'uncertain':'rejected';message.error=e.message;this.changed();await this.persist();throw e;}
    this.changed();return {accepted:true,delivery:message.delivery,turnId:expectedTurnId};
  }

  async close() {
    if (this.catalogProcess) this.#kill(this.catalogProcess);
    if (this.session) await this.#retire();
    clearTimeout(this.changeTimer); clearTimeout(this.saveTimer); await this.persist();
  }
}
