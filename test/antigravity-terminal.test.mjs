import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Antigravity } from '../lib/antigravity.mjs';
import { Providers } from '../lib/providers.mjs';
import { buildHandoff } from '../lib/handoff.mjs';
import { gitChanges, terminalPrompts } from '../lib/antigravity-terminal.mjs';
import { decodeStep, stepTurns } from '../lib/antigravity-steps.mjs';
import { DatabaseSync } from 'node:sqlite';

// agy's record of a conversation, as observed in agy 1.4.7: SQLite steps with protobuf payloads.
const varint = value => { const out = []; do { let byte = value % 128; value = Math.floor(value / 128); if (value) byte |= 128; out.push(byte); } while (value); return out; };
const bytes = (number, payload) => { const body = typeof payload === 'string' ? [...Buffer.from(payload)] : payload; return [...varint(number * 8 + 2), ...varint(body.length), ...body]; };
const header = at => bytes(5, bytes(1, [...varint(8), ...varint(Math.floor(at / 1000)), ...varint(16), ...varint((at % 1000) * 1e6)]));
const step = { user: (text, at) => [14, [...header(at), ...bytes(19, [...bytes(2, text), ...bytes(3, bytes(1, text))])]],
  answer: (text, at) => [15, [...header(at), ...bytes(20, [...bytes(1, text), ...bytes(6, 'bot-1'), ...bytes(8, text)])]],
  tool: (name, args, at) => [15, [...header(at), ...bytes(20, [...bytes(6, 'bot-2'), ...bytes(7, [...bytes(1, 'call_1'), ...bytes(2, name), ...bytes(3, JSON.stringify(args))])])]],
  other: (type, at) => [type, header(at)] };
function agyStore(file, steps) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, step_payload blob)');
  const start = db.prepare('SELECT COALESCE(MAX(idx), -1) AS last FROM steps').get().last + 1, insert = db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, 3, ?)');
  steps.forEach(([type, payload], index) => insert.run(start + index, type, new Uint8Array(payload)));
  db.close();
}
import { OpinionClient } from './fixtures/opinion-client.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = async predicate => { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw Error('Tempo excedido.'); await new Promise(r => setTimeout(r, 10)); } };

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hydraq-agy-terminal-'));
  const home = path.join(directory, 'agy-home');
  await mkdir(path.join(home, 'conversations'), { recursive: true });
  const options = { dataDir: path.join(directory, 'state'), defaultCwd: directory, settingsFile: path.join(directory, 'settings.json'), executable: process.execPath, prefixArgs: [path.join(root, 'test/fixtures/fake-agy.mjs')] };
  const agy = new Antigravity(options);
  const git = { lines: [' M a.txt'] };
  const hub = new Providers({ dataDir: path.join(directory, 'hub'), defaultCwd: directory, git: async () => git.lines,
    clients: { codex: new OpinionClient('codex', path.join(directory, 'codex')), antigravity: agy },
    opinionSupervisor: { available: async () => ({ available: true }), stop: async () => {} },
    opinionClientFactory: async ({ job, directory: dir }) => { const client = new OpinionClient(job.provider, dir); await client.load(); return { client, cwd: dir }; } });
  await hub.load(); await agy.connect();
  const terminal = hub.antigravityTerminal;
  terminal.home = home; terminal.holders = async () => ({ found: [], unsure: [] });
  t.after(async () => { await hub.close(); await rm(directory, { recursive: true, force: true }); });
  const chat = async (sandbox = 'workspace-write') => {
    const c = await agy.create({ cwd: directory, model: 'gemini-4-argon', effort: 'low', sandbox });
    await hub.send(c.id, 'Memoriza GIRASSOL', 'hydraq-1'); await wait(() => c.status === 'completed');
    await writeFile(path.join(home, 'conversations', c.threadId + '.db'), 'inicial');
    return c;
  };
  const history = (...entries) => appendFile(path.join(home, 'history.jsonl'), entries.map(entry => JSON.stringify(entry) + '\n').join(''));
  return { directory, home, options, agy, hub, terminal, git, chat, history };
}

test('Antigravity original: passa a mesma conversa ao terminal, bloqueia a HYDRAQ e traz os pedidos sem fingir as respostas', async t => {
  const { directory, home, agy, hub, terminal, git, chat, history } = await setup(t);
  const c = await chat();
  await history({ display: 'Pedido anterior', timestamp: Date.now() - 60_000, conversationId: c.threadId });
  assert.ok(agy.session, 'a HYDRAQ mantém o seu agy aberto entre pedidos');
  const info = await terminal.open(c.id, { launch: false });
  assert.equal(agy.session, null, 'o agy da HYDRAQ fecha antes do terminal');
  assert.match(info.command, new RegExp(`--conversation ${c.threadId} --model gemini-4-argon-low --sandbox$`));
  assert.ok(c.terminal.since && c.terminal.history > 0);
  await assert.rejects(hub.send(c.id, 'durante', 'hydraq-2'), /Antigravity original \(terminal\)/);
  assert.throws(() => hub.assertFree({ cwd: directory, resources: ['normal:codex'] }), /Antigravity original no terminal/);
  assert.equal((await terminal.open(c.id, { launch: false })).command, info.command);
  // What the terminal leaves behind: a typed request, a slash command, another conversation's request, files.
  await history({ display: 'Pedido no terminal', timestamp: Date.now() + 5, conversationId: c.threadId, workspace: directory },
    { display: '/exit', type: 'slash_command', timestamp: Date.now() + 6, conversationId: c.threadId },
    { display: 'Outra conversa', timestamp: Date.now() + 7, conversationId: 'outra' });
  await writeFile(path.join(home, 'conversations', c.threadId + '.db'), 'depois do terminal');
  git.lines = [' M a.txt', ' M b.txt', '?? novo.txt'];
  terminal.holders = async () => ({ found: [4242], unsure: [] });
  await assert.rejects(terminal.release(c.id), /ainda tem esta conversa aberta \(processo 4242\)/);
  terminal.holders = async () => ({ found: [], unsure: [77] });
  await assert.rejects(terminal.release(c.id), error => error.code === 'TERMINAL_CONFIRM' && /processo 77/.test(error.message));
  assert.ok(c.terminal, 'sem confirmação, a conversa fica no terminal');
  const result = await terminal.release(c.id, { confirm: ['closed'] });
  assert.equal(result.imported, 1); assert.match(result.warning, /Confirmaste/);
  assert.equal(c.terminal, undefined);
  const turn = c.turns.at(-1), message = c.messages.at(-1);
  assert.equal(turn.source, 'terminal'); assert.equal(turn.partial, 'terminal'); assert.deepEqual(turn.facts.files, ['b.txt', 'novo.txt']);
  assert.equal(message.text, 'Pedido no terminal'); assert.equal(message.source, 'terminal');
  assert.match(message.terminalNote, /ficou no Antigravity original e não foi importada.*b\.txt, novo\.txt/);
  assert.equal(c.turns.filter(entry => entry.source === 'terminal').length, 1);
  // Another model of the group learns of the request, never as finished work.
  const codex = { id: 'codex-1', provider: 'codex', cwd: directory, messages: [], turns: [] };
  const handoff = buildHandoff({ target: codex, members: [codex, { ...c, provider: 'antigravity' }], git: [] });
  assert.match(handoff.text, /Antigravity · gemini-4-argon \(low\) · Antigravity original · RESPOSTA NÃO IMPORTADA/);
  assert.match(handoff.text, /não assumas que o pedido foi concluído/);
  assert.match(handoff.text, /vistos pelo git, sem saber que pedido os alterou\): b\.txt, novo\.txt/);
  assert.equal(handoff.coverage, 'partial');
  // HYDRAQ continues the same native conversation.
  await hub.send(c.id, 'De volta', 'hydraq-3'); await wait(() => c.status === 'completed');
  assert.equal(agy.session.conversation, c);
  assert.deepEqual(await terminal.release(c.id), { released: true, imported: 0 });
});

test('Antigravity original: sem nada novo não importa nada; atividade sem pedido registado fica assinalada; Planear segue para o terminal', async t => {
  const { home, agy, terminal, chat, history, options } = await setup(t);
  const c = await chat('plan');
  assert.match((await terminal.open(c.id, { launch: false })).command, /--sandbox --mode plan$/);
  // The hand-off survives a restart: the conversation stays in the terminal.
  const reopened = new Antigravity(options); await reopened.load();
  assert.ok(reopened.conversation(c.id).terminal);
  const before = c.turns.length;
  assert.equal((await terminal.release(c.id)).imported, 0);
  assert.equal(c.turns.length, before);
  await terminal.open(c.id, { launch: false });
  await writeFile(path.join(home, 'conversations', c.threadId + '.db-wal'), 'escrita sem pedido no histórico');
  assert.equal((await terminal.release(c.id)).imported, 1);
  assert.equal(c.turns.at(-1).terminalUnknown, true); assert.match(c.messages.at(-1).text, /sem pedido registado/);
  // Requests from before the hand-off are never taken as terminal work.
  await terminal.open(c.id, { launch: false });
  await history({ display: 'Antigo', timestamp: Date.parse(c.terminal.since) - 1000, conversationId: c.threadId });
  assert.equal((await terminal.release(c.id)).imported, 0);
  assert.equal(agy.conversations.length, 1);
  // A failure while preparing the command leaves the conversation in HYDRAQ, never half in the terminal.
  const info = terminal.info; terminal.info = () => { throw Error('falha simulada'); };
  await assert.rejects(terminal.open(c.id, { launch: false }), /falha simulada/);
  terminal.info = info; assert.equal(c.terminal, undefined);
});

test('Antigravity original no Dual: só o principal abre no terminal', async t => {
  const { hub, terminal, chat, agy } = await setup(t);
  const codex = hub.clients.codex, c = await codex.create({ cwd: (await chat()).cwd, model: 'test', effort: 'low', sandbox: 'read-only' });
  const { dual } = await hub.startDual(c.id, { provider: 'antigravity', model: 'gemini-4-argon', effort: 'low' });
  const member = agy.conversation(dual.members.b.conversationId);
  await assert.rejects(terminal.open(member.id, { launch: false }), /só o principal \(Codex\) abre no terminal/);
  await hub.endDual(dual.id);
  await assert.rejects(terminal.open(member.id, { launch: false }), /Envia primeiro um pedido/);
});

test('pedidos do terminal: só desta conversa, depois da passagem e sem comandos; ficheiros vistos pelo git', () => {
  const lines = [{ display: 'a', timestamp: 10, conversationId: 'x' }, { display: '/exit', type: 'slash_command', timestamp: 11, conversationId: 'x' },
    { display: 'b', timestamp: 12, conversationId: 'y' }, { display: 'c', timestamp: 5, conversationId: 'x' }, { display: '  ', timestamp: 13, conversationId: 'x' }]
    .map(entry => JSON.stringify(entry)).join('\n') + '\n{inválido';
  assert.deepEqual(terminalPrompts(lines, 'x', 10), [{ text: 'a', timestamp: 10 }]);
  assert.deepEqual(gitChanges([' M a', '?? b'], [' M a', ' M c', 'A  b']), ['c', 'b']);
  assert.deepEqual(gitChanges([' M a'], []), ['a']);
  assert.equal(gitChanges(null, []), null);
});

test('Antigravity original: com o registo do agy legível, voltam os pedidos com as respostas e as ferramentas', async t => {
  const { directory, home, agy, terminal, git, chat, history } = await setup(t);
  const c = await chat(), file = path.join(home, 'conversations', c.threadId + '.db'), now = Date.now();
  await rm(file); agyStore(file, [step.user('Memoriza GIRASSOL', now - 60_000), step.other(90, now - 60_000), step.answer('OK.', now - 59_000)]);
  await terminal.open(c.id, { launch: false });
  assert.equal(c.terminal.steps, 2);
  agyStore(file, [step.user('Cria b.txt e diz quanto é 2+2', now + 1000), step.other(101, now + 1000), step.tool('write_file', { Path: path.join(directory, 'b.txt'), Content: 'x' }, now + 2000), step.other(132, now + 2500),
    step.tool('run_command', { CommandLine: 'npm test' }, now + 2600), step.answer('Criei b.txt. **2+2 é 4.**', now + 3000), step.user('E agora?', now + 4000)]);
  await history({ display: 'Cria b.txt e diz quanto é 2+2', timestamp: now + 1000, conversationId: c.threadId }, { display: 'E agora?', timestamp: now + 4000, conversationId: c.threadId });
  git.lines = [' M a.txt', '?? b.txt'];
  const result = await terminal.release(c.id);
  assert.deepEqual({ imported: result.imported, answered: result.answered, warning: result.warning }, { imported: 2, answered: 1, warning: null });
  const [first, second] = c.turns.filter(turn => turn.source === 'terminal');
  assert.equal(first.status, 'completed'); assert.equal(first.partial, undefined); assert.equal(first.finalAnswer, 'Criei b.txt. **2+2 é 4.**');
  assert.deepEqual(first.facts.files, ['b.txt']); assert.deepEqual(first.facts.commands, [{ command: 'npm test', exitCode: null, status: 'sem resultado lido' }]);
  const shown = c.messages.filter(m => m.turnId === first.id);
  assert.deepEqual(shown.map(m => [m.role, m.text, m.source, m.terminalNote]), [['user', 'Cria b.txt e diz quanto é 2+2', 'terminal', undefined], ['assistant', 'Criei b.txt. **2+2 é 4.**', 'terminal', undefined]]);
  assert.equal(shown[1].phase, 'final_answer'); assert.equal(shown[0].at, new Date(now + 1000).toISOString());
  assert.equal(second.status, 'interrupted'); assert.match(c.messages.find(m => m.turnId === second.id).terminalNote, /não registou resposta/);
  assert.deepEqual(second.facts.files, ['b.txt'], 'os ficheiros vistos pelo git vão com o último pedido');
  const codex = { id: 'codex-1', provider: 'codex', cwd: directory, messages: [], turns: [] };
  const handoff = buildHandoff({ target: codex, members: [codex, { ...c, provider: 'antigravity' }], git: [] });
  assert.match(handoff.text, /Antigravity original · concluído[\s\S]*Resposta final: Criei b\.txt/);
  assert.match(handoff.text, /`npm test` sem resultado lido/);
  assert.equal(handoff.coverage, 'complete');
  assert.equal(agy.conversations.length, 1);
});

test('Antigravity original: registo ilegível fica pelos pedidos; respostas que faltavam são recuperadas no regresso seguinte', async t => {
  const { home, terminal, chat, history } = await setup(t);
  const c = await chat(), file = path.join(home, 'conversations', c.threadId + '.db'), now = Date.now();
  await rm(file); agyStore(file, [step.user('Memoriza GIRASSOL', now - 60_000), step.answer('OK.', now - 59_000)]);
  await terminal.open(c.id, { launch: false });
  // A payload agy wrote in a format this reader does not know: the requests come back without answers.
  agyStore(file, [[14, [0x0f, 0xff]]]);
  await history({ display: 'Quanto é 3+4?', timestamp: now + 1000, conversationId: c.threadId });
  const partial = await terminal.release(c.id);
  assert.equal(partial.imported, 1); assert.match(partial.warning, /Não foi possível ler as respostas/);
  const turn = c.turns.at(-1);
  assert.equal(turn.partial, 'terminal'); assert.match(c.messages.at(-1).terminalNote, /não foi importada/);
  // agy's record is readable again and holds that request with its answer.
  const db = new DatabaseSync(file); db.prepare('DELETE FROM steps WHERE idx = 2').run(); db.close();
  agyStore(file, [step.user('Quanto é 3+4?', now + 1000), step.answer('3+4 é 7.', now + 2000)]);
  await terminal.open(c.id, { launch: false });
  const result = await terminal.release(c.id);
  assert.deepEqual({ imported: result.imported, recovered: result.recovered }, { imported: 0, recovered: 1 });
  assert.equal(turn.partial, undefined); assert.equal(turn.finalAnswer, '3+4 é 7.'); assert.equal(turn.recovered, true);
  assert.equal(c.messages.find(m => m.turnId === turn.id && m.role === 'user').terminalNote, undefined);
  assert.equal(c.messages.filter(m => m.turnId === turn.id && m.role === 'assistant').at(-1).text, '3+4 é 7.');
  // Recovering twice adds nothing.
  await terminal.open(c.id, { launch: false });
  assert.equal((await terminal.release(c.id)).recovered, 0);
});

test('passos do agy: pedido, resposta e ferramentas; formato inesperado falha em vez de adivinhar', () => {
  const at = Date.UTC(2026, 9, 24, 22, 41, 15, 254);
  const decoded = [step.user('olá', at), step.tool('write_file', { Path: 'x.txt' }, at), step.answer('Feito.', at), step.other(132, at)].map(([type, payload], idx) => decodeStep({ idx, step_type: type, step_payload: new Uint8Array(payload) }));
  assert.deepEqual(decoded.map(s => [s.kind, s.text ?? null, s.at]), [['user', 'olá', '2026-10-24T22:41:15.254Z'], ['model', null, '2026-10-24T22:41:15.254Z'], ['model', 'Feito.', '2026-10-24T22:41:15.254Z'], ['other', null, '2026-10-24T22:41:15.254Z']]);
  assert.deepEqual(decoded[1].tools, [{ name: 'write_file', args: { Path: 'x.txt' } }]);
  assert.deepEqual(stepTurns(decoded).map(turn => [turn.prompt.text, turn.answers.map(a => a.text), turn.tools.length]), [['olá', ['Feito.'], 1]]);
  assert.throws(() => decodeStep({ idx: 0, step_type: 14, step_payload: new Uint8Array([0x0f, 0xff]) }));
  assert.throws(() => decodeStep({ idx: 0, step_type: 14, step_payload: new Uint8Array(bytes(19, bytes(2, [0xff, 0xfe]))) }));
  assert.throws(() => decodeStep({ idx: 0, step_type: 15, step_payload: new Uint8Array(header(at)) }));
});
