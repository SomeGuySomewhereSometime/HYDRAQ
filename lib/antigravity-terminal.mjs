import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { open, readFile, readdir, readlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { groupOf } from './handoff.mjs';

const busy = new Set(['starting', 'running', 'waiting', 'uncertain']);
const quote = value => /^[\w@%+=:,./-]+$/.test(value) ? value : "'" + String(value).replaceAll("'", "'\\''") + "'";
const decisions = body => new Set(Array.isArray(body?.confirm) ? body.confirm.filter(kind => kind === 'closed') : []);
/** HYDRAQ does not guess that the original client is closed: the person decides, with the reason shown. */
const needs = message => Object.assign(Error(message), { status: 409, code: 'TERMINAL_CONFIRM', confirm: 'closed' });
const NOT_IMPORTED = 'A resposta ficou no Antigravity original e não foi importada.';
const NONE_IMPORTED = 'As respostas ficaram no Antigravity original e não foram importadas.';
const HISTORY_LIMIT = 4_000_000;

/** Paths whose `git status --porcelain` line appeared, changed or disappeared between two readings. */
export function gitChanges(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return null;
  const old = new Set(before), now = new Set(after);
  return [...new Set([...after.filter(line => !old.has(line)), ...before.filter(line => !now.has(line))].map(line => line.slice(3).trim()).filter(Boolean))];
}

/** Requests typed in the original agy for one conversation, from its prompt history; slash commands are left out. */
export function terminalPrompts(text, conversationId, sinceMs) {
  const prompts = [];
  for (const line of String(text).split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.conversationId !== conversationId || entry.type === 'slash_command' || typeof entry.display !== 'string' || !entry.display.trim()) continue;
    if (!Number.isFinite(entry.timestamp) || entry.timestamp < sinceMs) continue;
    prompts.push({ text: entry.display, timestamp: entry.timestamp });
  }
  return prompts;
}

/**
 * Hands an Antigravity conversation to the original agy and back. The TUI keeps the same native
 * conversation, so agy itself remembers everything; HYDRAQ can only read the requests typed there
 * (agy's prompt history) and what git saw change. Answers, decisions and command results stay in
 * agy and are marked as not imported, for this conversation and for the other models of the group.
 */
export class AntigravityTerminal {
  constructor(hub, { home = process.env.HYDRAQ_AGY_HOME || path.join(os.homedir(), '.gemini/antigravity-cli') } = {}) {
    Object.assign(this, { hub, home });
    this.pending = new Set();
  }
  get client() { return this.hub.clients.antigravity; }
  changed() { this.hub.emit('state', this.hub.snapshot()); }
  snapshot() { return { available: Boolean(this.client?.models) && process.platform === 'linux', pending: [...this.pending] }; }
  terminals() { return this.client?.conversations.filter(c => c.terminal) || []; }
  // The TUI is its own process: it holds the project, not HYDRAQ's agy for other folders.
  scopes() { return this.terminals().map(c => ({ ...this.hub.scopeFor(c, 'antigravity'), resources: [], kind: 'terminal', reason: 'Antigravity original no terminal' })); }
  assertControl(id) {
    const conversation = this.hub.conversations().find(c => c.id === id);
    if (conversation && this.terminals().some(c => groupOf(c) === groupOf(conversation)))
      throw Object.assign(Error('Esta conversa está no Antigravity original (terminal). Sai do agy (/exit) e usa «Continuar na HYDRAQ» antes de enviar daqui.'), { status: 409 });
  }

  /** The same conversation, model, folder and restrictions as HYDRAQ's own agy process. */
  argv(c) {
    const model = this.client.models.find(m => m.id === c.model), slug = model?.slugs?.[c.effort] || model?.slugs?.[model?.defaultEffort];
    const args = ['--conversation', c.threadId];
    if (slug) args.push('--model', slug);
    args.push('--sandbox');
    if (c.sandbox === 'plan') args.push('--mode', 'plan');
    else if (c.sandbox === 'accept-edits') args.push('--mode', 'accept-edits');
    return args;
  }
  info(c) {
    const command = ['cd', quote(c.cwd), '&&', quote(this.client.executable), ...this.client.prefixArgs.map(quote), ...this.argv(c).map(quote)].join(' ');
    return { conversationId: c.id, command, since: c.terminal.since };
  }
  historyFile() { return path.join(this.home, 'history.jsonl'); }
  async historySize() { return (await stat(this.historyFile()).catch(() => null))?.size || 0; }
  async readHistory(offset) {
    const size = await this.historySize();
    // A shorter file was rewritten by agy: read it whole and rely on the time filter.
    const from = size >= offset ? offset : 0, length = Math.min(size - from, HISTORY_LIMIT);
    if (length <= 0) return '';
    const handle = await open(this.historyFile(), 'r');
    try { const buffer = Buffer.alloc(length); await handle.read(buffer, 0, length, size - length); return buffer.toString('utf8'); }
    finally { await handle.close(); }
  }
  /** Changes when agy writes to the conversation, whether or not a request reached the prompt history. */
  async store(threadId) {
    const file = path.join(this.home, 'conversations', threadId + '.db');
    const parts = await Promise.all([file, file + '-wal'].map(name => stat(name).then(info => `${info.mtimeMs}:${info.size}`, () => '-')));
    return parts.join('|');
  }
  async gitStatus(cwd) { try { return await this.hub.git(cwd); } catch { return null; } }

  /**
   * agy processes that hold the conversation: its ID in their arguments. A plain `agy` (or `-c`) in the
   * same folder may have opened it from inside the TUI, so it counts as unsure, never as closed.
   */
  async holders(c) {
    const found = [], unsure = [];
    if (process.platform !== 'linux') return { found, unsure, unknown: true };
    for (const pid of await readdir('/proc').catch(() => [])) {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0').filter(Boolean);
      const own = this.client.executable !== process.execPath && argv[0] === this.client.executable;
      if (!argv.length || (path.basename(argv[0]) !== 'agy' && !own)) continue;
      if (argv.includes(c.threadId) || argv.includes('--conversation=' + c.threadId)) { found.push(Number(pid)); continue; }
      if (argv.some(arg => arg === '--conversation' || arg.startsWith('--conversation=') || ['-p', '--print', '--prompt', 'models'].includes(arg))) continue;
      if (await readlink(`/proc/${pid}/cwd`).catch(() => null) === c.cwd) unsure.push(Number(pid));
    }
    return { found, unsure };
  }

  async open(id, { launch = true } = {}) {
    if (this.hub.closing) throw Error('A HYDRAQ está a encerrar.');
    if (process.platform !== 'linux') throw Error('A passagem para o terminal do Antigravity só está disponível em Linux nesta versão.');
    const client = this.client, c = client.conversation(id);
    if (c.terminal) return this.info(c);
    if (this.pending.has(id)) throw Error('A passagem para o terminal já está a ser preparada.');
    this.hub.nativeSessions.assertControl(id); this.hub.assertTerminal?.(id);
    if (!c.threadId || !c.turns.length) throw Error('Envia primeiro um pedido nesta conversa para o agy guardar a sessão.');
    if (busy.has(c.status)) throw Error('Aguarda a conclusão da tarefa antes de mudar de interface.');
    if (client.connection !== 'connected') throw Error('Liga primeiro o Antigravity.');
    const scope = { ...this.hub.scopeFor(c, 'antigravity'), resources: [] }, key = 'antigravity-terminal:' + id;
    this.hub.assertFree(scope);
    this.pending.add(id);
    this.hub.reservations.set(key, { ...scope, reason: 'A preparar o Antigravity original' });
    this.changed();
    try {
      await this.hub.projects.assertUsable(groupOf(c), this.hub.conversations().filter(m => groupOf(m) === groupOf(c)));
      await client.releaseSession(id);
      const { found } = await this.holders(c);
      if (found.length) throw Error(`Esta conversa já está aberta noutro agy (processo ${found[0]}). Fecha-o primeiro.`);
      // Where the terminal starts: what was already in the prompt history, the native store and git.
      c.terminal = { since: new Date().toISOString(), conversationId: c.threadId, history: await this.historySize(), store: await this.store(c.threadId), git: await this.gitStatus(c.cwd) };
      let info;
      try { info = this.info(c); await client.persist(); } catch (error) { delete c.terminal; throw error; }
      client.changed();
      if (launch) info.warning = await this.launch(c);
      return info;
    } finally { this.pending.delete(id); this.hub.reservations.delete(key); this.changed(); }
  }

  async launch(c) {
    try {
      const child = spawn('x-terminal-emulator', ['-e', this.client.executable, ...this.client.prefixArgs, ...this.argv(c)], { cwd: c.cwd, env: this.client.env, stdio: 'ignore', detached: true });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      return null;
    } catch { return 'Não foi possível abrir uma janela de terminal. Copia o comando para o teu terminal.'; }
  }

  /**
   * Returns control once no agy holds the conversation (or the person confirms it). The requests typed
   * there come back as this conversation's turns, each marked as answered outside HYDRAQ; git changes
   * go with the last one. Nothing is sent to agy and nothing is imported twice.
   */
  async release(id, body = {}) {
    const client = this.client, c = client.conversation(id), confirmed = decisions(body);
    if (!c.terminal) return { released: true, imported: 0 };
    if (this.pending.has(id)) throw Error('A conversa já está a ser recuperada.');
    this.pending.add(id); this.changed();
    try {
      const { found, unsure, unknown } = await this.holders(c);
      if (found.length) throw Object.assign(Error(`O Antigravity original ainda tem esta conversa aberta (processo ${found[0]}). Sai com /exit ou fecha o terminal e volta a tentar.`), { status: 409 });
      if ((unsure.length || unknown) && !confirmed.has('closed'))
        throw needs(unknown ? 'Não foi possível confirmar que o agy está fechado. Confirma que saíste do Antigravity original antes de continuar.'
          : `Há um agy aberto nesta pasta (processo ${unsure[0]}) que pode estar a usar esta conversa. Fecha-o, ou confirma que não é esta conversa.`);
      const sinceMs = Date.parse(c.terminal.since);
      const prompts = terminalPrompts(await this.readHistory(c.terminal.history), c.terminal.conversationId, sinceMs);
      const touched = (await this.store(c.terminal.conversationId)) !== c.terminal.store;
      const files = gitChanges(c.terminal.git, await this.gitStatus(c.cwd));
      const added = [];
      const add = (text, timestamp, extra = {}) => {
        const at = new Date(timestamp).toISOString(), requestId = `terminal:${c.terminal.conversationId}:${timestamp}`;
        if (c.turns.some(turn => turn.requestId === requestId)) return;
        const turn = { id: randomUUID(), requestId, source: 'terminal', partial: 'terminal', model: c.model, effort: c.effort, sandbox: c.sandbox, status: 'completed', delivery: 'accepted',
          startedAt: at, completedAt: at, usage: null, usageUnavailable: 'Pedido feito no Antigravity original; o consumo fica registado nessa sessão.',
          facts: { version: 2, source: 'git', files: [], commands: [], declined: 0, error: null, capturedAt: new Date().toISOString() }, ...extra };
        c.turns.push(turn);
        c.messages.push({ id: randomUUID(), requestId, role: 'user', text, at, source: 'terminal', turnId: turn.id, model: c.model, effort: c.effort, terminalNote: NOT_IMPORTED });
        added.push(turn);
      };
      for (const prompt of prompts) add(prompt.text, prompt.timestamp);
      if (!prompts.length && touched) add('(Atividade no Antigravity original sem pedido registado no histórico do agy.)', Date.now(), { terminalUnknown: true });
      const notes = [];
      if (added.length) {
        const last = added.at(-1);
        if (files?.length) last.facts.files = files;
        const message = c.messages.findLast(m => m.turnId === last.id);
        message.terminalNote = [added.length > 1 ? NONE_IMPORTED : NOT_IMPORTED,
          files === null ? 'O git não estava disponível para ver os ficheiros alterados.' : files.length ? `Ficheiros alterados durante o terminal (vistos pelo git): ${files.slice(0, 40).join(', ')}${files.length > 40 ? ` (+${files.length - 40})` : ''}.` : 'O git não viu ficheiros alterados.'].join(' ');
        c.updatedAt = new Date().toISOString();
      } else if (files?.length) notes.push('O git mostra alterações nesta pasta, mas o agy não registou atividade nesta conversa; não foram atribuídas ao Antigravity.');
      if (confirmed.has('closed')) notes.push('Confirmaste que o Antigravity original estava fechado sem verificação.');
      delete c.terminal;
      await client.persist(); client.changed();
      return { released: true, imported: added.length, warning: notes.join(' ') || null };
    } finally { this.pending.delete(id); this.changed(); }
  }
}
