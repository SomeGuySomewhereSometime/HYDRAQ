import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp, chmod, rm, open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID, createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {WebSocketServer, WebSocket} from 'ws';
import {groupOf} from './handoff.mjs';
import {MAX_IMAGE_BYTES, inspectImage} from './attachments.mjs';

const active = new Set(['starting', 'running', 'waiting', 'uncertain']);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const readMethods = new Set(['account/read', 'account/rateLimits/read', 'model/list', 'config/read',
  'configRequirements/read', 'experimentalFeature/list', 'skills/list', 'hooks/list', 'plugin/list', 'collaborationMode/list', 'app/list', 'mcpServerStatus/list']);

/** A scoped adapter for the original TUI. The private stdio executor is never exposed:
 * every model request goes through Providers, and unknown mutations fail closed.
 * Closing a terminal disconnects its view, not the native executor or its current turn.
 */
export class NativeSessions {
  constructor(hub) {
    this.hub = hub;
    this.sessions = new Map();
    this.permit = Symbol('native-session-input');
    this.codex = hub.clients.codex;
    this.notification = message => this.broadcast(message);
    this.request = message => this.broadcast(message);
    this.resolved = message => this.broadcast(message);
    this.codex?.on('approval-resolved', this.resolved);
    this.disconnected = () => { for (const session of this.sessions.values()) session.peer?.close(1011, 'Codex desligado'); };
    this.codex?.client?.on('notification', this.notification);
    this.codex?.client?.on('request', this.request);
    this.codex?.client?.on('disconnected', this.disconnected);
  }

  snapshot() {
    return {available: Boolean(this.codex?.client?.call) && process.platform !== 'win32',
      desktopAvailable: false,
      sessions: [...this.sessions.values()].map(s => ({conversationId: s.id, group: s.group,
        connected: s.peer?.readyState === WebSocket.OPEN, owner: 'terminal', preparing: s.preparing}))};
  }

  assertControl(id, permit, requestId, reservation) {
    this.hub.claudeTerminal?.assertControl(id);
    const conversation = this.hub.conversations().find(c => c.id === id);
    const session = [...this.sessions.values()].find(s => s.group === groupOf(conversation || {id}));
    if (!session || permit === this.permit) return;
    // A previously armed automatic review remains part of the admitted request.
    if (reservation && this.hub.automaticReviews.cycles.some(c => c.returnRequestId === requestId &&
      c.conversationId === id && this.hub.automaticReviews.isPending(c))) return;
    throw Error('Esta conversa está no terminal. Usa «Continuar na HYDRAQ» antes de enviar outro pedido.');
  }

  changed() { this.hub.emit('state', this.hub.snapshot()); }
  idle(conversation) {
    if (active.has(conversation.status) || [...this.codex.approvals.values()].some(a => a.conversationId === conversation.id))
      throw Error('Aguarda a conclusão da tarefa e das decisões pendentes antes de mudar de interface.');
    this.hub.assertFree(this.hub.scopeFor(conversation, 'codex'));
  }

  async open(id, {launch = true} = {}) {
    if (this.hub.closing) throw Error('A HYDRAQ está a encerrar.');
    if (process.platform === 'win32') throw Error('A ligação local ao terminal requer sockets Unix nesta versão.');
    const conversation = this.codex.conversation(id);
    if (this.sessions.has(id)) {
      const session=this.sessions.get(id);
      if (session.preparing) throw Error('A ligação ao terminal ainda está a ser preparada.');
      return this.info(session);
    }
    this.idle(conversation);
    if (!conversation.threadId || !conversation.turns.length) throw Error('Envia primeiro um pedido nesta conversa para guardar a sessão nativa.');
    if (this.codex.connection !== 'connected') throw Error('Liga primeiro o Codex.');
    const session = {id, group: groupOf(conversation), threadId: conversation.threadId, preparing: true};
    this.sessions.set(id, session); this.changed();
    const reservation = {...this.hub.scopeFor(conversation, 'codex'), reason: 'A ligar o terminal'};
    this.hub.reservations.set('native:' + id, reservation);
    try {
      await this.hub.projects.assertUsable(session.group, [conversation]);
      await this.codex.ensureThread(id, {contextMcp: await this.hub.contextMcp.issue(conversation)});
      await this.codex.reconcileNative(id);
      if (active.has(conversation.status)) throw Error('A sessão nativa ainda tem uma tarefa ativa ou incerta.');
      session.directory = await mkdtemp(path.join(os.tmpdir(), 'hydraq-native-'));
      await chmod(session.directory, 0o700);
      session.socket = path.join(session.directory, 'control.sock');
      session.server = http.createServer((request, response) => { response.writeHead(404); response.end(); });
      session.wss = new WebSocketServer({noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false});
      session.server.on('upgrade', (request, socket, head) => {
        if (request.headers.origin || session.peer || session.preparing || this.hub.closing) return socket.destroy();
        session.wss.handleUpgrade(request, socket, head, peer => this.connected(session, peer));
      });
      await new Promise((resolve, reject) => { session.server.once('error', reject); session.server.listen(session.socket, resolve); });
      await chmod(session.socket, 0o600);
      session.preparing = false;
      const executable = this.codex.client.executable;
      session.argv = ['resume', '--remote', 'unix://' + session.socket, '--no-alt-screen', '-C', conversation.cwd, conversation.threadId];
      session.command = [executable, ...session.argv].map(quote).join(' ');
      conversation.nativeSource = {threadId: conversation.threadId, cwd: conversation.cwd, interface: 'terminal'};
      await this.codex.persist();
      if (launch) {
        try {
          const terminal = spawn('x-terminal-emulator', ['-e', executable, ...session.argv], {cwd: conversation.cwd, stdio: 'ignore', detached: true});
          await new Promise((resolve, reject) => { terminal.once('spawn', resolve); terminal.once('error', reject); });
          terminal.unref();
        } catch { session.launchWarning = 'Não foi possível abrir uma janela. Copia o comando para o teu terminal.'; }
      }
      return this.info(session);
    } catch (error) { await this.dispose(session); throw error; }
    finally { this.hub.reservations.delete('native:' + id); this.changed(); }
  }

  info(session) { return {conversationId: session.id, command: session.command, warning: session.launchWarning || null}; }

  async release(id) {
    const session = this.sessions.get(id);
    if (!session) return {released: true};
    const conversation = this.codex.conversation(id);
    this.idle(conversation);
    if (session.inflight) throw Error('O terminal ainda tem um pedido a ser admitido.');
    // Revoke input synchronously, before reading history or closing the peer.
    session.preparing = true;
    try { await this.codex.reconcileNative(id); await this.dispose(session); }
    catch (error) { session.preparing = false; throw error; }
    this.changed(); return {released: true};
  }

  async dispose(session) {
    session.preparing = true;
    session.peer?.terminate();
    session.wss?.close();
    if (session.server?.listening) await new Promise(resolve => session.server.close(resolve));
    if (session.directory) await rm(session.directory, {recursive: true, force: true});
    this.sessions.delete(session.id);
  }

  connected(session, peer) {
    session.peer = peer;
    let initialized = false;
    const pending = new Set();
    peer.on('error', () => {});
    peer.on('close', () => { if (session.peer === peer) { session.peer = null; this.changed(); } });
    peer.on('message', async (raw, binary) => {
      let message, ownsPending = false;
      try {
        if (binary) throw Error('São aceites apenas mensagens JSON.');
        message = JSON.parse(raw.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error('Pedido JSON inválido.');
        if (!message.method && message.id !== undefined) { if (initialized) return this.respond(session, message); return; }
        if (message.method === 'initialized') return;
        if (message.id === undefined) return;
        if (!['string', 'number'].includes(typeof message.id) || pending.has(message.id)) throw Error('Identificador RPC inválido ou em curso.');
        pending.add(message.id); ownsPending = true;
        let result;
        if (message.method === 'initialize') {
          if (initialized) throw Error('Ligação já inicializada.');
          initialized = true; result = this.codex.client.info;
        } else {
          if (!initialized) throw Error('Inicializa primeiro a ligação.');
          result = await this.dispatch(session, message.method, message.params || {}, message.id);
        }
        this.write(peer, {id: message.id, result});
        if (message.method === 'thread/resume') for (const request of this.codex.approvals.values()) {
          if (request.conversationId === session.id) this.write(peer, {id:request.rpcId,method:request.method,params:request.params});
        }
      } catch (error) {
        if (message?.id !== undefined && message.method) this.write(peer, {id: message.id, error: {code: -32000, message: error.message}});
        else if (message?.id !== undefined && initialized) {
          const request = this.codex.approvals.get(String(message.id));
          if (request?.conversationId === session.id) {
            this.write(peer, {method:'warning',params:{threadId:session.threadId,message:'A decisão não foi aceite: ' + error.message + ' Usa uma autorização única, recusa ou responde na HYDRAQ.'}});
            this.write(peer, {id:request.rpcId,method:request.method,params:request.params});
          }
        }
      } finally { if (ownsPending) pending.delete(message.id); }
    });
    this.changed();
  }

  write(peer, message) {
    if (peer?.readyState !== WebSocket.OPEN) return;
    const bytes = Buffer.from(JSON.stringify(this.project(message)));
    // The native plugin catalog can exceed 16 MiB. Bound the entire queue,
    // but fragment large messages to respect the TUI's per-frame limit.
    if (peer.bufferedAmount + bytes.length > 64 * 1024 * 1024) return peer.close(1013, 'Volta a ligar para recuperar o histórico.');
    const frameBytes = 64 * 1024;
    for (let offset = 0; offset < bytes.length; offset += frameBytes)
      peer.send(bytes.subarray(offset, offset + frameBytes), {binary: false, fin: offset + frameBytes >= bytes.length});
  }
  project(message) {
    const copy = structuredClone(message);
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (value.type === 'userMessage' && value.id) {
        const shown = this.codex.conversations.flatMap(c => c.messages).find(m => m.nativeItemId === value.id && !m.kind);
        if (shown && (shown.projectContext || shown.handoffContext)) value.content = [
          {type:'text',text:shown.text,text_elements:[]}, ...(value.content || []).filter(part => part.type !== 'text')];
      }
      for (const item of Object.values(value)) if (typeof item === 'object') visit(item);
    };
    visit(copy); return copy;
  }
  broadcast(message) {
    const threadId = message.params?.threadId || message.params?.thread?.id;
    for (const session of this.sessions.values()) {
      if (threadId !== session.threadId) continue;
      // Unsupported native requests are rejected by Hydraq; never offer phantom approvals.
      if (message.id !== undefined && !this.codex.approvals.has(String(message.id))) continue;
      this.write(session.peer, message);
    }
  }
  respond(session, message) {
    const request = this.codex.approvals.get(String(message.id));
    if (!request || request.conversationId !== session.id || session.preparing) return;
    let result = message.result;
    if (!result || message.error) result = {decision: 'cancel', action: 'cancel'};
    if (request.method === 'tool/requestUserInput') result = {answers: Object.fromEntries(Object.entries(result.answers || {}).map(([id, value]) => [id, value.answers?.join('\n')]))};
    // Existing validator and synchronous removal make competing responses resolve once.
    this.codex.respond(String(message.id), result);

  }

  async input(conversation, input, {steer = false} = {}) {
    if (!Array.isArray(input) || !input.length) throw Error('Pedido sem conteúdo.');
    const texts = [], attachments = [];
    for (const part of input) {
      if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
      else if (!steer && part.type === 'localImage' && typeof part.path === 'string' && path.isAbsolute(part.path)) {
        if (attachments.length >= 4) throw Error('Anexa até quatro imagens por pedido.');
        const file = await open(part.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let bytes;
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw Error('Imagem inválida ou superior a 5 MB.');
          const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
          let size = 0;
          while (size < buffer.length) {
            const result = await file.read(buffer, size, buffer.length - size, null);
            if (!result.bytesRead) break;
            size += result.bytesRead;
          }
          bytes = buffer.subarray(0, size);
        } finally { await file.close(); }
        const saved = await this.hub.uploadAttachment(conversation.id, bytes, path.basename(part.path), inspectImage(bytes).mimeType);
        attachments.push(saved.id);
      } else throw Error('Este conteúdo ainda não é suportado pela ligação HYDRAQ. Usa texto ou uma imagem local num novo pedido.');
    }
    return {text: texts.join('\n'), attachments};
  }

  validateSettings(conversation, params) {
    if (params.cwd && params.cwd !== conversation.cwd) throw Error('A pasta desta sessão é fixa.');
    if (params.approvalPolicy != null && params.approvalPolicy !== 'on-request') throw Error('Mantém as autorizações em on-request.');
    if (params.approvalsReviewer != null && params.approvalsReviewer !== 'user') throw Error('As autorizações são decididas pelo utilizador.');
    if ([params.serviceTier, params.serviceTierForTurn].some(t => t != null && t !== 'default')) throw Error('Esta ligação usa o nível de serviço default.');
    for (const key of ['outputSchema', 'toolOutput', 'disabledPluginIds', 'personality', 'summary', 'additionalContext', 'environments', 'cyberAccessProgram'])
      if (params[key] != null) throw Error(`A opção ${key} ainda não é suportada por esta ligação.`);
    if (params.permissions != null || params.multiAgentMode != null || (params.runtimeWorkspaceRoots?.length))
      throw Error('Estas permissões ou agentes ainda não são suportados pela ligação HYDRAQ.');
    if (params.collaborationMode && (params.collaborationMode.mode !== 'default' || params.collaborationMode.settings?.developer_instructions))
      throw Error('Este modo de colaboração ainda não é suportado pela ligação HYDRAQ.');
    let sandbox;
    if (params.sandboxPolicy) {
      const policy = params.sandboxPolicy;
      if (policy.type === 'readOnly' && !policy.networkAccess) sandbox = 'read-only';
      else if (policy.type === 'workspaceWrite' && !policy.networkAccess &&
        (policy.writableRoots || []).every(root => root === conversation.cwd)) sandbox = 'workspace-write';
      else throw Error('Usa Só leitura ou Escrita no projeto; a ligação não alarga o acesso à máquina/rede.');
    }
    // The native protocol gives collaboration-mode settings precedence over
    // the top-level choices, including for the ordinary (default) TUI mode.
    return {model: params.collaborationMode?.settings?.model ?? params.model ?? undefined,
      effort: params.collaborationMode ? params.collaborationMode.settings?.reasoning_effort ?? undefined : params.effort ?? undefined, sandbox};
  }

  async dispatch(session, method, params, rpcId) {
    if (session.preparing || this.hub.closing) throw Error('O controlo está a mudar; nada foi enviado.');
    const c = this.codex.conversation(session.id);
    if (params.threadId && params.threadId !== session.threadId) throw Error('Esta ligação pertence apenas à conversa escolhida.');
    if (method === 'turn/start' || method === 'turn/steer') {
      if (params.threadId !== session.threadId) throw Error('Identificador de sessão inválido.');
      if (session.inflight) throw Error('Já há um pedido a ser admitido; aguarda a confirmação.');
      session.inflight = true;
      if (params.clientUserMessageId != null && (typeof params.clientUserMessageId !== 'string' || params.clientUserMessageId.length > 200)) { session.inflight = false; throw Error('Identificador de mensagem inválido.'); }
      const requestId = params.clientUserMessageId ? 'native:' + createHash('sha256').update(session.threadId + ':' + params.clientUserMessageId).digest('hex') : 'native-' + randomUUID();
      try {
        const settings = this.validateSettings(c, params);
        const input = await this.input(c, params.input, {steer: method === 'turn/steer'});
        if (method === 'turn/steer') {
          if (params.model || params.effort || params.sandboxPolicy) throw Error('Uma orientação não muda as definições do turno.');
          await this.hub.steer(c.id, input.text, requestId, params.expectedTurnId, undefined, this.permit);
          return {turnId: params.expectedTurnId};
        }
        const previous = c.turns.find(t => t.requestId === requestId);
        if (previous) {
          const message = c.messages.find(m => m.requestId === requestId && m.role === 'user');
          if (message?.text !== input.text.trim() || input.attachments.length ||
            (settings.model && settings.model !== previous.model) || (settings.effort && settings.effort !== previous.effort) || (settings.sandbox && settings.sandbox !== previous.sandbox)) throw Error('Identificador já usado para outro pedido. Nada foi reenviado.');
          if (!previous.id || previous.status === 'uncertain') throw Error('A entrega anterior está por confirmar. Nada foi reenviado.');
          return {turn: {id: previous.id, status: ['running','waiting','starting'].includes(previous.status) ? 'inProgress' : previous.status, items: [], error: null}};
        }
        const result = await this.hub.send(c.id, input.text, requestId, {...settings, attachments: input.attachments, nativePermit: this.permit});
        if (!result.nativeTurn) throw Error('O Codex não confirmou o turno. Não será reenviado.');
        const turn = c.turns.find(t => t.requestId === requestId); if (turn) turn.source = 'terminal';
        return {turn: result.nativeTurn};
      } finally { session.inflight = false; }
    }
    if (method === 'turn/interrupt') {
      if (params.turnId !== c.turnId) throw Error('O turno indicado já não está ativo.');
      await this.hub.interrupt(c.id); return {};
    }
    if (method === 'thread/resume') {
      if (params.threadId !== session.threadId || params.path || params.history) throw Error('Retoma apenas a sessão escolhida na HYDRAQ.');
      if (params.developerInstructions || params.baseInstructions) throw Error('As instruções desta sessão são preparadas pela HYDRAQ.');
      this.validateSettings(c, params);
      if ((params.model && params.model !== c.model) || (params.modelProvider && params.modelProvider !== 'openai') || (params.sandbox && params.sandbox !== c.sandbox))
        throw Error('Retoma com as definições da HYDRAQ; escolhe outro modelo ou acesso para o próximo pedido.');
      if (params.config && Object.keys(params.config).length) {
        const {config} = await this.codex.client.call('config/read', {cwd:c.cwd, includeLayers:false});
        for (const [key,value] of Object.entries(params.config)) {
          if (key !== 'web_search' || value !== (config.web_search ?? 'cached')) throw Error('Muda as configurações desta sessão na HYDRAQ antes de abrir o terminal.');
        }
      }
      const {thread} = await this.codex.client.call('thread/read', {threadId: session.threadId, includeTurns: !params.excludeTurns});
      const initialTurnsPage = params.initialTurnsPage == null ? null : await this.codex.client.call('thread/turns/list', {
        threadId:session.threadId, limit:params.initialTurnsPage.limit ?? 20,
        sortDirection:params.initialTurnsPage.sortDirection ?? 'desc', itemsView:params.initialTurnsPage.itemsView ?? 'summary'});
      return {thread, model: c.model, modelProvider: 'openai', cwd: c.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandbox: c.sandbox === 'read-only' ? {type: 'readOnly', networkAccess: false} : {type: 'workspaceWrite', writableRoots: [c.cwd], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true},
        reasoningEffort: c.effort, serviceTier: 'default', initialTurnsPage};
    }
    if (method === 'thread/read' || method === 'thread/turns/list' || method === 'thread/items/list') {
      if (params.threadId !== session.threadId) throw Error('Escolhe a conversa associada a esta ligação.');
      return this.codex.client.call(method, params);
    }
    if (method === 'thread/unsubscribe') return {status: 'unsubscribed'};
    if (method === 'thread/list') {
      const {thread} = await this.codex.client.call('thread/read', {threadId: session.threadId, includeTurns: false});
      return {data: [thread], nextCursor: null};
    }
    if (method === 'thread/loaded/list') return {data: [session.threadId], nextCursor: null};
    if (method === 'config/batchWrite') {
      const key = 'projects.' + JSON.stringify(c.cwd) + '.trust_level';
      if ((params.filePath != null && params.filePath !== path.join(this.codex.client.info.codexHome, 'config.toml')) || !Array.isArray(params.edits) || params.edits.length !== 1 ||
        params.edits[0].keyPath !== key || !['trusted','untrusted'].includes(params.edits[0].value) || params.edits[0].mergeStrategy !== 'replace')
        throw Error('A operação config/batchWrite não está disponível para estas opções. Só a confiança na pasta escolhida pode ser guardada pelo terminal.');
      return this.codex.client.call(method, {edits: params.edits, expectedVersion: params.expectedVersion, reloadUserConfig: false});
    }
    if (readMethods.has(method)) {
      if (method === 'config/read') params = {...params, cwd: c.cwd};
      if (['skills/list','hooks/list','plugin/list'].includes(method)) params = {...params, cwds: [c.cwd]};
      return this.codex.client.call(method, params);
    }
    throw Error(`A operação ${method} ainda não está disponível nesta ligação. Continua na HYDRAQ para gerir a sessão.`);
  }

  async list({cwd, cursor = null}) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw Error('Indica a pasta do projeto.');
    const page = await this.codex.client.call('thread/list', {cwd, cursor, modelProviders: ['openai'], limit: 30, useStateDbOnly: true});
    return {data: page.data.map(t => ({id: t.id, title: t.name || t.preview, cwd: t.cwd, updatedAt: t.updatedAt,
      imported: this.codex.conversations.some(c => c.threadId === t.id)})), nextCursor: page.nextCursor};
  }

  async import({threadId, cwd, projectId, revision}) {
    if (typeof threadId !== 'string' || !threadId || typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw Error('Escolhe uma sessão e pasta válidas.');
    const existing = this.codex.conversations.find(c => c.threadId === threadId);
    if (existing && existing.cwd !== cwd) throw Error('Esta sessão pertence a outra pasta.');
    if (existing) return {conversationId: existing.id, existing: true};
    this.hub.assertFree({cwd, projectId, resources: ['normal:codex']});
    const key = 'native-import:' + randomUUID();
    this.hub.reservations.set(key, {cwd, projectId, resources: ['normal:codex'], reason: 'A associar uma sessão Codex'});
    let chat;
    try {
      const {thread} = await this.codex.client.call('thread/read', {threadId, includeTurns: false});
      if (thread.cwd !== cwd || thread.modelProvider !== 'openai') throw Error('A sessão não corresponde à pasta ou ao fornecedor OpenAI.');
      // Acquire the native writer before adding local history. A live original client is never displaced.
      const resumed = await this.codex.client.call('thread/resume', {threadId, cwd, sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user', excludeTurns: true});
      chat = await this.hub.create({provider: 'codex', cwd, projectId, revision, model: resumed.model, effort: resumed.reasoningEffort || undefined, sandbox: 'read-only', nativeReservation: this.hub.reservations.get(key)});
      const c = this.codex.conversation(chat.id);
      c.threadId = threadId; c.title = thread.name || thread.preview?.slice(0, 66) || 'Sessão Codex';
      c.nativeSource = {threadId, cwd, interface: 'imported'};
      await this.codex.persist();
      await this.codex.reconcileNative(c.id);
      return {conversationId: c.id};
    } catch (error) {
      if (chat) { const c = this.codex.conversation(chat.id); c.status = 'uncertain'; c.error = 'Importação incompleta: ' + error.message; await this.codex.persist(); }
      throw error;
    } finally { this.hub.reservations.delete(key); this.changed(); }
  }

  async close() {
    await Promise.all([...this.sessions.values()].map(s => this.dispose(s)));
    this.codex?.off('approval-resolved', this.resolved);
    this.codex?.client?.off('notification', this.notification);
    this.codex?.client?.off('request', this.request);
    this.codex?.client?.off('disconnected', this.disconnected);
  }
}
