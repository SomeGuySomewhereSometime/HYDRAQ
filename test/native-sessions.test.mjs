import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {WebSocket} from 'ws';
import {CodexClient} from '../lib/codex.mjs';
import {Hydraq} from '../lib/hydraq.mjs';
import {Providers} from '../lib/providers.mjs';
import {ClaudeCode} from '../lib/claude.mjs';
import {OpinionClient} from './fixtures/opinion-client.mjs';

const root = new URL('../', import.meta.url).pathname;
const wait = async fn => { const until = Date.now() + 6000; while (!fn()) { if (Date.now() > until) throw Error('Timeout'); await new Promise(r => setTimeout(r, 10)); } };
async function setup(t, {project = false, review = false} = {}) {
  const dir = await mkdtemp('/tmp/hydraq-native-test-');
  const log = path.join(dir, 'inputs.log');
  const codex = new Hydraq({dataDir: dir + '/state', defaultCwd: dir,
    client: new CodexClient({executable: process.execPath, args: [root + 'test/fixtures/fake-codex.mjs'], env: {...process.env, FAKE_CODEX_LOG: log}})});
  const claude = new ClaudeCode({dataDir: dir + '/claude', defaultCwd: dir, executable: process.execPath, prefixArgs: [root + 'test/fixtures/fake-claude.mjs'], env: process.env});
  const hub = new Providers({dataDir: dir + '/state', defaultCwd: dir, clients: {codex, claude}, git: async () => null,
    opinionSupervisor: {available: async () => ({available: true}), stop: async () => {}},
    opinionClientFactory: async ({job, directory, cwd}) => { const client = new OpinionClient(job.provider, directory); await client.load(); return {client, cwd, sandbox: 'plan'}; }});
  await hub.load(); await hub.connect('codex'); await hub.connect('claude');
  let p;
  if (project) p = await hub.createProject({name: 'Native', root: dir, revision: 0});
  const chat = await hub.create({provider: 'codex', cwd: dir, projectId: p?.id, revision: hub.projects.data.revision, model: 'gpt-test', effort: 'low', sandbox: 'read-only'});
  const c = codex.conversation(chat.id);
  await hub.send(c.id, 'seed', 'seed'); await wait(() => c.status === 'completed');
  if (review) await hub.automaticReviews.policy(c.id, {trigger: 'all', scope: 'conversation', returnMode: 'always', participants: [{provider: 'claude', model: 'haiku', effort: 'low'}]});
  t.after(async () => { await hub.close(); await new Promise(r => setTimeout(r, 30)); await rm(dir, {recursive: true, force: true}); });
  return {hub, codex, claude, c, dir, p, log};
}
async function peer(t, hub, c) {
  await hub.nativeSessions.open(c.id, {launch: false});
  const session = hub.nativeSessions.sessions.get(c.id);
  const ws = new WebSocket('ws+unix://' + session.socket + ':/');
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.terminate());
  let sequence = 0;
  const pending = new Map(), events = [];
  ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.method) events.push(m); else { const p = pending.get(m.id); if (p) { clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } } });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('RPC timeout: ' + method)); }, 5000);
    pending.set(id, {resolve, reject, timer}); ws.send(JSON.stringify({id, method, params}));
  });
  await call('initialize', {clientInfo: {name: 'native-test', version: '1'}});
  await call('thread/resume', {threadId: c.threadId});
  return {ws, call, events, session};
}

test('terminal partilha a sessão, conserva contexto atualizado e regressa sem duplicar histórico', async t => {
  const {hub, codex, c, p, log} = await setup(t, {project: true});
  const {call, session} = await peer(t, hub, c);
  assert.equal((await stat(session.socket)).mode & 0o777, 0o600);
  assert.equal((await stat(session.directory)).mode & 0o777, 0o700);
  await hub.context.save(p.id, {revision: 0, text: 'DECISAO-NOVA-SEM-PERDAS'});
  await assert.rejects(hub.send(c.id, 'hydra concorrente', 'no'), /terminal/);
  const result = await call('turn/start', {threadId: c.threadId, input: [{type: 'text', text: 'pedido terminal'}]});
  assert.ok(result.turn.id); await wait(() => c.status === 'completed');
  assert.match(await readFile(log, 'utf8'), /DECISAO-NOVA-SEM-PERDAS/);
  assert.equal(c.messages.filter(m => m.role === 'user').length, 2);
  assert.equal(c.messages.find(m => m.text === 'pedido terminal').projectContext.includes('DECISAO-NOVA'), true);
  await hub.nativeSessions.release(c.id);
  assert.equal(c.turns.length, 2); assert.equal(c.messages.filter(m => m.role === 'user').length, 2);
  await hub.send(c.id, 'de volta', 'back'); await wait(() => c.status === 'completed');
  assert.equal(c.turns.length, 3); assert.equal(codex.conversations.length, 1);
});

test('gateway recusa ações que contornam a admissão, outra thread e elevação de acesso', async t => {
  const {hub, c} = await setup(t); const {call} = await peer(t, hub, c);
  for (const method of ['thread/start','thread/fork','thread/shellCommand','config/batchWrite','command/exec','review/start'])
    await assert.rejects(call(method, {threadId: c.threadId}), /não está disponível/);
  await assert.rejects(call('thread/read', {threadId: 'other'}), /apenas/);
  await assert.rejects(call('turn/start', {threadId: c.threadId, input: [{type: 'text', text: 'unsafe'}], approvalPolicy: 'never'}), /on-request/);
  await assert.rejects(call('turn/start', {threadId: c.threadId, input: [{type: 'text', text: 'unsafe'}], sandboxPolicy: {type: 'dangerFullAccess'}}), /acesso/);
  assert.equal(c.turns.length, 1);
});

test('desligar terminal em execução conserva o pedido e bloqueia transferência até terminar', async t => {
  const {hub, codex, c} = await setup(t); const {call, ws} = await peer(t, hub, c);
  await call('turn/start', {threadId: c.threadId, input: [{type: 'text', text: 'hold'}]});
  await assert.rejects(call('turn/start', {threadId: c.threadId, input: [{type: 'text', text: 'concorrente'}]}), /reservado|curso/);
  await assert.rejects(hub.nativeSessions.release(c.id), /conclusão/);
  ws.terminate(); await wait(() => !hub.nativeSessions.snapshot().sessions[0].connected);
  assert.equal(codex.client.ready, true); assert.equal(c.status, 'running');
  await hub.interrupt(c.id); await wait(() => c.status === 'interrupted');
  await hub.nativeSessions.release(c.id); assert.equal(c.turns.length, 2);
});

test('aprovação no terminal e resposta concorrente na HYDRAQ resolvem uma só vez', async t => {
  const {hub, codex, c} = await setup(t); const {call, ws, events} = await peer(t, hub, c);
  await call('turn/start', {threadId: c.threadId, input: [{type: 'text', text: 'approval'}]});
  await wait(() => events.some(m => m.method.endsWith('/requestApproval')));
  const request = events.find(m => m.method.endsWith('/requestApproval'));
  codex.respond(String(request.id), {decision: 'decline'});
  ws.send(JSON.stringify({id: request.id, result: {decision: 'accept'}}));
  await wait(() => c.status === 'completed');
  assert.equal(c.messages.at(-1).text, 'Decisão: decline');
  assert.equal(codex.approvals.size, 0);
  await wait(() => events.some(m => m.method === 'serverRequest/resolved'));
});

test('turnos nativos desconhecidos conservam pergunta, resposta e factos para a passagem', async t => {
  const {hub, codex, c, claude} = await setup(t);
  const params = {threadId: c.threadId, turnId: 'external'};
  const emit = (method, extra) => codex.client.emit('notification', {method, params: {...params, ...extra}});
  emit('turn/started', {turn: {id: 'external', status: 'inProgress'}});
  emit('item/completed', {item: {id: 'user-external', type: 'userMessage', content: [{type: 'text', text: 'DECISAO-EXTERNA'}]}});
  emit('item/completed', {item: {id: 'command-external', type: 'commandExecution', command: 'printf confirmado', status: 'completed', exitCode: 7}});
  emit('item/completed', {item: {id: 'agent-external', type: 'agentMessage', text: 'RESULTADO-EXTERNO'}});
  emit('turn/completed', {turn: {id: 'external', status: 'completed'}});
  const result = await hub.send(c.id, 'continua', 'switch', {provider: 'claude', model: 'haiku', effort: 'low', handoffMode: 'quick'});
  const target = claude.conversation(result.conversationId); await wait(() => target.status === 'completed');
  const prompt = await readFile(path.join(target.cwd, '.fake-claude-last-' + target.threadId), 'utf8');
  assert.match(prompt, /DECISAO-EXTERNA/); assert.match(prompt, /RESULTADO-EXTERNO/); assert.match(prompt, /printf confirmado.*7/);
});

test('pedido no terminal mantém revisão automática e retorno único ao principal', async t => {
  const {hub, c} = await setup(t, {review: true}); const {call} = await peer(t, hub, c);
  await call('turn/start', {threadId: c.threadId, input: [{type: 'text', text: 'Analisa o objetivo'}]});
  await wait(() => hub.automaticReviews.cycles[0]?.status === 'completed');
  assert.equal(c.turns.length, 3); // seed + original + assessment
  assert.equal(hub.automaticReviews.cycles.length, 1);
  assert.equal(hub.nativeSessions.snapshot().sessions.length, 1);
});

test('associação explícita conserva o ID e recusa outra pasta', async t => {
  const {hub, codex, c, dir} = await setup(t);
  const list = await hub.nativeSessions.list({cwd: dir}); assert.equal(list.data[0].id, c.threadId);
  assert.equal((await hub.nativeSessions.import({threadId: c.threadId, cwd: dir})).existing, true);
  const source = structuredClone(c); codex.conversations.length = 0;
  await assert.rejects(hub.nativeSessions.import({threadId: source.threadId, cwd: '/tmp/other'}), /pasta/);
  const result = await hub.nativeSessions.import({threadId: source.threadId, cwd: dir});
  const imported = codex.conversation(result.conversationId);
  assert.equal(imported.threadId, source.threadId); assert.equal(imported.turns.length, 1);
  assert.equal(imported.messages.find(m => m.role === 'user').text, 'seed');
  await codex.reconcileNative(imported.id); assert.equal(imported.turns.length, 1); assert.equal(imported.messages.length, 2);
});
