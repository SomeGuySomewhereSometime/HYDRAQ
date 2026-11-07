// Exercises the real page and HTTP routes with disposable conversations and simulated clients.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { Providers } from '../lib/providers.mjs';
import { OpinionClient } from '../test/fixtures/opinion-client.mjs';
import { createHttpServer } from '../lib/http.mjs';

const root = await mkdtemp('/tmp/hydraq-multi-dock-');
const cwd = path.join(root, 'work');
const providers = ['codex', 'claude', 'antigravity', 'cursor', 'opencode'];
const clients = Object.fromEntries(providers.map(provider => [provider, new OpinionClient(provider, path.join(root, provider))]));
const catalogues = {};
const snapshot = clients.opencode.snapshot.bind(clients.opencode);
clients.opencode.snapshot = () => ({ ...snapshot(), catalogs: catalogues });
clients.opencode.refreshModels = async folder => (catalogues[folder] = { cwd: folder, models: clients.opencode.models });

const hub = new Providers({ dataDir: path.join(root, 'hub'), defaultCwd: cwd, clients, git: async () => [] });
let browser, server, releaseRemoval;
try {
  await mkdir(cwd);
  await hub.load();
  await hub.connectAll();
  const conversation = await clients.codex.create({ cwd, model: 'test', effort: 'low', sandbox: 'read-only' });
  const { dual } = await hub.startDual(conversation.id, {
    participants: ['claude', 'antigravity'].map(provider => ({ provider, model: 'test', effort: 'low' })),
  });
  server = createHttpServer({ hydraq: hub, publicDir: path.resolve('public'), looseFolderBase: path.join(root, 'loose') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.HYDRAQ_TEST_CHROMIUM || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(id => {
    if (sessionStorage.getItem('seeded')) return;
    localStorage.setItem('hydraq.conversation', id);
    localStorage.setItem('hydraq.theme', 'classic');
    sessionStorage.setItem('seeded', '1');
  }, conversation.id);
  await page.goto('http://127.0.0.1:' + server.address().port);
  const pill = id => page.locator('#agent-dock [data-agent="' + id + '"]');
  const toggle = (id, pressed) => page.locator('#agent-dock [data-agent="' + id + '"][aria-pressed="' + pressed + '"]').waitFor();

  await toggle('claude', true);
  const paused = new Promise(resolve => { releaseRemoval = resolve; });
  let removalStarted;
  const removing = new Promise(resolve => { removalStarted = resolve; });
  await page.route('**/api/dual/*/remove', async route => {
    removalStarted();
    await paused;
    await route.continue();
  });
  await pill('claude').click();
  await removing;
  await page.locator('#prompt').fill('Apenas para os participantes confirmados');
  assert.equal(await pill('claude').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#send').isDisabled(), true);
  await page.locator('#prompt').press('Enter');
  assert.equal(providers.reduce((sum, id) => sum + clients[id].logs.length, 0), 0);
  releaseRemoval();
  await toggle('claude', false);
  await page.locator('#send').click();
  await page.waitForFunction(() => !document.querySelector('#prompt').value);
  assert.equal(clients.claude.logs.length, 0);
  assert.equal(clients.codex.logs.length, 1);
  assert.equal(clients.antigravity.logs.length, 1);
  console.log('PASS remoção atrasada bloqueia o envio e só os clientes confirmados recebem');

  await pill('antigravity').click();
  await toggle('antigravity', false);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#dual-toggle').textContent.includes('1 participante'));
  await toggle('antigravity', false);
  assert.ok(hub.dual.record(dual.id).vacant);
  await page.locator('#prompt').fill('Este rascunho fica guardado');
  assert.equal(await page.locator('#send').isDisabled(), true);
  console.log('PASS lugar desligado e envio bloqueado persistem após recarregar');

  assert.deepEqual(catalogues, {});
  const catalogRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/opencode/models');
  await pill('opencode').click();
  assert.equal((await catalogRequest).postDataJSON().force, true);
  await toggle('opencode', true);
  assert.equal(hub.dual.record(dual.id).vacant, undefined);
  assert.ok(Object.values(hub.dual.record(dual.id).members).some(member => member.provider === 'opencode' && member.model === 'test'));
  console.log('PASS OpenCode carrega o catálogo vazio e preenche o lugar com um modelo válido');

  await page.locator('#new-loose-chat').click();
  await page.locator('#dual-toggle').click();
  const add = page.getByRole('button', { name: '＋ Adicionar participante', exact: true });
  await add.click();
  await add.click();
  await page.getByRole('radio', { name: 'Antigravity', exact: true }).check();
  await page.getByRole('button', { name: 'Usar no primeiro pedido', exact: true }).click();
  await toggle('claude', true);
  await pill('claude').click();
  await toggle('claude', false);
  assert.equal(await pill('antigravity').locator('.agent-pill-principal').count(), 1);
  assert.equal(await pill('cursor').locator('.agent-pill-principal').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS tirar outro cliente no rascunho conserva o principal e a página não tem erros JavaScript');
} finally {
  releaseRemoval?.();
  await browser?.close();
  server?.closeStreams();
  if (server) await new Promise(resolve => server.close(resolve));
  await hub.close();
  await rm(root, { recursive: true, force: true });
}
