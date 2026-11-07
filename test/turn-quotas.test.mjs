import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { compareQuotaReads, TurnQuotas } from '../lib/turn-quotas.mjs';
import { hydraQuotaUsage } from '../public/turn-quotas.js';

const reset = '2099-01-01T00:00:00.000Z';
const window = (id, usedPercent, resetsAt = reset) =>
  ({ id, group: 'Claude', label: id, windowDurationMins: 10080, usedPercent, resetsAt });

test('compara cada limite em pontos percentuais e separa leitura ausente, reposição e resolução zero', () => {
  const before = [window('A', 10), window('B', 55), window('C', 20), window('D', 25), window('E', 18)];
  const after = [window('A', 10.25), window('B', 56, '2099-01-08T00:00:00.000Z'), window('C', 20), window('E', 17), window('F', 30)];
  const { windows } = compareQuotaReads(before, after);
  assert.deepEqual(windows.map(w => [w.id, w.spent, w.reason]), [
    ['A', .25, null], ['B', null, 'reset'], ['C', 0, null], ['D', null, 'missing'],
    ['E', null, 'reset'], ['F', null, 'missing'],
  ]);
  assert.equal(compareQuotaReads([window('A', 0)], [window('A', 1)], { at: Date.parse(reset) }).windows[0].reason, 'reset');
});

test('medições concorrentes do mesmo cliente em processos distintos ficam sem atribuição', async () => {
  let reads = 0;
  const primary = Object.assign(new EventEmitter(), {
    changed() {},
    async readQuotas() {
      reads++;
      return { rate_limits_available: true, rate_limits: { seven_day: { utilization: reads, resets_at: reset } } };
    },
  });
  const reviewer = Object.assign(new EventEmitter(), { changed() {}, readQuotas() { assert.fail('consulta fora do processo do parecer'); } });
  const tracker = new TurnQuotas({ claude: primary });
  tracker.attach('claude', primary);
  tracker.attach('claude', reviewer);
  const main = { model: 'sonnet', status: 'running', delivery: 'accepted' };
  const review = { model: 'opus', status: 'running', delivery: 'accepted' };
  await tracker.begin(primary, main);
  await tracker.begin(reviewer, review);
  main.status = review.status = 'completed';
  primary.emit('state');
  reviewer.emit('state');
  await Promise.all([tracker.settle(main), tracker.settle(review)]);
  assert.equal(reads, 4);
  for (const turn of [main, review]) {
    assert.equal(turn.quotaUsage.windows[0].reason, 'overlap');
    assert.equal(turn.quotaUsage.windows[0].spent, null);
  }
  const next = { model: 'sonnet', status: 'starting', delivery: 'preparing' };
  await tracker.begin(primary, next);
  next.status = 'interrupted';
  await tracker.settle(next);
  assert.equal(reads, 5);
  assert.equal(next.quotaUsage, undefined);
});

test('Argon só mede a janela semanal própria, mesmo que outros grupos tenham uma janela de 5 horas', async () => {
  let remaining = .5;
  const agy = Object.assign(new EventEmitter(), {
    changed() {},
    async readQuotas() {
      return { groups: [
        { name: 'Gemini Models', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: .8, reset_time: reset }] },
        { name: 'Gemini 4 Argon', buckets: [{ id: 'argon-weekly', window: 'weekly', remaining_fraction: remaining, reset_time: reset }] },
      ] };
    },
  });
  const tracker = new TurnQuotas({ antigravity: agy });
  tracker.attach('antigravity', agy);
  const turn = { model: 'gemini-4-argon', status: 'starting', delivery: 'preparing' };
  await tracker.begin(agy, turn);
  remaining = .489;
  turn.status = 'completed';
  turn.delivery = 'accepted';
  await tracker.settle(turn);
  assert.deepEqual(turn.quotaUsage.windows.map(w => [w.label, w.spent]), [['Semanal', 1.1]]);
});

test('Hydra soma os turnos da tarefa, incluindo quem saiu, e marca totais parciais', () => {
  const reading = (requestId, model, spent) => ({
    requestId, model, status: 'completed', quotaUsage: { windows: [{ ...window('Semanal', 40), spent }] },
  });
  const task = {
    members: { claude: { conversationId: 'a' } },
    removedParticipants: [{ role: 'antigravity', conversationId: 'b' }],
    dispatches: [
      { role: 'claude', requestId: 'one' }, { role: 'claude', requestId: 'two' }, { role: 'claude', requestId: 'three' },
      { role: 'antigravity', requestId: 'four' },
    ],
  };
  const rows = hydraQuotaUsage(task, [
    { id: 'a', turns: [reading('other-task', 'opus', 50), reading('one', 'opus', .25), reading('two', 'opus', .5), { requestId: 'three', model: 'opus', status: 'completed' }] },
    { id: 'b', turns: [reading('four', 'argon', 3)] },
  ]);
  assert.deepEqual(rows.map(r => [r.provider, r.model, r.windows[0].spent, r.partial]), [
    ['claude', 'opus', .75, true], ['antigravity', 'argon', 3, false],
  ]);
});

test('a mesma reposição Claude com diferença inferior a um segundo conserva a medição', () => {
  const sample = compareQuotaReads([window('Semanal', 10, '2099-01-01T00:00:00.246Z')],
    [window('Semanal', 11, '2099-01-01T00:00:00.040Z')]);
  assert.equal(sample.windows[0].spent, 1);
});

test('os três clientes medem no envio normal, preservam o resultado e não repetem leituras num retry', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const { Hydraq } = await import('../lib/hydraq.mjs');
  const { CodexClient } = await import('../lib/codex.mjs');
  const { ClaudeCode } = await import('../lib/claude.mjs');
  const { Antigravity } = await import('../lib/antigravity.mjs');
  const root = await mkdtemp('/tmp/hydraq-turn-quotas-');
  const clients = {};
  const tracker = new TurnQuotas(clients);
  t.after(async () => {
    await tracker.close();
    for (const client of Object.values(clients)) await client.close();
    await rm(root, { recursive: true, force: true });
  });
  const options = id => ({
    dataDir: root + '/' + id, defaultCwd: root, executable: process.execPath,
    prefixArgs: [path.resolve('test/fixtures/fake-' + id + '.mjs')],
  });
  clients.codex = new Hydraq({
    dataDir: root + '/codex', defaultCwd: root,
    client: new CodexClient({ executable: process.execPath, args: [path.resolve('test/fixtures/fake-codex.mjs')] }),
  });
  clients.claude = new ClaudeCode(options('claude'));
  clients.antigravity = new Antigravity({ ...options('agy'), settingsFile: root + '/absent' });
  for (const [provider, client] of Object.entries(clients)) {
    await client.load();
    await client.connect();
    tracker.attach(provider, client);
    let reads = 0;
    const readNative = client.readQuotas.bind(client);
    client.readQuotas = async (...args) => {
      await readNative(...args);
      const utilization = 10 + reads++ * .25;
      if (provider === 'codex') return { rateLimits: { primary: { usedPercent: utilization, windowDurationMins: 300, resetsAt: Date.parse(reset) / 1000 } } };
      if (provider === 'claude') return { rate_limits_available: true, rate_limits: { seven_day: { utilization, resets_at: reset } } };
      return { groups: [{ name: 'Gemini 4 Argon', buckets: [{ id: 'argon-weekly', window: 'weekly', remaining_fraction: 1 - utilization / 100, reset_time: reset }] }] };
    };
    const model = provider === 'claude' ? 'haiku' : provider === 'codex' ? 'gpt-test' : 'gemini-4-argon';
    const c = await client.create({ cwd: root, model, effort: 'low', sandbox: provider === 'codex' ? 'read-only' : 'plan' });
    await client.send(c.id, 'olá', 'request');
    const deadline = Date.now() + 8000;
    while (c.status !== 'completed') {
      assert.ok(Date.now() < deadline, provider + ' terminou');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await tracker.settle(c.turns[0]);
    assert.equal(c.turns[0].quotaUsage.windows[0].spent, .25, provider);
    assert.equal(reads, 2);
    await client.send(c.id, 'olá', 'request');
    assert.equal(reads, 2, 'retry não cria outra medição');
    await client.persist();
    const saved = new client.constructor(provider === 'codex' ? { dataDir: root + '/codex', defaultCwd: root } :
      provider === 'claude' ? options('claude') : { ...options('agy'), settingsFile: root + '/absent' });
    await saved.load();
    assert.deepEqual(saved.conversations[0].turns[0].quotaUsage, c.turns[0].quotaUsage);
    await saved.close();
  }
});

test('turnos seguidos reutilizam a leitura final completa, mesmo ao mudar a família Claude', async () => {
  let reads = 0, clock = Date.now();
  const client = Object.assign(new EventEmitter(), {
    connection: 'connected', account: { type: 'claude.ai' }, changed() {},
    async readQuotas() {
      const value = ++reads;
      return { rate_limits_available: true, rate_limits: {
        five_hour: { utilization: value, resets_at: reset },
        seven_day: { utilization: value, resets_at: reset },
        seven_day_opus: { utilization: value + 10, resets_at: reset },
      } };
    },
  });
  const tracker = new TurnQuotas({ claude: client }, { clock: () => clock });
  tracker.attach('claude', client);
  const first = { model: 'sonnet', status: 'starting', delivery: 'preparing' };
  await tracker.begin(client, first);
  first.status = 'completed'; first.delivery = 'accepted';
  await tracker.settle(first);
  assert.equal(reads, 2);
  assert.equal(first.quotaUsage.timing.reusedBefore, false);
  assert.equal(first.quotaUsage.windows.length, 2);

  const second = { model: 'opus', status: 'starting', delivery: 'preparing' };
  await tracker.begin(client, second);
  assert.equal(reads, 2, 'o segundo pedido não consulta antes de enviar');
  second.status = 'completed'; second.delivery = 'accepted';
  await tracker.settle(second);
  assert.equal(reads, 3, 'o segundo pedido só consulta no fim');
  assert.equal(second.quotaUsage.timing.reusedBefore, true);
  assert.deepEqual(second.quotaUsage.windows.map(w => [w.id, w.from, w.to, w.spent]), [
    ['five_hour', 2, 3, 1], ['seven_day', 2, 3, 1], ['seven_day_opus', 12, 13, 1],
  ]);
  for (const key of ['beforeMs', 'afterMs', 'previousReadWaitMs']) {
    assert.ok(Number.isFinite(second.quotaUsage.timing[key]));
  }

  client.emit('quotas', {});
  const third = { model: 'opus', status: 'starting', delivery: 'preparing' };
  await tracker.begin(client, third);
  assert.equal(reads, 4, 'um evento invalida a leitura anterior');
  third.status = 'completed'; third.delivery = 'accepted';
  await tracker.settle(third);

  clock += 30_001;
  const fourth = { model: 'opus', status: 'starting', delivery: 'preparing' };
  await tracker.begin(client, fourth);
  assert.equal(reads, 6, 'dados com mais de 30 segundos são consultados de novo');
  fourth.status = 'completed'; fourth.delivery = 'accepted';
  await tracker.settle(fourth);

  client.account = { type: 'claude.ai' };
  const fifth = { model: 'opus', status: 'starting', delivery: 'preparing' };
  await tracker.begin(client, fifth);
  assert.equal(reads, 8, 'um novo contexto de conta invalida o anterior');
  fifth.status = 'completed'; fifth.delivery = 'accepted';
  await tracker.settle(fifth);
  await tracker.close();
});

test('o próximo turno aguarda uma leitura final em curso e reutiliza-a sem outra consulta', async () => {
  let reads = 0, finishRead;
  const client = Object.assign(new EventEmitter(), {
    connection: 'connected', changed() {},
    async readQuotas() {
      if (++reads === 2) await new Promise(resolve => { finishRead = resolve; });
      return { rateLimits: { primary: { usedPercent: reads, windowDurationMins: 300, resetsAt: Date.parse(reset) / 1000 } } };
    },
  });
  const tracker = new TurnQuotas({ codex: client });
  tracker.attach('codex', client);
  const first = { model: 'test', status: 'starting', delivery: 'preparing' };
  await tracker.begin(client, first);
  first.status = 'completed'; first.delivery = 'accepted';
  const ending = tracker.settle(first);
  await Promise.resolve();
  const second = { model: 'test', status: 'starting', delivery: 'preparing' };
  let ready = false;
  const beginning = tracker.begin(client, second).then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  finishRead();
  await Promise.all([ending, beginning]);
  assert.equal(reads, 2);
  second.status = 'completed'; second.delivery = 'accepted';
  await tracker.settle(second);
  assert.equal(reads, 3);
  assert.equal(second.quotaUsage.timing.reusedBefore, true);
  await tracker.close();
});

test('Hydra consulta só no início e no fim, com dez turnos internos entre as leituras', async () => {
  let reads = 0, used = 10;
  const client = Object.assign(new EventEmitter(), {
    connection: 'connected', models: [{ id: 'opus' }], changed() {},
    async readQuotas() {
      reads++;
      return { rate_limits_available: true, rate_limits: { seven_day: { utilization: used, resets_at: reset } } };
    },
  });
  const tracker = new TurnQuotas({ claude: client });
  tracker.attach('claude', client);
  const record = { id: 'hydra', members: { claude: { model: 'opus', conversationId: 'chat' } } };
  assert.equal(await tracker.beginTask(record, 'claude'), true);
  assert.equal(reads, 1);
  for (let i = 0; i < 10; i++) {
    assert.equal(await tracker.beginTask(record, 'claude'), false);
    await tracker.begin(client, { internal: 'claudex', status: 'running', model: 'opus' });
    used += .25;
    client.emit('state');
  }
  assert.equal(reads, 1);
  await tracker.finishTask(record);
  assert.equal(reads, 2);
  assert.equal(record.quotaTurns.claude[0].quotaUsage.windows[0].spent, 2.5);
  const rows = hydraQuotaUsage(record, []);
  assert.deepEqual(rows.map(row => [row.provider, row.model, row.windows[0].spent]), [['claude', 'opus', 2.5]]);
  await tracker.finishTask(record);
  assert.equal(reads, 2, 'a conclusão é idempotente');
  await tracker.close();
});

test('Hydra preserva a leitura inicial em disco e assinala o intervalo não observado após reinício', async () => {
  let reads = 0;
  const client = Object.assign(new EventEmitter(), {
    connection: 'connected', models: [{ id: 'opus' }], changed() {},
    async readQuotas() {
      reads++;
      return { rate_limits_available: true, rate_limits: { seven_day: { utilization: reads, resets_at: reset } } };
    },
  });
  const firstTracker = new TurnQuotas({ claude: client });
  firstTracker.attach('claude', client);
  const record = { id: 'restart', members: { claude: { model: 'opus' } } };
  await firstTracker.beginTask(record, 'claude');
  const restored = JSON.parse(JSON.stringify(record));
  assert.equal(restored.quotaTurns.claude[0].quotaBefore[0].usedPercent, 1);
  firstTracker.stop();
  const secondTracker = new TurnQuotas({ claude: client });
  secondTracker.attach('claude', client);
  await secondTracker.beginTask(restored, 'claude');
  assert.equal(reads, 1, 'retomar a tarefa não repete a leitura inicial');
  await secondTracker.finishTask(restored);
  assert.equal(reads, 2);
  assert.equal(restored.quotaTurns.claude[0].quotaUsage.windows[0].reason, 'missing');
  assert.equal(restored.quotaTurns.claude[0].quotaBefore[0].usedPercent, 1);
  await secondTracker.close();
});
