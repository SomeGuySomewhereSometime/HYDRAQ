import path from 'node:path';
import { spawn } from 'node:child_process';
import { access, lstat, readdir, realpath, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { groupOf } from './handoff.mjs';
import { SESSION_ID, projectDirectory, sampleTranscript, sessionSummary, activeChain } from './claude-transcript.mjs';
import { CONTEXT_TOOLS } from './context-mcp.mjs';

const busy = new Set(['starting', 'running', 'waiting', 'uncertain']);
const modes = { 'workspace-write': 'default', 'accept-edits': 'acceptEdits', plan: 'plan' };
const quote = value => /^[\w@%+=:,./-]+$/.test(value) ? value : "'" + String(value).replaceAll("'", "'\\''") + "'";
const LISTED = 300, PAGE = 30;
const decisions = body => new Set(Array.isArray(body?.confirm) ? body.confirm.filter(kind => ['closed', 'history'].includes(kind)) : []);
/** An explicit decision is needed: HYDRAQ does not guess that a session is closed or a history complete. */
const needs = (kind, message) => Object.assign(Error(message), { status: 409, code: 'CLAUDE_CONFIRM', confirm: kind });
const incomplete = transcript => !transcript
  ? needs('history', 'Não encontrei a transcrição nativa desta sessão. Se continuares, a HYDRAQ não importa o que foi feito no Claude original e o Claude segue com o histórico que tiver.')
  : needs('history', `${transcript.skipped} linha(s) da transcrição nativa não puderam ser lidas. Se continuares, os pedidos afetados podem faltar na HYDRAQ.`);

/**
 * Hands a Claude session to the original client and back. The TUI runs outside HYDRAQ, so nothing is
 * mirrored live: the group stays reserved until the person returns and the new requests are read from
 * the native transcript. HYDRAQ never writes to a session that another Claude process holds.
 */
export class ClaudeTerminal {
  constructor(hub) { this.hub = hub; this.pending = new Set(); }
  get claude() { return this.hub.clients.claude; }
  changed() { this.hub.emit('state', this.hub.snapshot()); }
  snapshot() { return { available: Boolean(this.claude) && process.platform !== 'win32', pending: [...this.pending] }; }
  terminals() { return this.claude?.conversations.filter(c => c.terminal) || []; }
  // The TUI is its own process: it holds the project, not HYDRAQ's Claude process for other folders.
  scopes() { return this.terminals().map(c => ({ ...this.hub.scopeFor(c, 'claude'), resources: [], kind: 'terminal', reason: 'Claude original no terminal' })); }

  assertControl(id) {
    const conversation = this.hub.conversations().find(c => c.id === id);
    if (conversation && this.terminals().some(c => groupOf(c) === groupOf(conversation)))
      throw Object.assign(Error('Esta conversa está no Claude original (terminal). Sai do Claude e usa «Continuar na HYDRAQ» antes de enviar daqui.'), { status: 409 });
  }

  async argv(c) {
    const args = ['--resume', c.threadId], model = this.claude.models.find(m => m.id === c.model);
    if (model) args.push('--model', model.id);
    if (model?.efforts.includes(c.effort)) args.push('--effort', c.effort);
    args.push('--permission-mode', modes[c.sandbox] || 'default');
    // The same four read-only memory tools HYDRAQ's own process pre-approves; personal MCP servers stay.
    const server=c.terminal?.mcpServer||c.contextMcpName;
    if(c.terminal?.mcpConfigFile&&/^hydraq_[a-f0-9]{12}$/.test(server||'')&&this.hub.contextMcp.terminalAccess(c,this.hub.projects.group(groupOf(c))?.projectId))
      args.push('--mcp-config',c.terminal.mcpConfigFile,'--allowedTools',CONTEXT_TOOLS.map(name=>`mcp__${server}__${name}`).join(','));
    // Same project instructions as the HYDRAQ process (Claude Code reads CLAUDE.md, not AGENTS.md).
    const exists = name => access(path.join(c.cwd, name)).then(() => true, () => false);
    if (await exists('AGENTS.md') && !await exists('CLAUDE.md')) args.push('--append-system-prompt', 'Este projeto tem instruções em AGENTS.md na raiz. Lê esse ficheiro antes de trabalhar e segue-o como instruções do projeto.');
    return args;
  }
  async info(c) {
    await this.prepareMcp(c);
    const command = ['cd', quote(c.cwd), '&&', quote(this.claude.executable), ...this.claude.prefixArgs.map(quote), ...(await this.argv(c)).map(quote)].join(' ');
    return { conversationId: c.id, command, since: c.terminal.since };
  }

  async prepareMcp(c){
    const projectId=this.hub.projects.group(groupOf(c))?.projectId;
    // A revoked terminal keeps its configuration: the helper then explains why access ended.
    if(!projectId||c.terminal?.mcpProjectId!==projectId||this.hub.contextMcp.revocation(c))return;
    const config=await this.hub.contextMcp.issue(c);if(!config)throw Error('O servidor de memória HYDRAQ ainda não está disponível.');
    const file=config.file+'.claude.json',temp=file+'.'+randomUUID()+'.tmp';
    try{const info=await lstat(file);if(info.isSymbolicLink()||!info.isFile()||(info.mode&0o077))throw Error('Configuração MCP privada inválida.');}catch(error){if(error.code!=='ENOENT')throw error;}
    try{await writeFile(temp,JSON.stringify({mcpServers:{[config.name]:{command:config.command,args:config.args,env:config.env}}}),{mode:0o600,flag:'wx'});await rename(temp,file);}finally{await unlink(temp).catch(()=>{});}
    c.terminal.mcpConfigFile=file;c.terminal.mcpServer=config.name;
  }

  async open(id, { launch = true } = {}) {
    if (this.hub.closing) throw Error('A HYDRAQ está a encerrar.');
    if (process.platform === 'win32') throw Error('A passagem para o terminal ainda não está disponível no Windows.');
    const claude = this.claude, c = claude.conversation(id);
    if (c.terminal) return this.info(c);
    if (this.pending.has(id)) throw Error('A passagem para o terminal já está a ser preparada.');
    if (!c.sessionStarted || !c.turns.length) throw Error('Envia primeiro um pedido nesta conversa para o Claude Code guardar a sessão.');
    if (busy.has(c.status) || [...claude.approvals.values()].some(request => request.conversationId === id))
      throw Error('Aguarda a conclusão da tarefa e das decisões pendentes antes de mudar de interface.');
    const scope = { ...this.hub.scopeFor(c, 'claude'), resources: [] }, key = 'claude-terminal:' + id;
    this.hub.assertFree(scope);
    this.pending.add(id);
    this.hub.reservations.set(key, { ...scope, reason: 'A preparar o Claude original' });
    this.changed();
    try {
      await this.hub.projects.assertUsable(groupOf(c), this.hub.conversations().filter(m => groupOf(m) === groupOf(c)));
      await claude.releaseSession(id);
      const transcript = await claude.transcript(c.threadId, c.cwd);
      if (!transcript) throw Error('O Claude Code ainda não guardou esta sessão no disco. Envia um pedido e volta a tentar.');
      // The baseline is the last entry HYDRAQ knows; everything after it comes from the terminal.
      c.terminal = { since: new Date().toISOString(), sessionId: c.threadId, leaf: activeChain(transcript.entries).at(-1)?.uuid || null, lines: transcript.entries.length, mcpProjectId:this.hub.projects.group(groupOf(c))?.projectId||null };
      let info;
      try{info=await this.info(c);await claude.persist();}catch(error){delete c.terminal;throw error;}
      claude.changed();
      if (launch) info.warning = await this.launch(c);
      return info;
    } finally { this.pending.delete(id); this.hub.reservations.delete(key); this.changed(); }
  }

  async launch(c) {
    try {
      const child = spawn('x-terminal-emulator', ['-e', this.claude.executable, ...this.claude.prefixArgs, ...await this.argv(c)], { cwd: c.cwd, env: this.claude.env, stdio: 'ignore', detached: true });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      return null;
    } catch { return 'Não foi possível abrir uma janela de terminal. Copia o comando para o teu terminal.'; }
  }

  /** Returns control only when no Claude holds the session and the history was read in full, or the
   * person explicitly accepted continuing without that certainty (`confirm`). Otherwise the
   * conversation stays in the terminal and nothing is imported. */
  async release(id, body = {}) {
    const claude = this.claude, c = claude.conversation(id), confirmed = decisions(body);
    if (!c.terminal) return { released: true, imported: 0 };
    if (this.pending.has(id)) throw Error('A sessão já está a ser recuperada.');
    this.pending.add(id); this.changed();
    try {
      const open = await claude.sessionOpen(c.terminal.sessionId, { unverified: confirmed.has('closed') });
      if (open) throw Object.assign(Error(`O Claude original ainda tem esta sessão aberta (processo ${open.pid}). Sai com /exit ou fecha o terminal e volta a tentar.`), { status: 409 });
      c.terminal.returning=true;await this.hub.contextMcp.drain(c.id);
      const transcript = await claude.transcript(c.terminal.sessionId, c.cwd);
      if ((!transcript || transcript.skipped) && !confirmed.has('history')) throw incomplete(transcript);
      const result = transcript ? await claude.importNative(id, c.terminal, transcript) : { turns: 0, missing: true };
      if(c.terminal.contextReads?.length){c.unattributedContextReads||=[];for(const read of c.terminal.contextReads)if(!c.unattributedContextReads.some(old=>old.id===read.id)){if(c.unattributedContextReads.length<1000)c.unattributedContextReads.push({...read,association:'unidentified-request'});else c.unattributedContextReadsOmitted=(c.unattributedContextReadsOmitted||0)+1;}}
      if(c.terminal.contextReadsOmitted)c.unattributedContextReadsOmitted=(c.unattributedContextReadsOmitted||0)+c.terminal.contextReadsOmitted;
      const notes = [result.missing && 'Continuaste sem a transcrição nativa: nada do Claude original foi importado.',
        result.skipped && `Continuaste com ${result.skipped} linha(s) da transcrição por ler: podem faltar pedidos.`,
        confirmed.has('closed') && 'Confirmaste que o Claude original estava fechado sem verificação do CLI.'].filter(Boolean);
      if (notes.length) c.error = [c.error, ...notes].filter(Boolean).join(' ');
      if (result.rewound) notes.push('A conversa foi rebobinada no terminal: o histórico anterior continua visível aqui, mas o Claude continua a partir desse ponto.');
      delete c.terminal;
      this.hub.contextMcp.resumeExpiry(c.id);
      await claude.persist(); claude.changed();
      return { released: true, imported: result.turns, warning: notes.join(' ') || null };
    } finally { if(c.terminal)delete c.terminal.returning;this.pending.delete(id); this.changed(); }
  }

  /** Claude Code sessions saved for this folder by the terminal or the apps; HYDRAQ's own and other
   * programmatic sessions are left out. */
  async list({ cwd, cursor = 0 }) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.length > 4096) throw Error('Indica a pasta do projeto.');
    const folder = await realpath(cwd).catch(() => path.resolve(cwd)), directory = projectDirectory(this.claude.env, folder);
    const names = (await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).filter(name => name.endsWith('.jsonl') && SESSION_ID.test(name.slice(0, -6)));
    const files = (await Promise.all(names.map(async name => { const file = path.join(directory, name), info = await lstat(file).catch(() => null); return info?.isFile() ? { id: name.slice(0, -6), file, info } : null; })))
      .filter(Boolean).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, LISTED);
    const data = [];
    let index = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0;
    for (; index < files.length && data.length < PAGE; index++) {
      const { id, file, info } = files[index], summary = sessionSummary(await sampleTranscript(file, info.size).catch(() => []));
      if (!summary.external || (summary.cwd && summary.cwd !== folder)) continue;
      const owner = this.claude.conversations.find(c => c.threadId === id);
      data.push({ id, title: summary.title || 'Sessão sem título', source: summary.source, updatedAt: new Date(info.mtimeMs).toISOString(), imported: Boolean(owner), conversationId: owner?.id || null });
    }
    return { data, nextCursor: index < files.length ? index : null };
  }

  async import({ sessionId, cwd, projectId = null, revision, confirm }) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw Error('Escolhe uma sessão e uma pasta válidas.');
    const claude = this.claude, folder = await realpath(cwd);
    const existing = claude.conversations.find(c => c.threadId === sessionId);
    if (existing) { if (existing.cwd !== folder) throw Error('Esta sessão pertence a outra pasta.'); return { conversationId: existing.id, existing: true }; }
    const scope = { cwd: folder, projectId, resources: [] }, key = 'claude-import:' + randomUUID();
    this.hub.assertFree(scope);
    this.hub.reservations.set(key, { ...scope, reason: 'A associar uma sessão Claude' });
    this.changed();
    let chat;
    try {
      const transcript = await claude.transcript(sessionId, folder);
      if (!transcript) throw Error('Não encontrei esta sessão na pasta indicada.');
      const summary = sessionSummary(transcript.entries);
      if (summary.cwd && summary.cwd !== folder) throw Error('A sessão não pertence a esta pasta.');
      const confirmed = decisions({ confirm });
      if (transcript.skipped && !confirmed.has('history')) throw incomplete(transcript);
      const open = await claude.sessionOpen(sessionId, { unverified: confirmed.has('closed') });
      if (open) throw Error(`A sessão está aberta noutro Claude (processo ${open.pid}). Fecha-a primeiro no cliente original.`);
      const model = claude.models.find(m => summary.model?.startsWith(String(m.resolvedModel).replace(/\[.*\]$/, ''))) || claude.models.find(m => m.isDefault);
      chat = await this.hub.create({ provider: 'claude', cwd: folder, projectId: projectId || undefined, revision, model: model?.id, effort: model?.defaultEffort, sandbox: 'workspace-write', nativeReservation: this.hub.reservations.get(key) });
      const c = claude.conversation(chat.id);
      Object.assign(c, { threadId: sessionId, sessionStarted: true, title: summary.title || 'Sessão Claude', nativeSource: { sessionId, cwd: folder, interface: 'imported', source: summary.source } });
      const result = await claude.importNative(c.id, {}, transcript);
      if (result.skipped) { c.error = `Associada com ${result.skipped} linha(s) da transcrição por ler: podem faltar pedidos.`; await claude.persist(); claude.changed(); }
      return { conversationId: c.id, imported: result.turns, warning: result.skipped ? c.error : null };
    } catch (error) {
      if (chat) { const c = claude.conversation(chat.id); c.status = 'failed'; c.error = 'Associação incompleta: ' + error.message; await claude.persist(); claude.changed(); }
      throw error;
    } finally { this.hub.reservations.delete(key); this.changed(); }
  }
}
