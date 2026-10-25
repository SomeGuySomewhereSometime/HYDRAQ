import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { open, readFile, readdir, readlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { groupOf } from './handoff.mjs';
import { readSteps, lastStep, stepTurns } from './antigravity-steps.mjs';

const busy = new Set(['starting', 'running', 'waiting', 'uncertain']);
const quote = value => /^[\w@%+=:,./-]+$/.test(value) ? value : "'" + String(value).replaceAll("'", "'\\''") + "'";
const decisions = body => new Set(Array.isArray(body?.confirm) ? body.confirm.filter(kind => kind === 'closed') : []);
/** HYDRAQ does not guess that the original client is closed: the person decides, with the reason shown. */
const needs = message => Object.assign(Error(message), { status: 409, code: 'TERMINAL_CONFIRM', confirm: 'closed' });
const NOT_IMPORTED = 'A resposta ficou no Antigravity original e não foi importada.';
const NONE_IMPORTED = 'As respostas ficaram no Antigravity original e não foram importadas.';
const HISTORY_LIMIT = 4_000_000;
const UNCONFIRMED = 'O agy não confirmou a conclusão deste pedido (pode ter sido interrompido no terminal): o texto e as ações podem estar incompletos.';
const RECOVERY_WINDOW = 5000;
const FILE_TOOLS = new Set(['write_to_file', 'write_file', 'replace_file_content', 'multi_replace_file_content', 'edit_file', 'create_file', 'delete_file']);
/**
 * What the tool calls of a request did, as far as agy recorded each result: a file counts as changed only
 * when its write succeeded; a refused write or one without a result is an attempt, never a change.
 */
function toolFacts(tools, cwd) {
  // Paths inside the project are written as git shows them, so one file is not listed twice.
  const local = file => path.isAbsolute(file) && file.startsWith(cwd + path.sep) ? path.relative(cwd, file) : file;
  const target = tool => tool.args.TargetFile || tool.args.Path || tool.args.file_path || tool.args.path;
  const failure = tool => tool.result ? `recusado: ${tool.result.error || 'erro registado pelo agy'}` : 'sem resultado registado';
  const writes = tools.filter(tool => FILE_TOOLS.has(tool.name) && typeof target(tool) === 'string');
  return {
    files: [...new Set(writes.filter(tool => tool.result?.ok).map(tool => local(target(tool))))],
    attempted: writes.filter(tool => !tool.result?.ok).map(tool => ({ file: local(target(tool)), result: failure(tool) })),
    commands: tools.filter(tool => tool.name === 'run_command' && typeof (tool.args.CommandLine || tool.args.command) === 'string')
      .map(tool => ({ command: tool.args.CommandLine || tool.args.command, exitCode: null, status: tool.result?.ok ? 'executado (saída não lida)' : tool.result ? failure(tool).replace('recusado', 'falhou') : 'sem resultado registado' })),
  };
}

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
 * conversation, so agy itself remembers everything. Coming back, HYDRAQ reads agy's record of the
 * conversation for the requests, answers and tool calls made there. When that record cannot be read
 * in full, only the requests typed there (agy's prompt history) and what git saw change come back,
 * marked as answered outside HYDRAQ for this conversation and for the other models of the group.
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
  storeFile(threadId) { return path.join(this.home, 'conversations', threadId + '.db'); }
  /** Changes when agy writes to the conversation, whether or not a request reached the prompt history. */
  async store(threadId) {
    const file = this.storeFile(threadId);
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
    let pids;
    // Processes that cannot be read are unknown, never closed.
    try { pids = await readdir('/proc'); } catch { return { found, unsure, unknown: true }; }
    for (const pid of pids) {
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

  async open(id, { launch = true, confirm } = {}) {
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
      const { found, unsure, unknown } = await this.holders(c);
      if (found.length) throw Error(`Esta conversa já está aberta noutro agy (processo ${found[0]}). Fecha-o primeiro.`);
      // A second agy on the same conversation would write to it alongside the first: the person decides.
      if ((unsure.length || unknown) && !decisions({ confirm }).has('closed'))
        throw needs(unknown ? 'Não foi possível verificar se outro agy tem esta conversa aberta. Confirma que não está aberta noutro terminal antes de continuar.'
          : `Há um agy aberto nesta pasta (processo ${unsure[0]}) que pode já ter esta conversa aberta: abrir outro poria os dois a escrever nela. Fecha-o, ou confirma que não é esta conversa.`);
      // Where the terminal starts: what was already in the prompt history, the native store and git.
      c.terminal = { since: new Date().toISOString(), conversationId: c.threadId, history: await this.historySize(), store: await this.store(c.threadId), steps: await lastStep(this.storeFile(c.threadId)), git: await this.gitStatus(c.cwd) };
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
   * Returns control once no agy holds the conversation (or the person confirms it). The requests made
   * there come back as this conversation's turns, with agy's answers when its record can be read; git
   * changes are reported for the whole stay. Nothing is sent to agy and nothing is imported twice.
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
      const sinceMs = Date.parse(c.terminal.since), thread = c.terminal.conversationId;
      const prompts = terminalPrompts(await this.readHistory(c.terminal.history), thread, sinceMs);
      const touched = (await this.store(thread)) !== c.terminal.store;
      const files = gitChanges(c.terminal.git, await this.gitStatus(c.cwd));
      let steps = null;
      try { steps = await readSteps(this.storeFile(thread)); } catch { steps = null; }
      const base = c.terminal.steps;
      const fresh = step => Number.isInteger(base) ? step.idx > base : Boolean(step.at) && Date.parse(step.at) >= sinceMs - 1000;
      const turns = steps && stepTurns(steps.filter(fresh));
      // The prompt history is a second witness: a request it saw that agy's record lacks means the reading is incomplete.
      const complete = Boolean(turns) && turns.filter(turn => turn.prompt).length >= prompts.length;
      const added = [], notes = [];
      const record = (requestId, at, end, extra) => {
        const turn = { id: randomUUID(), requestId, source: 'terminal', model: c.model, effort: c.effort, sandbox: c.sandbox, status: 'completed', delivery: 'accepted',
          startedAt: at, completedAt: end, usage: null, usageUnavailable: 'Pedido feito no Antigravity original; o consumo fica registado nessa sessão.',
          facts: { version: 2, files: [], commands: [], declined: 0, error: null, capturedAt: new Date().toISOString() }, ...extra };
        c.turns.push(turn); added.push(turn); return turn;
      };
      // Only a request agy finished has a final answer; otherwise every text is progress.
      const answers = (turn, steps, done) => steps.forEach((step, index) => c.messages.push({ id: randomUUID(), requestId: turn.requestId, role: 'assistant', text: step.text, at: step.at || turn.completedAt,
        source: 'terminal', turnId: turn.id, model: c.model, effort: c.effort, phase: done && index === steps.length - 1 ? 'final_answer' : 'commentary' }));
      const outcome = entry => entry.complete ? { finalAnswer: entry.answers.at(-1).text } : { status: 'interrupted', unconfirmed: true };
      if (complete) for (const entry of turns) {
        const requestId = `terminal:${thread}:step-${entry.start}`;
        if (c.turns.some(turn => turn.requestId === requestId)) continue;
        const at = entry.prompt?.at || entry.answers[0]?.at || new Date().toISOString(), last = entry.answers.at(-1);
        const turn = record(requestId, at, last?.at || at, { ...outcome(entry), nativeStep: { conversationId: thread, index: entry.start } });
        Object.assign(turn.facts, toolFacts(entry.tools, c.cwd));
        c.messages.push({ id: randomUUID(), requestId, role: 'user', text: entry.prompt?.text ?? '(Continuação no Antigravity original, sem pedido novo.)', at, source: 'terminal', turnId: turn.id, model: c.model, effort: c.effort, ...(entry.complete ? {} : { terminalNote: UNCONFIRMED }) });
        answers(turn, entry.answers, entry.complete);
      } else {
        const add = (text, timestamp, extra = {}) => {
          const at = new Date(timestamp).toISOString(), requestId = `terminal:${thread}:${timestamp}`;
          if (c.turns.some(turn => turn.requestId === requestId)) return;
          const turn = record(requestId, at, at, { partial: 'terminal', ...extra });
          c.messages.push({ id: randomUUID(), requestId, role: 'user', text, at, source: 'terminal', turnId: turn.id, model: c.model, effort: c.effort, terminalNote: NOT_IMPORTED });
        };
        for (const prompt of prompts) add(prompt.text, prompt.timestamp);
        if (!prompts.length && touched) add('(Atividade no Antigravity original sem pedido registado no histórico do agy.)', Date.now(), { terminalUnknown: true });
        if (added.length) notes.push('Não foi possível ler as respostas no registo do agy: ficaram só os pedidos.');
      }
      // Requests brought back earlier without their answers get them now, when agy's record has them. The
      // prompt history and the record agree to the millisecond: a request takes the closest step with the
      // same text, a step serves one request only across returns/restarts, and a tie leaves the request as it was.
      const earlier = steps ? stepTurns(steps.filter(step => !fresh(step))) : [], used = new Set();
      const prefix = `terminal:${thread}:step-`;
      for (const turn of c.turns) {
        if (turn.nativeStep?.conversationId === thread && Number.isSafeInteger(turn.nativeStep.index) && turn.nativeStep.index >= 0)
          used.add(turn.nativeStep.index);
        // Older normal imports already encode the native index in their request ID.
        const encoded = turn.requestId?.startsWith(prefix) ? turn.requestId.slice(prefix.length) : '';
        if (/^\d+$/.test(encoded) && Number.isSafeInteger(Number(encoded))) used.add(Number(encoded));
        if (!turn.recovered || turn.nativeStep) continue;
        // Old recoveries did not save an index. Reserve every compatible candidate rather than lend
        // an answer already imported to another request; ambiguous history stays partial.
        const message = c.messages.find(m => m.turnId === turn.id && m.role === 'user');
        if (!message) continue;
        for (const entry of earlier) if (entry.prompt && entry.answers.length && entry.prompt.text.trim() === message.text.trim()
          && Math.abs(Date.parse(entry.prompt.at) - Date.parse(turn.startedAt)) <= RECOVERY_WINDOW) used.add(entry.start);
      }
      let recovered = 0;
      for (const turn of c.turns.filter(entry => entry.partial === 'terminal' && !entry.terminalUnknown && !added.includes(entry))) {
        const message = c.messages.find(m => m.turnId === turn.id && m.role === 'user');
        if (!message || c.messages.some(m => m.turnId === turn.id && m.role === 'assistant')) continue;
        const distance = entry => Math.abs(Date.parse(entry.prompt.at) - Date.parse(turn.startedAt));
        const [match, rival] = earlier.filter(entry => entry.prompt && entry.answers.length && !used.has(entry.start) && entry.prompt.text.trim() === message.text.trim() && distance(entry) <= RECOVERY_WINDOW)
          .sort((a, b) => distance(a) - distance(b));
        if (!match || (rival && distance(rival) === distance(match))) continue;
        used.add(match.start);
        const facts = toolFacts(match.tools, c.cwd), seenByGit = turn.facts.source === 'git' ? turn.facts.files : [];
        Object.assign(turn, outcome(match), { completedAt: match.answers.at(-1).at || turn.completedAt, recovered: true,
          nativeStep: { conversationId: thread, index: match.start } });
        Object.assign(turn.facts, facts, seenByGit.length ? { periodFiles: seenByGit } : {});
        delete turn.partial; delete turn.facts.source;
        if (match.complete) delete message.terminalNote; else message.terminalNote = UNCONFIRMED;
        answers(turn, match.answers, match.complete); recovered++;
      }
      if (added.length) {
        // What git saw change belongs to the whole stay in the terminal, not to one request.
        const last = added.at(-1), message = c.messages.findLast(m => m.turnId === last.id && m.role === 'user');
        if (files?.length) last.facts.periodFiles = files;
        const seen = files?.length ? `Ficheiros alterados enquanto estava no terminal (vistos pelo git, sem saber que pedido os alterou): ${files.slice(0, 40).join(', ')}${files.length > 40 ? ` (+${files.length - 40})` : ''}.` : '';
        if (last.partial) message.terminalNote = [added.length > 1 ? NONE_IMPORTED : NOT_IMPORTED, files === null ? 'O git não estava disponível para ver os ficheiros alterados.' : seen || 'O git não viu ficheiros alterados.'].join(' ');
        else if (seen) message.terminalNote = [message.terminalNote, seen].filter(Boolean).join(' ');
      } else if (files?.length) notes.push('O git mostra alterações nesta pasta, mas o agy não registou atividade nesta conversa; não foram atribuídas ao Antigravity.');
      if (added.length || recovered) c.updatedAt = new Date().toISOString();
      if (confirmed.has('closed')) notes.push('Confirmaste que o Antigravity original estava fechado sem verificação.');
      delete c.terminal;
      await client.persist(); client.changed();
      return { released: true, imported: added.length, answered: added.filter(turn => turn.finalAnswer).length, unconfirmed: added.filter(turn => turn.unconfirmed).length, recovered, warning: notes.join(' ') || null };
    } finally { this.pending.delete(id); this.changed(); }
  }
}
