import {realpath as resolvePath} from 'node:fs/promises';
import {toolFolders} from './command-sandbox.mjs';
import { writeHistory } from './state-store.mjs';
import { imageContent, imageRecords, messageImages } from './attachments.mjs';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexClient } from './codex.mjs';
import os from 'node:os';
import { CACHE_DOCS, readReasoningCapabilities, turnUsage, ZERO_USAGE } from './reasoning.mjs';
import { summarizeProgress } from './progress.mjs';
import { observeAction } from './turn-facts.mjs';

const cut = (text, size = 60_000) => String(text ?? '').slice(-size);
const now = () => new Date().toISOString();
const nativeConfig = {
  model_provider: 'openai',
  service_tier: 'default',
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.reasoning_effort_override': true,
};

// Tool images already reach the native model; do not duplicate their bytes in SSE/history.
export function publicMcpResult(result){
  if(!Array.isArray(result?.content))return result;
  return {...result,content:result.content.map(block=>{
    if(!block||typeof block!=='object')return {type:'text',text:'[Conteúdo MCP inválido omitido]'};
    if(['image','audio'].includes(block.type)){const {data,...metadata}=block;return {...metadata,hydraqBinaryOmitted:true};}
    if(block.type==='resource'&&block.resource?.blob){const {blob,...metadata}=block.resource;return {...block,resource:{...metadata,hydraqBinaryOmitted:true}};}
    return block.type==='text'&&typeof block.text==='string'?{...block,text:cut(block.text),...(block.text.length>60000?{hydraqTruncated:true}:{})}:block;
  })};
}

function codexApprovals(settings,sandbox) {
  if(settings.permissionPolicy&&settings.permissionPolicy.profile!=='native'){
    if(settings.permissionPolicy.externalMcp)return {granular:{mcp_elicitations:true,rules:false,sandbox_approval:false,request_permissions:false,skill_approval:false}};
    return 'never';
  }
  return (settings.internal==='claudex'||sandbox==='read-only')&&!settings.hydraExternalConsent?'never':'on-request';
}

export class Hydraq extends EventEmitter {
  constructor({ dataDir, defaultCwd, client = new CodexClient(), modelMetadataPath }) {
    super();
    this.dataDir = dataDir;
    this.defaultCwd = defaultCwd;
    this.client = client;
    this.modelMetadataPath = modelMetadataPath;
    this.reasoningUpdates = { enabled: false, stage: null, catalogVerified: false, catalogFetchedAt: null, docsUrl: CACHE_DOCS };
    this.conversations = [];
    this.models = [];
    this.account = null;
    this.connection = 'disconnected';
    this.connectionError = null;
    this.approvals = new Map();
    this.loaded = new Set();
    this.threadSettings = new Map();
    this.nativeHistoryRevisions = new Map();
    this.client.on('notification', message => this.#notification(message));
    this.client.on('request', message => this.#request(message));
    this.client.on('diagnostic', text => { this.diagnostic = cut(text, 3000); });
    this.client.on('disconnected', error => {
      this.connection = 'disconnected';
      this.connectionError ||= error.message;
      this.loaded.clear();
      this.threadSettings.clear();
      this.approvals.clear();
      for (const conversation of this.conversations) {
        conversation.turns ||= [];
        for (const message of conversation.messages) if (['steer','peer-notice'].includes(message.kind) && message.delivery === 'sending') {
          message.delivery = 'uncertain';
          message.error = 'A ligação terminou sem confirmação da entrega. A orientação não foi reenviada.';
        }
        if (['running', 'starting', 'waiting'].includes(conversation.status)) {
          conversation.status = 'uncertain';
          conversation.error = 'A ligação terminou. O estado final não está confirmado; o pedido não foi reenviado.';
          for (const turn of conversation.turns) if (['running', 'starting', 'waiting'].includes(turn.status)) turn.status = 'uncertain';
        }
      }
      this.changed();
    });
    this.persistChain = Promise.resolve();
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(path.join(this.dataDir, 'state.json'), 'utf8'));
      if (!Array.isArray(saved.conversations)) throw new Error('Histórico inválido.');
      this.conversations = saved.conversations;
      for (const conversation of this.conversations) {
        conversation.turns ||= [];
        for (const message of conversation.messages) if (['steer','peer-notice'].includes(message.kind) && message.delivery === 'sending') {
          message.delivery = 'uncertain';
          message.error = 'A aplicação foi encerrada sem confirmação da entrega. A orientação não foi reenviada.';
        }
        if (['running', 'starting', 'waiting'].includes(conversation.status)) {
          conversation.status = 'uncertain';
          conversation.error = 'A aplicação foi encerrada durante esta tarefa. Não foi reenviada automaticamente.';
          for (const turn of conversation.turns) if (['running', 'starting', 'waiting'].includes(turn.status)) turn.status = 'uncertain';
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Não foi possível ler o histórico local: ${error.message}`);
    }
  }

  snapshot() {
    return {
      connection: this.connection, connectionError: this.connectionError,
      account: this.account, models: this.models, defaultCwd: this.defaultCwd, reasoningUpdates: this.reasoningUpdates,
      capabilities: { steer:true, nativeApprovals:true, images:true, protectedReadOnly:true, permissionProfiles:['read-only','project'] },
      conversations: this.conversations.map(conversation => ({ ...conversation, progress: summarizeProgress(conversation) })),
      approvals: [...this.approvals.values()].map(({ rpcId, ...request }) => request),
    };
  }

  changed() {
    this.historyRevision=(this.historyRevision||0)+1;
    if (!this.changeTimer) this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.emit('state', this.snapshot());
    }, 75);
    if (!this.saveTimer) this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist().catch(error => {
        this.connectionError = `Não foi possível guardar o histórico: ${error.message}`;
        this.emit('state', this.snapshot());
      });
    }, 600);
  }

  persist() {
    const contents = JSON.stringify({ version: 1, conversations: this.conversations }, null, 2);
    this.persistChain = this.persistChain.catch(() => {}).then(async () => {
      await writeHistory(this.dataDir, contents);
    });
    return this.persistChain;
  }

  async connect() {
    if (this.connection === 'connecting') throw new Error('A ligação já está a ser iniciada.');
    this.connection = 'connecting';
    this.connectionError = null;
    this.changed();
    try {
      await this.client.start();
      const { account } = await this.client.call('account/read', { refreshToken: false });
      if (!account || account.type !== 'chatgpt') {
        throw new Error('É necessária uma sessão ChatGPT no Codex original. Não são aceites chaves API nem fornecedores alternativos. Abre o Codex original e inicia sessão com ChatGPT.');
      }
      this.account = { type: account.type, planType: account.planType || 'ChatGPT' };
      await this.refreshCatalog();
      this.connection = 'connected';
    } catch (error) {
      this.connection = 'disconnected';
      this.account = null;
      this.models = [];
      await this.client.stop();
      this.connectionError = error.message + (this.diagnostic?.includes('sqlite') ? ' O Codex precisa de acesso de escrita ao seu estado em ~/.codex.' : '');
      this.changed();
      throw new Error(this.connectionError);
    }
    this.changed();
    return this.snapshot();
  }

  async refreshCatalog() {
      let feature;
      try {
        let cursor = null;
        do {
          const page = await this.client.call('experimentalFeature/list', { limit: 100, ...(cursor ? { cursor } : {}) }, 15_000);
          feature ||= page.data.find(entry => entry.name === 'reasoning_effort_override');
          cursor = page.nextCursor;
        } while (cursor);
      } catch { /* Older servers remain usable; don't promise preservation without confirmation. */ }
      const models = [];
      let cursor = null;
      const cursors = new Set();
      do {
        const page = await this.client.call('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, 30_000);
        if (!Array.isArray(page.data)) throw Error('Catálogo do Codex inválido.');
        models.push(...page.data.filter(model => !model.hidden));
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw Error('Paginação repetida no catálogo do Codex.');
        cursors.add(cursor);
      } while (cursor);
      if (!models.length) throw Error('O catálogo do Codex está vazio.');
      const clientVersion = /\/(\d+\.\d+\.\d+)/.exec(this.client.info?.userAgent || '')?.[1];
      const metadataFile = this.modelMetadataPath || path.join(this.client.info?.codexHome || this.client.env?.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');
      const capabilities = await readReasoningCapabilities(metadataFile, clientVersion);
      const parsed = models.map(model => ({
        id: model.model, name: model.displayName || model.model, description: model.description,
        metadata: model, inputModalities: model.inputModalities || capabilities.details.get(model.model)?.inputModalities || [],
        contextWindow: model.contextWindow || capabilities.details.get(model.model)?.contextWindow || null,
        supportsPersonality: model.supportsPersonality ?? null,
        isDefault: model.isDefault, defaultEffort: model.defaultReasoningEffort,
        efforts: (model.supportedReasoningEfforts || []).map(option => option.reasoningEffort),
        supportsReasoningEffortUpdates: capabilities.models.get(model.model) ?? null,
      }));
      this.reasoningUpdates = {
        enabled: feature?.enabled === true, stage: feature?.stage || null,
        catalogVerified: capabilities.verified, catalogFetchedAt: capabilities.fetchedAt, docsUrl: CACHE_DOCS,
      };
      this.models = parsed;
      return parsed;
  }

  readQuotas(timeoutMs = 15_000) { return this.client.call('account/rateLimits/read', {}, timeoutMs); }

  conversation(id) {
    const conversation = this.conversations.find(entry => entry.id === id);
    if (!conversation) throw new Error('Conversa não encontrada.');
    return conversation;
  }

  async create({ cwd, model, effort, sandbox = 'workspace-write' }) {
    this.#assertReady();
    const selected = this.models.find(entry => entry.id === model);
    if (!selected) throw new Error('Escolhe um modelo do catálogo do Codex.');
    if (effort && !selected.efforts.includes(effort)) throw new Error('Esforço de raciocínio não suportado por este modelo.');
    if (!['workspace-write', 'read-only'].includes(sandbox)) throw new Error('Modo de acesso inválido.');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Indica o caminho absoluto da pasta do projeto.');
    const folder = await realpath(cwd);
    if (!(await stat(folder)).isDirectory()) throw new Error('O caminho indicado não é uma pasta.');
    const conversation = {
      id: randomUUID(), threadId: null, title: 'Nova conversa', cwd: folder, model,
      effort: effort || selected.defaultEffort, sandbox, status: 'idle', turnId: null,
      createdAt: now(), updatedAt: now(), messages: [], items: [], turns: [], diff: '', error: null,
    };
    this.conversations.unshift(conversation);
    await this.persist();
    this.changed();
    return conversation;
  }

  #assertReady() {
    if (this.connection !== 'connected' || this.account?.type !== 'chatgpt') throw new Error('Liga primeiro o Codex com a tua sessão ChatGPT.');
  }

  // Loaded Codex threads retain their MCP processes across thread/resume.
  // Refresh the idle transport before changing the thread protection or renewing a Hydra lease.
  // This preserves native thread IDs and history; it never replays a model request.
  async refreshClaudeXTransport(id) {
    const c = this.conversation(id);
    if (!c.threadId || !this.loaded.has(id)) return;
    if (this.refreshingTransport || this.submitting || this.approvals.size || this.conversations.some(c => ['starting','running','waiting','uncertain'].includes(c.status)))
      throw Error('Aguarda os turnos e decisões do Codex antes de renovar as ferramentas.');
    this.refreshingTransport = true;
    try {
      await this.client.stop();
      this.loaded.clear();
      this.threadSettings.clear();
      await this.connect();
    } finally { this.refreshingTransport = false; }
  }

  async ensureThread(id, settings = {}) {
    this.#assertReady();
    const conversation = this.conversation(id);
    const protectedTools = settings.permissionPolicy ? settings.permissionPolicy.profile !== 'native' : settings.internal === 'claudex' || conversation.sandbox === 'read-only';
    const mcpKey = JSON.stringify([protectedTools, settings.contextMcp?.file, settings.contextMcp?.names,settings.permissionPolicy,settings.permissionContext]);
    if (this.loaded.has(id) && this.threadSettings.get(id)?.mcpKey === mcpKey) return;
    let protectedConfig = {};
    if(protectedTools){
      const {config}=await this.client.call('config/read',{cwd:conversation.cwd,includeLayers:false});
      if(!config||typeof config!=='object')throw Error('Não foi possível confirmar as ferramentas do Codex para este turno protegido.');
      // External MCP/apps can write outside the filesystem sandbox. Disable inherited tools for this task only.
      const tomlValue=value=>Array.isArray(value)?value.filter(v=>v!==null).map(tomlValue):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==null).map(([k,v])=>[k,tomlValue(v)])):value;
      protectedConfig={'features.apps':false,'features.plugins':false,'features.remote_plugin':false,'features.hooks':false,'features.plugin_hooks':false,'features.in_app_browser':false,'features.browser_use':false,'features.computer_use':false,plugins:Object.fromEntries(Object.keys(config.plugins||{}).map(name=>[name,{enabled:false}])),apps:Object.fromEntries(Object.entries({...config.apps,_default:config.apps?._default||{}}).map(([name,value])=>[name,{...tomlValue(value),enabled:false}])),...(settings.permissionPolicy?.externalMcp&&settings.internal!=='claudex'?{}:{mcp_servers:Object.fromEntries(Object.entries(config.mcp_servers||{}).map(([name,value])=>[name,{...tomlValue(value),enabled:false}]))})};
    }
    const contextServer=settings.contextMcp?{command:settings.contextMcp.command,args:settings.contextMcp.args,env:settings.contextMcp.env,enabled_tools:settings.contextMcp.names,...(settings.contextMcp.toolTimeoutSec?{tool_timeout_sec:settings.contextMcp.toolTimeoutSec,omit_tools_from:['code_mode','deferred']}:{}),default_tools_approval_mode:'approve',tools:Object.fromEntries(settings.contextMcp.names.map(name=>[name,{approval_mode:'approve'}]))}:null;
    if(protectedConfig.mcp_servers&&contextServer)protectedConfig.mcp_servers[settings.contextMcp.name]=contextServer;
    const strict = settings.permissionPolicy && settings.permissionPolicy.profile !== 'native';
    let profileConfig = {};
    if (strict) {
      const policy = settings.permissionPolicy, write = policy.profile === 'project';
      const filesystem = {':minimal':'read'};
      for (const folder of toolFolders()) filesystem[folder]='read';
      const binary = this.client.process?.pid ? await resolvePath('/proc/'+this.client.process.pid+'/exe').catch(()=>null) : null;
      if(binary)filesystem[path.dirname(binary)]='read';
      const rules = {'.':write?'write':'read','.git':'read','.hydraq':'read'};
      for (const file of settings.permissionContext?.protectedPaths||[]) rules[file]='read';
      filesystem[':workspace_roots']=rules;
      if(settings.permissionContext?.tmp)filesystem[settings.permissionContext.tmp]='write';
      profileConfig = {permissions:{hydraq_turn:{filesystem,network:{enabled:policy.network}}},web_search:policy.network?'live':'disabled'};
    }
    const params = {
      cwd: conversation.cwd, model: conversation.model, modelProvider: 'openai',
      approvalPolicy: codexApprovals(settings,conversation.sandbox), approvalsReviewer: 'user', ...(strict?{permissions:'hydraq_turn'}:{sandbox:conversation.sandbox}),
      config: {...nativeConfig,...protectedConfig,...profileConfig,...(contextServer&&!protectedConfig.mcp_servers?{['mcp_servers.'+settings.contextMcp.name]:contextServer}:{})}, serviceTier: 'default',
    };
    const result = conversation.threadId
      ? await this.client.call('thread/resume', {...params, threadId: conversation.threadId, excludeTurns: true})
      : await this.client.call('thread/start', params);
    conversation.threadId = result.thread.id;
    this.loaded.add(id);
    this.threadSettings.set(id, {protectedTools, mcpKey,policy:settings.permissionPolicy});
    await this.persist();
  }

  // Fetch every page before changing local state. Replay synchronously into a
  // detached copy, so a failed page/reducer cannot publish partial history.
  async reconcileNative(id) {
    const conversation = this.conversation(id);
    if (!conversation.threadId) throw Error('Esta conversa ainda não tem uma sessão Codex.');
    let cursor = null;
    const seen = new Set();
    const revision = this.nativeHistoryRevisions.get(id);
    const turns = [];
    do {
      const page = await this.client.call('thread/turns/list', {threadId: conversation.threadId, cursor, limit: 50, sortDirection: 'asc', itemsView: 'full'});
      turns.push(...page.data);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw Error('O Codex repetiu uma página de histórico; a sincronização não foi confirmada.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (this.nativeHistoryRevisions.get(id) !== revision) throw Error('A sessão mudou durante a leitura do histórico. Volta a tentar quando estiver livre.');
    const recovered = structuredClone(conversation);
    for (const turn of turns) {
      const params = {threadId: conversation.threadId, turnId: turn.id, historical: true};
      this.#notification({method: 'turn/started', params: {...params, turn}}, recovered);
      for (const item of turn.items || []) this.#notification({method: 'item/completed', params: {...params, item}}, recovered);
      if (turn.status !== 'inProgress') this.#notification({method: 'turn/completed', params: {...params, turn}}, recovered);
    }
    Object.assign(conversation, recovered);
    this.changed();
    await this.persist();
    return conversation;
  }

  async send(id, text, requestId, settings = {}) {
    this.#assertReady();
    if (this.refreshingTransport) throw new Error('Aguarda a renovação das ferramentas do Codex.');
    if (typeof text !== 'string' || !text.trim()) throw new Error('Escreve um pedido.');
    if (typeof requestId !== 'string' || requestId.length > 100) throw new Error('Identificador do pedido inválido.');
    const conversation = this.conversation(id);
    const existing = conversation.messages.find(message => message.requestId === requestId);
    if (existing) return { accepted: true, duplicate: true };
    const shown = (settings.displayText ?? text).trim();
    if (this.conversations.some(entry => ['starting', 'running', 'waiting'].includes(entry.status))) throw new Error('Já há uma tarefa em curso. Aguarda ou interrompe-a primeiro.');
    if (conversation.status === 'uncertain') throw new Error('O estado da última tarefa é incerto. Cria uma nova conversa para evitar repetir trabalho sem confirmação.');
    const modelId = settings.model ?? conversation.model;
    const selectedModel = this.models.find(model => model.id === modelId);
    if (!selectedModel) throw new Error('Escolhe um modelo do catálogo do Codex.');
    const effort = settings.effort ?? (selectedModel.efforts.includes(conversation.effort) ? conversation.effort : selectedModel.defaultEffort);
    if (!selectedModel.efforts.includes(effort)) throw new Error('Esforço de raciocínio não suportado por este modelo.');
    const sandbox = settings.sandbox ?? conversation.sandbox;
    if (!['workspace-write', 'read-only'].includes(sandbox)) throw new Error('Modo de acesso inválido.');
    const protectedTools = settings.permissionPolicy ? settings.permissionPolicy.profile !== 'native' : settings.internal === 'claudex' || sandbox === 'read-only';
    const previousSettings = this.threadSettings.get(id);
    if (this.loaded.has(id) && ((settings.permissionPolicy&&protectedTools) || previousSettings?.protectedTools !== protectedTools || JSON.stringify(previousSettings?.policy)!==JSON.stringify(settings.permissionPolicy))) {
      await this.refreshClaudeXTransport(id);
    }
    if (sandbox !== conversation.sandbox) { conversation.sandbox = sandbox; this.loaded.delete(id); }
    conversation.turns ||= [];
    const previousTurn = conversation.turns.at(-1);
    const turn = {
      requestId, id: null, model: modelId, effort, sandbox, startedAt: now(), ...(settings.hydraExternalConsent?{hydraExternalConsent:true,hydraMcpServer:settings.contextMcp?.name}:{}), completedAt: null, status: 'starting', delivery: 'preparing',
      previousModel: previousTurn?.model || (conversation.threadId ? conversation.model : null),
      previousEffort: previousTurn?.effort || (conversation.threadId ? conversation.effort : null),
      usageBaseline: conversation.tokenUsage?.total ? { ...conversation.tokenUsage.total } : (conversation.threadId ? null : { ...ZERO_USAGE }),
      usage: null,
      ...(settings.images?.length ? { inputAttachments:imageRecords(settings.images) } : {}),
      ...(settings.internal ? { internal: settings.internal } : {}),
      ...(settings.internal==='claudex'?{hydraWrite:settings.hydraWrite===true}:{}),
    };
    conversation.model = modelId;
    conversation.effort = effort;
    if(settings.projectDelivery)turn.projectDelivery=settings.projectDelivery;
    if(settings.permissionPolicy){
      turn.permissionPolicy=settings.permissionPolicy;
      turn.permissionRequested=settings.permissionRequested||settings.permissionPolicy;
      turn.permissionRoute=settings.permissionRoute||'normal';
      if(settings.permissionPolicy.profile!=='native')turn.permissionAudit={status:'pending'};
    }
    conversation.turns.push(turn);
    conversation.status = 'starting';
    conversation.error = null;
    conversation.diff = '';
    conversation.updatedAt = now();
    conversation.messages.push({ id: randomUUID(), role: 'user', text: shown, at: now(), requestId, model: modelId, effort, ...(settings.internal ? { internal: settings.internal } : {}), ...(settings.handoffContext ? { handoffContext: settings.handoffContext } : {}) });
    if(messageImages(settings).length)conversation.messages.at(-1).attachments=imageRecords(messageImages(settings));
    if(settings.projectContext)conversation.messages.at(-1).projectContext=settings.projectContext;
    if(settings.contextImages?.length)conversation.messages.at(-1).contextImages=settings.contextImages;
    if (conversation.title === 'Nova conversa' && !settings.internal) conversation.title = shown.replace(/\s+/g, ' ').slice(0,66);
    this.changed();
    try {
      await this.persist();
      if (turn.cancelRequested) return { accepted: true, interrupted: true };
      await this.ensureThread(id, settings);
      if (turn.cancelRequested) return { accepted: true, interrupted: true };
      await this.turnQuotas?.begin(this, turn, selectedModel);
      if (turn.cancelRequested) return { accepted: true, interrupted: true };
      turn.delivery = 'sending';
      const result = await this.client.call('turn/start', {
        threadId: conversation.threadId,
        // A loaded thread keeps the folder it started in, and Codex always lets a turn write in its folder, whatever writableRoots says.
        cwd: conversation.cwd,
        input: [{ type: 'text', text: text.trim() },...imageContent(settings.images,'codex')],
        model: conversation.model, effort: conversation.effort,
        approvalPolicy: codexApprovals(settings,sandbox),
        ...(settings.permissionPolicy && settings.permissionPolicy.profile !== 'native' ? {permissions:'hydraq_turn'} : {
          sandboxPolicy: sandbox === 'read-only'
            ? { type: 'readOnly', networkAccess: Boolean(settings.permissionPolicy?.network) }
            : { type: 'workspaceWrite', writableRoots: [conversation.cwd], networkAccess: Boolean(settings.permissionPolicy?.network), excludeSlashTmp: true, excludeTmpdirEnvVar: true }}),
        serviceTierForTurn: 'default',
      });
      turn.id ||= result.turn.id;
      if (turn.cancelRequested && ['starting', 'running', 'waiting'].includes(turn.status)) {
        await this.client.call('turn/interrupt', { threadId: conversation.threadId, turnId: turn.id });
      }
      // Notifications can arrive before this response, including completion.
      if (conversation.status === 'starting') {
        conversation.turnId = result.turn.id;
        conversation.status = 'running';
        turn.status = 'running';
      }
      this.changed();
      return { accepted: true, nativeTurn: result.turn };
    } catch (error) {
      if (turn.cancelRequested && turn.delivery === 'preparing') return { accepted: true, interrupted: true };
      if (turn.delivery === 'preparing' && /already has (?:an active|a live local) writer/i.test(error.message)) {
        // Another native client owns the thread. Never steal its lock, fork it or resend.
        error = new Error('Esta sessão está aberta para escrita noutra instância do Codex. Liberta-a nessa instância; pode ser necessário reiniciar essa aplicação. Este pedido não foi enviado ao modelo. O histórico e o texto do pedido foram conservados.', { cause: error });
      }
      conversation.status = /Sem confirmação|ligação|terminou/i.test(error.message) ? 'uncertain' : 'failed';
      conversation.error = error.message;
      turn.status = conversation.status;
      turn.completedAt = now();
      this.changed();
      await this.persist();
      throw error;
    }
  }

  async interrupt(id) {
    const conversation = this.conversation(id);
    const turn = conversation.turns.at(-1);
    if (['starting', 'running', 'waiting'].includes(conversation.status) && turn?.delivery === 'preparing') {
      turn.cancelRequested = true; turn.status = conversation.status = 'interrupted'; turn.completedAt = now(); conversation.turnId = null;
      this.changed(); await this.persist(); return { requested: true };
    }
    if (conversation.status === 'starting' && turn?.delivery === 'sending' && !conversation.turnId) {
      turn.cancelRequested = true; this.changed(); return { requested: true };
    }
    if (!conversation.turnId || !['starting','running','waiting'].includes(conversation.status)) throw new Error('Não existe um turno ativo que possa ser interrompido.');
    await this.client.call('turn/interrupt', { threadId: conversation.threadId, turnId: conversation.turnId });
    return { requested: true };
  }

  async steer(id, text, requestId, expectedTurnId, mode, peer=null) {
    this.#assertReady();
    if (typeof text !== 'string' || !text.trim()) throw new Error('Escreve uma orientação.');
    if (typeof requestId !== 'string' || !requestId || requestId.length > 100) throw new Error('Identificador da orientação inválido.');
    if (typeof expectedTurnId !== 'string' || !expectedTurnId) throw new Error('É necessário identificar o turno que queres orientar.');
    const conversation = this.conversation(id);
    const existing = conversation.messages.find(message => message.requestId === requestId);
    if (existing) {
      if (existing.kind !== (peer?'peer-notice':'steer') || existing.turnId !== expectedTurnId || existing.text !== text.trim()) throw new Error('Este identificador já pertence a outro pedido.');
      return { accepted: existing.delivery === 'accepted', delivery: existing.delivery, turnId: existing.turnId, duplicate: true };
    }
    const isActive = () => conversation.turnId === expectedTurnId && ['running', 'waiting'].includes(conversation.status);
    if (!isActive()) throw new Error('Esse turno já não está ativo. A orientação não iniciou um novo pedido.');
    if (conversation.messages.some(message => ['steer','peer-notice'].includes(message.kind) && message.delivery === 'sending')) throw new Error('Já há uma orientação a aguardar confirmação.');
    const turn = conversation.turns?.find(turn => turn.id === expectedTurnId);
    const message = {
      id: randomUUID(), requestId, role: 'user', kind: peer?'peer-notice':'steer', ...(peer?{source:'coordinator',claudexTask:peer.taskId,internal:'claudex'}:{}), text: text.trim(),
      turnId: expectedTurnId, model: turn?.model || conversation.model, effort: turn?.effort || conversation.effort,
      at: now(), delivery: 'sending', error: null,
    };
    conversation.messages.push(message);
    conversation.updatedAt = now();
    this.changed();
    try {
      await this.persist();
      if (!isActive()) throw new Error('A tarefa terminou antes do envio. A orientação não iniciou um novo pedido.');
      const result = await this.client.call('turn/steer', {
        threadId: conversation.threadId, expectedTurnId,
        input: [{ type: 'text', text: message.text }], clientUserMessageId: requestId,
      });
      if (result.turnId !== expectedTurnId) throw new Error('Sem confirmação do turno de destino. A orientação não será repetida.');
      message.delivery = 'accepted';
      message.receivedAt = now();
    } catch (error) {
      message.delivery = !this.client.ready || message.delivery === 'uncertain' || /Sem confirmação|ligação|terminou \(|não está ligado/i.test(error.message) ? 'uncertain' : 'rejected';
      message.error = error.message;
      this.changed();
      await this.persist();
      throw error;
    }
    this.changed();
    try { await this.persist(); }
    catch (error) { this.connectionError = `A orientação foi recebida, mas não foi possível guardar o histórico: ${error.message}`; this.changed(); }
    return { accepted: true, delivery: 'accepted', turnId: expectedTurnId };
  }

  #notification({ method, params = {} }, historicalConversation) {
    if (method === 'account/rateLimits/updated') { this.emit('quotas', params); return; }
    if(method==='thread/compacted'){const c=this.conversations.find(c=>c.threadId===params.threadId);if(c){c.contextEpoch=(c.contextEpoch||0)+1;this.changed();}return;}
    if (method === 'account/updated' && params.authMode !== 'chatgpt') {
      this.account = null;
      this.connectionError = 'A autenticação deixou de ser ChatGPT. A execução foi bloqueada.';
      this.client.stop();
    }
    const conversation = historicalConversation || this.conversations.find(entry => entry.threadId === params.threadId);
    if (!conversation) return;
    // MCP startup/status and token counters can arrive while an idle thread is
    // being attached. They do not invalidate the fetched turns; live content,
    // lifecycle and approval changes do.
    if (!historicalConversation && (method.startsWith('turn/') || method.startsWith('item/') || method === 'error' || method === 'serverRequest/resolved'))
      this.nativeHistoryRevisions.set(conversation.id, (this.nativeHistoryRevisions.get(conversation.id) || 0) + 1);
    const nativeTurnId = params.turnId || params.turn?.id;
    let turn = conversation.turns?.find(entry => entry.id === nativeTurnId)
      || (!historicalConversation && conversation.turns?.findLast(entry => !entry.id && entry.status === 'starting'));
    if (!turn && nativeTurnId && (method.startsWith('turn/') || method.startsWith('item/'))) {
      turn = {id: nativeTurnId, requestId: 'native:' + nativeTurnId, source: 'native', model: null, effort: null,
        sandbox: null, startedAt: null, completedAt: null, status: 'running', delivery: 'observed', usage: null};
      (conversation.turns ||= []).push(turn);
    }
    if (turn && nativeTurnId) turn.id ||= nativeTurnId;
    if (method === 'turn/started') {
      if (turn && params.turn.startedAt != null) turn.startedAt ||= new Date(params.turn.startedAt * 1000).toISOString();
      conversation.status = 'running';
      conversation.turnId = params.turn.id;
      if (turn) turn.status = 'running';
    } else if (method === 'turn/plan/updated' && turn) {
      turn.plan = {
        explanation: params.explanation ? cut(params.explanation, 8000) : null,
        steps: (params.plan || []).filter(step => typeof step.step === 'string' && ['pending', 'inProgress', 'completed'].includes(step.status)).slice(0, 60).map(step => ({ step: step.step, status: step.status })),
        updatedAt: now(),
      };
    } else if (method === 'item/agentMessage/delta') {
      let message = conversation.messages.find(entry => entry.id === params.itemId);
      if (!message) {
        message = { id: params.itemId, role: 'assistant', text: '', at: now(), streaming: true, turnId: nativeTurnId, model: turn?.model, effort: turn?.effort, requestId: turn?.requestId, ...(turn?.internal ? { internal: turn.internal } : {}) };
        conversation.messages.push(message);
      }
      message.text += params.delta || '';
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = params.item;
      if (item.type === 'agentMessage') {
        let message = conversation.messages.find(entry => entry.id === item.id);
        if (!message) {
          message = { id: item.id, role: 'assistant', text: item.text || '', at: now(), turnId: nativeTurnId, model: turn?.model, effort: turn?.effort, requestId: turn?.requestId, ...(turn?.internal ? { internal: turn.internal } : {}) };
          conversation.messages.push(message);
        }
        if (method === 'item/completed') {
          message.text = item.text || message.text;
          message.streaming = false;
          message.phase = item.phase ?? message.phase;
        } else {
          message.phase = item.phase || message.phase;
          message.streaming = true;
        }
      } else if (item.type === 'userMessage') {
        const nativeText = (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
        const existing = conversation.messages.find(message => message.nativeItemId === item.id || message.id === item.id)
          || conversation.messages.find(message => ['steer','peer-notice'].includes(message.kind) && !message.nativeItemId && message.turnId === nativeTurnId && message.text === nativeText)
          || conversation.messages.find(message => message.role === 'user' && !message.nativeItemId && message.requestId === turn?.requestId && !message.kind && turn?.source !== 'native');
        if (existing) existing.nativeItemId ||= item.id;
        else conversation.messages.push({id: item.id, nativeItemId: item.id, role: 'user',
          text: nativeText,
          nativeContent: item.content, at: now(), turnId: nativeTurnId, requestId: turn?.requestId, source: 'native'});
      } else {
        const previous = conversation.items.find(entry => entry.id === item.id);
        const display = { ...item, aggregatedOutput: cut(item.aggregatedOutput ?? previous?.aggregatedOutput), at: previous?.at || now(), turnId: nativeTurnId };
        if(item.type==='mcpToolCall'&&item.result)display.result=publicMcpResult(item.result);
        if (!display.status) display.status = method === 'item/completed' ? 'completed' : 'inProgress';
        if (method === 'item/completed' && typeof display.exitCode === 'number' && display.exitCode !== 0) display.status = 'failed';
        if (method === 'item/completed') display.completedAt = now();
        if (previous) Object.assign(previous, display);
        else conversation.items.push(display);
        observeAction(conversation, turn, previous || display);
        if (conversation.items.length > 200) conversation.items.shift();
      }
    } else if (method === 'item/commandExecution/outputDelta') {
      const item = conversation.items.find(entry => entry.id === params.itemId);
      if (item) item.aggregatedOutput = cut((item.aggregatedOutput || '') + (params.delta || ''));
    } else if (method === 'turn/diff/updated') {
      conversation.diff = cut(params.diff, 180_000);
    } else if (method === 'thread/tokenUsage/updated') {
      conversation.tokenUsage = params.tokenUsage;
      if (turn) {
        const usage = turnUsage(params.tokenUsage.total, turn.usageBaseline);
        if (turn.usageBaseline && !usage) turn.usageCounterReset = true;
        turn.usage = turn.usageCounterReset ? null : usage;
        turn.usageUnavailable = turn.usage ? null : 'Não é possível separar este pedido dos contadores anteriores.';
      }
    } else if (method === 'error') {
      conversation.error = params.error?.message || params.message || 'Erro comunicado pelo Codex.';
    } else if (method === 'serverRequest/resolved') {
      this.approvals.delete(String(params.requestId));
    } else if (method === 'turn/completed') {
      conversation.status = params.turn.status || 'completed';
      conversation.error = params.turn.error?.message || (conversation.status === 'completed' ? null : conversation.error);
      conversation.turnId = null;
      if (turn) {
        turn.status = conversation.status;
        turn.completedAt ||= params.turn.completedAt != null ? new Date(params.turn.completedAt * 1000).toISOString() : now();
        if (!historicalConversation) void this.turnQuotas?.settle(turn);
      }
      for (const message of conversation.messages) message.streaming = false;
      if (!historicalConversation) for (const [key, request] of this.approvals) if (request.conversationId === conversation.id) this.approvals.delete(key);
    }
    conversation.updatedAt = now();
    if (!historicalConversation) this.changed();
  }

  #request({ id, method, params }) {
    const conversation = this.conversations.find(entry => entry.threadId === params.threadId);
    if (conversation) this.nativeHistoryRevisions.set(conversation.id, (this.nativeHistoryRevisions.get(conversation.id) || 0) + 1);
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'tool/requestUserInput', 'mcpServer/elicitation/request'];
    if (!conversation || !supported.includes(method)) {
      this.client.reject(id, `O HYDRAQ ainda não suporta este pedido: ${method}. Nenhuma autorização foi concedida.`);
      if (conversation) {
        conversation.error = `O Codex pediu uma ferramenta ainda não suportada: ${method}.`;
        this.changed();
      }
      return;
    }
    const taskTurn=conversation.turns.at(-1);
    if(taskTurn?.internal==='claudex'&&taskTurn.id===params.turnId&&typeof taskTurn.hydraMcpServer==='string'&&taskTurn.hydraExternalConsent&&method==='mcpServer/elicitation/request'&&params.serverName===taskTurn.hydraMcpServer&&params._meta?.codex_approval_kind==='mcp_tool_call'){this.client.respond(id,{action:'accept',content:{}});return;}
    const protectedTurn = (taskTurn?.permissionPolicy && taskTurn.permissionPolicy.profile !== 'native') || taskTurn?.internal === 'claudex' || taskTurn?.sandbox === 'read-only';
    if (protectedTurn && method !== 'tool/requestUserInput' && !(method==='mcpServer/elicitation/request'&&taskTurn?.permissionPolicy?.externalMcp)) {
      this.client.reject(id, 'Este turno recusa pedidos de exceção ao sandbox ou a ferramentas externas.');
      return;
    }
    this.approvals.set(String(id), { id: String(id), rpcId: id, method, params, conversationId: conversation.id });
    conversation.status = 'waiting';
    const activeTurn = conversation.turns?.find(turn => turn.id === params.turnId);
    if (activeTurn) activeTurn.status = 'waiting';
    this.changed();
  }

  respond(requestId, body) {
    const request = this.approvals.get(String(requestId));
    if (!request) throw new Error('Este pedido já foi resolvido ou deixou de estar ativo.');
    let result;
    if (request.method.endsWith('/requestApproval')) {
      if (!['accept', 'decline', 'cancel'].includes(body.decision)) throw new Error('Decisão inválida.');
      result = { decision: body.decision };
    } else if (request.method === 'tool/requestUserInput') {
      const answers = {};
      for (const question of request.params.questions) {
        const answer = body.answers?.[question.id];
        if (typeof answer !== 'string' || !answer.trim() || answer.length > 10_000) throw new Error('Responde a todas as perguntas.');
        answers[question.id] = { answers: [answer] };
      }
      result = { answers };
    } else {
      if (!['accept', 'decline', 'cancel'].includes(body.action)) throw new Error('Resposta inválida.');
      result = { action: body.action, content: body.action === 'accept' ? (body.content || {}) : null };
    }
    this.client.respond(request.rpcId, result);
    this.approvals.delete(String(requestId));
    this.emit('approval-resolved', {method:'serverRequest/resolved',params:{threadId:request.params.threadId,requestId:request.rpcId}});
    const conversation = this.conversation(request.conversationId);
    if (!this.snapshot().approvals.some(entry => entry.conversationId === conversation.id)) conversation.status = 'running';
    const activeTurn = conversation.turns?.find(turn => turn.id === request.params.turnId);
    if (activeTurn && conversation.status === 'running') activeTurn.status = 'running';
    this.changed();
    return { sent: true };
  }

  async close() {
    clearTimeout(this.changeTimer);
    clearTimeout(this.saveTimer);
    await this.client.stop();
    clearTimeout(this.changeTimer);
    clearTimeout(this.saveTimer);
    await this.persist();
  }
}
