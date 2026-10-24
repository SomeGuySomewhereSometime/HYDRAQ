import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, stat, writeFile} from 'node:fs/promises';
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
  await assert.rejects(hub.proposeMemory(p.id, {conversationId:c.id,revision:1}), /terminal/);
  await assert.rejects(hub.refreshContext(c.id), /terminal/);
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

test('TUI conserva a prioridade nativa de modelo/raciocínio e a página inicial pedida', async t => {
  const {hub, c} = await setup(t); const {call} = await peer(t, hub, c);
  const resumed = await call('thread/resume', {threadId:c.threadId,excludeTurns:true,initialTurnsPage:{limit:10,sortDirection:'asc',itemsView:'full'}});
  assert.equal(resumed.initialTurnsPage.data.length, 1);
  await assert.rejects(call('thread/resume', {threadId:c.threadId,sandbox:'danger-full-access'}), /definições/);
  await call('turn/start', {threadId:c.threadId,input:[{type:'text',text:'modelo escolhido no TUI'}],model:'gpt-test',effort:'low',
    collaborationMode:{mode:'default',settings:{model:'gpt-other',reasoning_effort:'high',developer_instructions:null}}});
  await wait(() => c.status === 'completed');
  assert.equal(c.turns.at(-1).model, 'gpt-other'); assert.equal(c.turns.at(-1).effort, 'high');
});

test('/model no TUI muda só modelo/raciocínio da sessão, notifica o TUI e recusa outras definições', async t => {
  const {hub, c} = await setup(t); const {call, events} = await peer(t, hub, c);
  // Parameters as the original TUI 0.159 sends them for a session-only /model choice.
  const update = (extra = {}) => call('thread/settings/update', {threadId:c.threadId, disabledPluginIds:null, cwd:null, approvalPolicy:null, approvalsReviewer:null, sandboxPolicy:null, permissions:null,
    model:'gpt-other', effort:'high', summary:null, collaborationMode:{mode:'default',settings:{model:'gpt-other',reasoning_effort:'high',developer_instructions:null}}, multiAgentMode:null, personality:null, ...extra});
  assert.deepEqual(await update(), {});
  assert.deepEqual([c.model, c.effort], ['gpt-other', 'high']);
  await wait(() => events.some(e => e.method === 'thread/settings/updated'));
  const notice = events.find(e => e.method === 'thread/settings/updated').params;
  assert.equal(notice.threadId, c.threadId);
  assert.deepEqual([notice.threadSettings.model, notice.threadSettings.effort, notice.threadSettings.collaborationMode.settings.reasoning_effort], ['gpt-other', 'high', 'high']);
  assert.deepEqual(notice.threadSettings.sandboxPolicy, {type:'readOnly', networkAccess:false});
  await assert.rejects(update({effort:'low', collaborationMode:{mode:'default',settings:{model:'gpt-other',reasoning_effort:'low',developer_instructions:null}}}), /não suportado/);
  await assert.rejects(update({model:'gpt-inexistente', collaborationMode:null}), /catálogo/);
  await assert.rejects(update({permissions:'full'}), /permissões/);
  await assert.rejects(update({sandboxPolicy:{type:'workspaceWrite', writableRoots:[c.cwd], networkAccess:false}}), /acesso/);
  await assert.rejects(update({collaborationMode:{mode:'plan',settings:{model:'gpt-other',reasoning_effort:'high',developer_instructions:null}}}), /colaboração/);
  await assert.rejects(update({threadId:'outra'}), /pertence/);
  assert.deepEqual([c.model, c.effort], ['gpt-other', 'high'], 'pedidos recusados não alteram a sessão');
  await call('turn/start', {threadId:c.threadId, input:[{type:'text', text:'depois do /model'}]});
  await wait(() => c.status === 'completed');
  assert.deepEqual([c.turns.at(-1).model, c.turns.at(-1).effort], ['gpt-other', 'high']);
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
  ws.send(JSON.stringify({id:request.id,result:{decision:'acceptForSession'}}));
  await wait(() => events.some(m => m.method === 'warning'));
  assert.equal(codex.approvals.size, 1);
  await wait(() => events.filter(m => m.method.endsWith('/requestApproval')).length === 2);
  assert.equal(events.filter(m => m.method.endsWith('/requestApproval')).length, 2);
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

test('uma página de histórico falhada não altera estado, mensagens nem autorizações', async t => {
  const {codex, c} = await setup(t);
  const before = structuredClone(c);
  const original = codex.client.call.bind(codex.client);
  codex.approvals.set('pending', {conversationId:c.id});
  codex.client.call = async (method, params) => {
    if (method !== 'thread/turns/list') return original(method, params);
    if (params.cursor) throw Error('Falha na segunda página');
    return {data:[{id:'partial',status:'completed',items:[{id:'partial-user',type:'userMessage',content:[{type:'text',text:'NÃO PUBLICAR'}]}]}],nextCursor:'next'};
  };
  await assert.rejects(codex.reconcileNative(c.id), /segunda página/);
  assert.deepEqual(c, before); assert.ok(codex.approvals.has('pending'));
});

test('histórico antigo não sobrescreve eventos recebidos durante a consulta', async t => {
  const {codex, c} = await setup(t);
  const original = codex.client.call.bind(codex.client);
  codex.client.call = async (method, params) => {
    const result = await original(method, params);
    if (method === 'thread/turns/list') codex.client.emit('notification', {method:'mcpServer/startupStatus/updated',params:{threadId:c.threadId,name:'project',status:'ready'}});
    return result;
  };
  await codex.reconcileNative(c.id);
  assert.equal(c.status, 'completed');
  codex.client.call = async (method, params) => {
    const result = await original(method, params);
    if (method === 'thread/turns/list') codex.client.emit('notification', {method:'turn/started',params:{threadId:c.threadId,turn:{id:'live',status:'inProgress'}}});
    return result;
  };
  await assert.rejects(codex.reconcileNative(c.id), /mudou durante/);
  assert.equal(c.status, 'running'); assert.equal(c.turnId, 'live');
});

test('catálogo maior que 16 MiB não perde a ligação nem eventos seguintes', async t => {
  const {hub, codex, c} = await setup(t); const {call, ws} = await peer(t, hub, c);
  const original = codex.client.call.bind(codex.client);
  const catalog = {marketplaces:[],marketplaceLoadErrors:[],fixture:'x'.repeat(18 * 1024 * 1024)};
  codex.client.call = async (method, params) => method === 'plugin/list' ? catalog : original(method, params);
  const results = await Promise.all([call('plugin/list'), call('plugin/list')]);
  assert.equal(results[0].fixture.length, catalog.fixture.length);
  assert.equal(results[1].fixture.length, catalog.fixture.length);
  assert.equal(ws.readyState, WebSocket.OPEN);
  await call('turn/start', {threadId:c.threadId,input:[{type:'text',text:'depois do catálogo'}]});
  await wait(() => c.status === 'completed');
  assert.equal(c.turns.length, 2);
});

test('imagem local é guardada, enviada e conservada na projeção sem contexto interno', async t => {
  const {hub, c, dir, p} = await setup(t, {project:true}); const {call} = await peer(t, hub, c);
  await hub.context.save(p.id, {revision:0,text:'CONTEXTO INTERNO'});
  const file = path.join(dir, 'pixel.png');
  await writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  await call('turn/start', {threadId:c.threadId,input:[{type:'text',text:'Vê a imagem'}, {type:'localImage',path:file}]});
  await wait(() => c.status === 'completed');
  const shown = c.messages.find(m => m.text === 'Vê a imagem');
  assert.equal(shown.attachments[0].mimeType, 'image/png');
  const item = {id:shown.nativeItemId,type:'userMessage',content:[{type:'text',text:'CONTEXTO INTERNO'}, {type:'localImage',path:file}]};
  const projected = hub.nativeSessions.project({item});
  assert.equal(projected.item.content[0].text, 'Vê a imagem');
  assert.equal(projected.item.content[1].path, file);
  assert.equal(item.content[0].text, 'CONTEXTO INTERNO');
});

test('reconexão recupera aprovação pendente e repetição do ID não reenvia o pedido', async t => {
  const {hub, c, codex} = await setup(t); const first = await peer(t, hub, c);
  const params = {threadId:c.threadId,clientUserMessageId:'stable-message',input:[{type:'text',text:'approval'}]};
  const admitted = await first.call('turn/start', params);
  await wait(() => codex.approvals.size === 1);
  first.ws.terminate(); await wait(() => !hub.nativeSessions.snapshot().sessions[0].connected);
  const second = await peer(t, hub, c);
  await wait(() => second.events.some(m => m.method.endsWith('/requestApproval')));
  assert.equal((await second.call('turn/start', params)).turn.id, admitted.turn.id);
  const approval = second.events.find(m => m.method.endsWith('/requestApproval'));
  second.ws.send(JSON.stringify({id:approval.id,result:{decision:'decline'}}));
  await wait(() => c.status === 'completed');
  assert.equal(c.turns.length, 2);
});
