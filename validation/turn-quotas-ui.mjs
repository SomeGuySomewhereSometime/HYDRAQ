// Isolated browser checks. Quotas and answers are simulated, with the real hub and UI.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { Providers } from '../lib/providers.mjs';
import { OpinionClient } from '../test/fixtures/opinion-client.mjs';
import { createHttpServer } from '../lib/http.mjs';

const root = await mkdtemp('/tmp/hydraq-turn-quota-ui-');
const out = path.resolve(process.argv[2] || root + '/screenshots');
await mkdir(out, { recursive: true });
const models = { codex: 'test', claude: 'opus', antigravity: 'gemini-4-argon', cursor: 'test', opencode: 'test' };
const reset = '2099-01-01T00:00:00.000Z';
class QuotaClient extends OpinionClient {
  constructor(provider, directory) {
    super(provider, directory, { behavior: 'hold' });
    this.models[0].id = models[provider];
    this.models[0].name = {codex:'Codex teste',claude:'Claude Opus',antigravity:'Gemini Argon'}[provider] || provider;
    this.counter = 10;
  }
  async readQuotas() {
    const utilization = this.counter;
    this.counter += .25;
    if (this.provider === 'codex') return { rateLimits: {
      primary: { usedPercent: utilization, windowDurationMins: 300, resetsAt: Date.parse(reset) / 1000 },
      secondary: { usedPercent: utilization, windowDurationMins: 10080, resetsAt: Date.parse(reset) / 1000 },
    } };
    if (this.provider === 'claude') return { rate_limits_available: true, rate_limits: {
      five_hour: { utilization, resets_at: reset }, seven_day: { utilization, resets_at: reset },
    } };
    return { groups: [
      { name: 'Gemini Models', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: .8, reset_time: reset }] },
      { name: 'Gemini 4 Argon', buckets: [{ id: 'argon-weekly', window: 'weekly', remaining_fraction: 1 - utilization / 100, reset_time: reset }] },
    ] };
  }
  finish(c, text) {
    super.finish(c, text);
    const usage = c.turns.at(-1).usage;
    if (usage) Object.assign(usage, { cachedInputTokens: 0, uncachedInputTokens: usage.inputTokens, cachePercent: 0 });
    this.changed();
  }
  async send(id, text, requestId, settings = {}) {
    const result = await super.send(id, text, requestId, settings);
    if (result.duplicate) return result;
    const c = this.conversation(id), turn = c.turns.at(-1);
    turn.model = settings.model || c.model;
    await this.turnQuotas?.begin(this, turn, this.models[0]);
    if (settings.internal !== 'claudex') this.timer = setTimeout(() => this.finish(c, 'Resposta de ' + this.provider), 35);
    return result;
  }
}
const clients = Object.fromEntries(Object.keys(models).map(provider => [provider, new QuotaClient(provider, root + '/' + provider)]));
const hub = new Providers({
  dataDir: root + '/hub', defaultCwd: root, clients, git: async () => [],
  opinionSupervisor: { available: async () => ({ available: true }), stop: async () => {} },
  opinionClientFactory: async ({ job, directory, cwd }) => {
    const client = new QuotaClient(job.provider, directory);
    await client.load();
    return { client, cwd };
  },
});
const wait = async predicate => {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Operação terminou no prazo');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const checks = [], errors = [];
const check = (name, result) => { assert.ok(result, name); checks.push(name); console.log('PASS', name); };
let server, browser, page;
try {
  await hub.load();
  await hub.connectAll();
  server = createHttpServer({ hydraq: hub, publicDir: path.resolve('public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) errors.push(response.status() + ' ' + new URL(response.url()).pathname); });
  const open = async c => {
    await page.goto('about:blank');
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(id => { localStorage.setItem('hydraq.conversation', id); localStorage.setItem('hydraq.theme', 'atelier'); }, c.id);
    await page.reload();
    await page.locator('#model').waitFor();
  };
  const create = provider => hub.create({ provider, cwd: root, model: models[provider], effort: 'low', sandbox: provider === 'codex' ? 'read-only' : 'plan' });
  const normal = clients.codex.conversation((await create('codex')).id);
  await hub.send(normal.id, 'Pedido normal', 'normal');
  await wait(() => normal.turns[0]?.quotaUsage);
  await open(normal);
  await page.locator('#messages .turn-quota-usage').waitFor();
  const normalUsage = await page.locator('#messages .turn-quota-usage').innerText();
  check('Normal mostra apenas a percentagem por limite', normalUsage === 'Quota usada · 5 horas · 0,25% | Semanal · 0,25%');
  await page.screenshot({ path: out + '/normal.png' });

  const multi = clients.codex.conversation((await create('codex')).id);
  const { dual } = await hub.startDual(multi.id, { participants: [{ provider: 'claude', model: models.claude, effort: 'low' }, { provider: 'antigravity', model: models.antigravity, effort: 'low' }] });
  await hub.sendDual(dual.id, { multiVersion: 2, requestId: 'multi', text: 'Comparação independente', target: 'all' });
  await wait(() => hub.conversations().filter(c => c.group === multi.group).every(c => c.turns[0]?.quotaUsage));
  await open(multi);
  await page.locator('.dual-stage .turn-quota-usage').nth(2).waitFor();
  check('Multi mostra uma medição em cada painel', await page.locator('.dual-stage .turn-quota-usage').count() === 3);
  const argon = await page.locator('.dual-stage .review-panel[data-client="antigravity"] .turn-quota-usage').innerText();
  check('Argon apresenta só semanal', argon.includes('Semanal') && !argon.includes('5 horas'));
  await page.screenshot({ path: out + '/multi.png' });

  const review = clients.codex.conversation((await create('codex')).id);
  await hub.send(review.id, 'Pedido revisto', 'review', { autoReview: {
    trigger: 'all', scope: 'request', returnToPrincipal: true,
    participant: { provider: 'claude', model: models.claude, effort: 'low' },
  } });
  await wait(() => hub.opinions.batches.some(batch => batch.conversationId === review.id && batch.jobs[0].quotaUsage));
  await open(review);
  await page.locator('.review-stage .turn-quota-usage').nth(1).waitFor();
  check('Revisor mostra principal e revisor', await page.locator('.review-stage [data-role=initial] .turn-quota-usage').count() === 1 && await page.locator('.review-stage [data-role=reviewer] .turn-quota-usage').count() === 1);
  await page.screenshot({ path: out + '/review.png' });

  const hydraChat = await create('codex');
  const { task } = await hub.claudex.create({
    conversationId: hydraChat.id, text: 'Análise Hydra', requestId: 'hydra', workflow: 1,
    roles: ['codex', 'claude', 'antigravity'], author: 'codex',
    members: Object.fromEntries(['codex', 'claude', 'antigravity'].map(provider => [provider, { model: models[provider], effort: 'low' }])),
  });
  const record = hub.claudex.record(task.id);
  await wait(() => record.roles.every(role => hub.claudex.native(record, role).status === 'running'));
  const call = (role, name, args = {}) => hub.claudex.tool([...hub.claudex.leases].find(([, lease]) => lease.taskId === task.id && lease.role === role)[0], name, args);
  for (const role of record.roles) await call(role, 'initial_position', { text: 'Posição de ' + role });
  for (const role of record.roles) await call(role, 'ready_to_conclude', await call(role, 'read_dialogue'));
  const draft = (await call('codex', 'propose_final', { ...await call('codex', 'read_dialogue'), text: 'Resposta comum Hydra', outcome: 'agreement' })).candidate;
  for (const role of record.roles) {
    const read = await call(role, 'read_dialogue');
    await call(role, 'review_final', { ...read, candidateId: draft.id, hash: draft.hash, decision: 'approve' });
    clients[role].finish(hub.claudex.native(record, role), 'Contribuição concluída');
  }
  await wait(() => record.released);
  await Promise.all(record.roles.map(role => hub.turnQuotas.settle(hub.claudex.native(record, role).turns.find(turn => turn.requestId === record.members[role].requestId))));
  await open(hydraChat);
  await page.locator('#messages > .message.assistant .turn-quota-usage').nth(2).waitFor();
  check('Resposta Hydra inclui consumo dos três participantes', await page.locator('#messages > .message.assistant .turn-quota-usage').count() === 3);
  await page.locator('.cx-card > summary').click();
  await page.locator('.cx-card .turn-quota-usage').nth(2).waitFor();
  check('Cartão Hydra conserva o total dos três', await page.locator('.cx-card .turn-quota-usage').count() === 3);
  await page.locator('#messages > .message.assistant .turn-quota-usage').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: out + '/hydra.png' });

  for (const provider of ['cursor', 'opencode']) {
    const chat = clients[provider].conversation((await create(provider)).id);
    await hub.send(chat.id, 'Pedido excluído da medição', 'excluded-' + provider);
    await wait(() => chat.status === 'completed');
    await open(chat);
    check(provider + ' sem bloco de quota', await page.locator('#messages .turn-quota-usage').count() === 0);
  }
  await open(multi);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.locator('.dual-stage .turn-quota-usage').nth(2).waitFor();
  check('Telemóvel sem transbordo horizontal', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.locator('.dual-stage .turn-quota-usage').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: out + '/mobile.png' });
  check('Sem erros JavaScript ou HTTP', errors.length === 0);
  await writeFile(out + '/results.json', JSON.stringify({ checks, errors }, null, 2));
  console.log(out);
} catch (error) {
  console.error('BROWSER', errors);
  if (page) await page.screenshot({ path: out + '/failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  server?.closeStreams();
  if (server) await new Promise(resolve => server.close(resolve));
  await hub.close();
  await rm(root, { recursive: true, force: true });
}
