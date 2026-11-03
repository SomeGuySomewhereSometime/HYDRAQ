import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderCatalogs, quotaWindows } from '../lib/provider-catalogs.mjs';
import { Hydraq } from '../lib/hydraq.mjs';
import { ClaudeCode, parseClaudeModels } from '../lib/claude.mjs';
import { Antigravity, parseAntigravityModels } from '../lib/antigravity.mjs';

test('quotas: múltiplos limites Codex, percentagem utilizada, datas em segundos e valores ausentes', () => {
  const windows = quotaWindows('codex', { rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: { usedPercent: 0, windowDurationMins: 10080 } },
    other: { limitName: 'Outro grupo', primary: { usedPercent: null } },
  } });
  assert.equal(windows.length, 3); assert.equal(windows[0].remainingPercent, 80); assert.equal(windows[1].remainingPercent, 100);
  assert.equal(windows[0].resetsAt, new Date(1900000000000).toISOString()); assert.equal(windows[1].resetsAt, null);
  assert.equal(windows[2].remainingPercent, null); assert.equal(windows[2].group, 'Outro grupo');
  for (const n of [-1, 101, NaN, '23', undefined]) assert.equal(quotaWindows('codex', { rateLimits: { primary: { usedPercent: n } } })[0].usedPercent, null);
});

test('Claude usa percentagem no get_usage e fração nos eventos; agy preserva quotas por grupo', () => {
  const full = quotaWindows('claude', { rate_limits_available: true, rate_limits: { five_hour: { utilization: 14, resets_at: '2026-10-28T18:40:00Z' }, seven_day: { utilization: 72 } } });
  assert.deepEqual(full.map(w => w.remainingPercent), [86, 28]);
  assert.equal(quotaWindows('claude', { nativeEvent: { rateLimitType: 'five_hour', utilization: .14, status: 'allowed' } })[0].remainingPercent, 86);
  assert.equal(quotaWindows('claude', { nativeEvent: { rateLimitType: 'five_hour', status: 'allowed' } })[0].remainingPercent, null);
  assert.deepEqual(quotaWindows('claude', { rate_limits_available: false }), []);
  const agy = quotaWindows('antigravity', { groups: [{ name: 'Gemini', buckets: [{ id: 'g5', window: '5h', remaining_fraction: .25 }] }, { name: 'Argon', buckets: [{ id: 'aw', window: 'weekly', remaining_fraction: 0 }] }] });
  assert.deepEqual(agy.map(w => [w.id, w.group, w.remainingPercent]), [['g5', 'Gemini', 25], ['aw', 'Argon', 0]]);
  assert.equal(quotaWindows('antigravity', { groups: [{ buckets: [{}] }] })[0].remainingPercent, null);
});

test('atualização automática introduz modelos e raciocínios novos sem alterar a conversa; falha conserva catálogo e quotas', async t => {
  let clock = Date.parse('2026-10-28T16:00:00Z'), fail = false, reads = 0;
  const client = Object.assign(new EventEmitter(), { connection: 'connected', models: [{ id: 'old' }], conversations: [{ model: 'old', effort: 'high', status: 'running', threadId: 'same' }],
    async refreshCatalog() { reads++; if (fail) throw Error('token-secret'); this.models = [{ id: 'gpt-6.1-terra', efforts: ['low', 'ultra'] }]; },
    async readQuotas() { if (fail) throw Error('token-secret'); return { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } }; },
  });
  const monitor = new ProviderCatalogs({ codex: client }, () => {}, () => clock); t.after(() => monitor.stop());
  const conversation = structuredClone(client.conversations);
  t.mock.timers.enable({ apis: ['setInterval'] }); monitor.connected('codex'); await monitor.refresh('codex');
  assert.equal(reads, 0); assert.equal(monitor.state('codex').quotas.windows[0].remainingPercent, 90);
  clock += 7 * 60 * 60_000; t.mock.timers.tick(30_000); await monitor.settled();
  assert.equal(reads, 1); assert.equal(client.models[0].id, 'gpt-6.1-terra'); assert.deepEqual(client.conversations, conversation);
  fail = true; clock += 7 * 60 * 60_000; await monitor.refresh('codex');
  assert.equal(client.models[0].id, 'gpt-6.1-terra'); assert.equal(client.connection, 'connected');
  const snapshot = monitor.state('codex'); assert.equal(snapshot.catalog.stale, true); assert.equal(snapshot.quotas.stale, true);
  assert.equal(snapshot.quotas.windows[0].remainingPercent, 90); assert.doesNotMatch(JSON.stringify(snapshot), /token-secret/);
});

test('consultas concorrentes são reunidas e uma falha de quotas não impede o catálogo', async t => {
  let resolve, count = 0, clock = Date.now(); const client = Object.assign(new EventEmitter(), { connection: 'connected',
    async refreshCatalog() { count++; await new Promise(r => { resolve = r; }); this.models = [{ id: 'new' }]; }, async readQuotas() { throw Error('unsupported'); },
  });
  const monitor = new ProviderCatalogs({ codex: client }, () => {}, () => clock); t.after(() => monitor.stop());
  const a = monitor.refresh('codex', { force: true }), b = monitor.refresh('codex', { force: true });
  assert.equal(a, b); assert.equal(count, 1); resolve(); await a;
  assert.equal(client.models[0].id, 'new'); assert.equal(monitor.state('codex').quotas.status, 'error');
  await monitor.refresh('codex', { force: true }); assert.equal(count, 1);
  clock += 11_000; const c = monitor.refresh('codex', { force: true }); resolve(); await c; assert.equal(count, 2);
});

test('notificações sem thread atualizam quotas e conservam os outros grupos', async t => {
  let clock = Date.now(); const client = Object.assign(new EventEmitter(), { connection: 'connected' });
  const monitor = new ProviderCatalogs({ codex: client }, () => {}, () => clock); t.after(() => monitor.stop());
  client.emit('quotas', { rateLimitsByLimitId: { codex: { primary: { usedPercent: 10 } }, other: { primary: { usedPercent: 70 } } } });
  const previous = monitor.state('codex').quotas.windows.find(w => w.id === 'other:primary').checkedAt;
  clock += 60_000; client.emit('quotas', { rateLimits: { limitId: 'codex', primary: { usedPercent: 20 } } });
  const snapshot = monitor.state('codex').quotas;
  assert.equal(snapshot.windows.length, 2); assert.equal(snapshot.windows.find(w => w.id === 'other:primary').checkedAt, previous);
  assert.equal(snapshot.windows.find(w => w.id === 'codex:primary').remainingPercent, 80);
});

test('Codex percorre páginas, descobre Terra e ultra, conserva metadados e rejeita paginação repetida sem perder a lista', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hydraq-catalog-')); t.after(() => rm(root, { recursive: true, force: true }));
  let bad = false; const calls = [], rpc = Object.assign(new EventEmitter(), { info: {}, async call(method, params) {
    calls.push([method, params]); if (method === 'experimentalFeature/list') return { data: [] };
    if (method === 'model/list') return params.cursor ? { data: [{ model: 'gpt-6.1-terra', displayName: 'Terra', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'Máximo' }], defaultReasoningEffort: 'ultra', supportsPersonality: false }], nextCursor: bad ? 'second' : null }
      : { data: [{ model: 'existing', supportedReasoningEfforts: [] }, { model: 'hidden', hidden: true }], nextCursor: 'second' };
    return {};
  } });
  const client = new Hydraq({ dataDir: root, defaultCwd: root, client: rpc, modelMetadataPath: path.join(root, 'missing') });
  await client.refreshCatalog(); assert.deepEqual(client.models.map(m => m.id), ['existing', 'gpt-6.1-terra']);
  assert.deepEqual(client.models[1].efforts, ['ultra']); assert.equal(client.models[1].metadata.supportedReasoningEfforts[0].description, 'Máximo');
  assert.ok(calls.some(([method, params]) => method === 'model/list' && params.includeHidden === false));
  const previous = client.models; bad = true; await assert.rejects(client.refreshCatalog(), /Paginação/); assert.equal(client.models, previous);
});

test('consultas nativas Claude e agy obtêm quotas sem gerar turnos e sem interromper a sessão', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hydraq-native-catalog-'));
  const fixture = name => path.resolve('test/fixtures/fake-' + name + '.mjs');
  const clients = [new ClaudeCode({ dataDir: path.join(root, 'claude'), defaultCwd: root, executable: process.execPath, prefixArgs: [fixture('claude')] }),
    new Antigravity({ dataDir: path.join(root, 'agy'), defaultCwd: root, executable: process.execPath, prefixArgs: [fixture('agy')], settingsFile: path.join(root, 'absent') })];
  t.after(async () => { await Promise.all(clients.map(c => c.close())); await rm(root, { recursive: true, force: true }); });
  for (const [i, client] of clients.entries()) {
    await client.load(); await client.connect(); const models = client.models;
    const native = await client.readQuotas(), windows = quotaWindows(i ? 'antigravity' : 'claude', native);
    assert.equal(windows.length, 2); assert.equal(client.conversations.length, 0); assert.equal(client.session, null);
    await client.refreshCatalog(); assert.deepEqual(client.models, models); assert.equal(client.connection, 'connected');
  }
});

 test('catálogos futuros não dependem de uma lista fixa de famílias ou esforços', () => {
  const claude = parseClaudeModels([{value:'new',supportsEffort:true,supportedEffortLevels:['ultra','high']}]);
  assert.deepEqual(claude[0].efforts,['high','ultra']);
  const agy = parseAntigravityModels('nebula-7-reasoner-high\tNebula 7 Reasoner (High)\ncustom-paid\tCustom API');
  assert.deepEqual(agy.map(m=>m.id),['nebula-7-reasoner']);assert.deepEqual(agy[0].efforts,['high']);
});

 test('evento sem utilização preserva o último valor e a sua data; leitura atrasada não apaga evento recente', async t => {
  let clock=Date.now(),finish;
  const client=Object.assign(new EventEmitter(),{connection:'connected',async readQuotas(){return new Promise(r=>{finish=r;});}});
  const monitor=new ProviderCatalogs({claude:client},()=>{},()=>clock);t.after(()=>monitor.stop());
  client.emit('quotas',{nativeEvent:{rateLimitType:'five_hour',utilization:.14,resetsAt:1900000000}});
  const at=monitor.state('claude').quotas.windows[0].checkedAt;clock+=40000;
  client.emit('quotas',{nativeEvent:{rateLimitType:'five_hour',status:'allowed'}});
  const before=monitor.state('claude').quotas.windows[0];assert.equal(before.remainingPercent,86);assert.equal(before.checkedAt,at);
  clock+=40000;const read=monitor.refresh('claude',{force:true});
  client.emit('quotas',{nativeEvent:{rateLimitType:'five_hour',status:'rejected',utilization:1}});
  finish({rate_limits_available:true,rate_limits:{five_hour:{utilization:15}}});await read;
  assert.equal(monitor.state('claude').quotas.windows[0].remainingPercent,0);assert.equal(monitor.state('claude').quotas.windows[0].status,'rejected');
});
