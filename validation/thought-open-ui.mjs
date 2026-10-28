// Isolated QA of the reasoning box: for agy and Cursor it is open while the request runs and closes when the answer
// is ready; the person can close or open it, and that choice holds for that request and phase. Claude keeps its box
// closed unless opened. Progress card and Dual panel. Simulated clients only.
// node validation/thought-open-ui.mjs [evidence-directory]
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { Providers } from '../lib/providers.mjs';
import { summarizeProgress } from '../lib/progress.mjs';
import { OpinionClient } from '../test/fixtures/opinion-client.mjs';
import { createHttpServer } from '../lib/http.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(repo, '.hydraq/thought-open-2026-10-28'));
await mkdir(out, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), 'hydraq-thought-open-'));
const clients = Object.fromEntries(['codex', 'claude', 'antigravity', 'cursor'].map(p => { const c = new OpinionClient(p, path.join(root, p), { behavior: 'hold' }); c.defaultCwd = root; return [p, c]; }));
const hub = new Providers({ dataDir: path.join(root, 'hub'), defaultCwd: root, clients, git: async () => [] });
const results = [], errors = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok) }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + JSON.stringify(detail))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (predicate, ms = 8000) => { const end = Date.now() + ms; while (!(await predicate())) { if (Date.now() > end) throw Error('Tempo excedido'); await sleep(20); } };
const settings = { model: 'test', effort: 'high', sandbox: 'read-only' };
const think = (client, c, text) => { c.items.push({ id: 'r-' + Math.random(), turnId: c.turns.at(-1).id, type: 'reasoning', summary: text, status: 'completed', at: new Date().toISOString() }); client.changed(); };
let browser, server;
try {
  await hub.load(); await hub.connectAll();
  const snapshot = hub.snapshot.bind(hub);
  hub.snapshot = () => { const value = snapshot(); value.conversations = value.conversations.map(c => ({ ...c, progress: summarizeProgress(c) })); return value; };
  server = createHttpServer({ hydraq: hub, publicDir: path.join(repo, 'public') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  for (const [provider, label, opens] of [['antigravity', 'Resumo do raciocínio · Antigravity', true], ['cursor', 'Raciocínio · Cursor', true], ['claude', 'Resumo do raciocínio · Claude', false]]) {
    const client = clients[provider], c = await client.create({ cwd: root, ...settings }); c.title = 'Raciocínio ' + provider;
    await hub.send(c.id, 'Analisa o projeto.', provider + '-1', settings); await until(() => c.status === 'running');
    think(client, c, 'Primeiro resumo.');
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(id => { localStorage.setItem('hydraq.theme', 'atelier'); localStorage.setItem('hydraq.conversation', id); }, c.id);
    await page.goto('http://127.0.0.1:' + server.address().port);
    const box = page.locator('#progress-panel .claude-thought'), open = async () => (await box.getAttribute('open')) !== null, text = () => page.locator('#progress-panel .claude-thought-text').textContent();
    await box.waitFor();
    check(`${provider}: «${label}»`, (await box.locator('summary').textContent()) === label);
    check(`${provider}: ${opens ? 'aberto' : 'fechado'} enquanto trabalha`, (await open()) === opens);
    if (!opens) {
      // Claude as before: closed until opened, and it stays as the person left it.
      await box.locator('summary').click(); think(client, c, 'Segundo resumo.'); await until(async () => (await text()) === 'Segundo resumo.');
      check('claude: aberto pela pessoa, continua aberto com o resumo novo', await open());
      client.finish(c, 'Resposta.'); await until(async () => (await page.locator('#progress-panel').getAttribute('data-status')) === 'completed');
      check('claude: no fim fica como a pessoa o deixou', await open());
      await page.close(); continue;
    }
    await page.screenshot({ path: path.join(out, `${provider}-a-trabalhar.png`) });
    // A new summary arrives: still open, with the new text.
    think(client, c, 'Segundo resumo.'); await until(async () => (await text()) === 'Segundo resumo.');
    check(`${provider}: o resumo novo aparece aberto`, await open());
    // The person closes it: it stays closed while the request runs.
    await box.locator('summary').click(); await until(async () => !(await open()));
    think(client, c, 'Terceiro resumo.'); await until(async () => (await text()) === 'Terceiro resumo.');
    check(`${provider}: fechado pela pessoa, continua fechado com o resumo novo`, !(await open()));
    // The answer is ready: closed.
    await box.locator('summary').click(); await until(open);
    client.finish(c, 'Resposta final.'); await until(async () => (await page.locator('#progress-panel').getAttribute('data-status')) === 'completed');
    check(`${provider}: fecha quando a resposta fica pronta`, !(await open()));
    await page.screenshot({ path: path.join(out, `${provider}-concluido.png`) });
    // Opened after the end: stays open.
    await box.locator('summary').click(); await until(open); client.changed(); await sleep(300);
    check(`${provider}: aberto depois do fim, continua aberto`, await open());
    // Next request: open again, whatever was chosen before.
    await hub.send(c.id, 'E agora?', provider + '-2', settings); await until(() => c.status === 'running');
    think(client, c, 'Resumo do pedido seguinte.'); await until(async () => (await text()) === 'Resumo do pedido seguinte.');
    check(`${provider}: o pedido seguinte volta a abrir`, await open());
    client.finish(c, 'Outra resposta.'); await until(async () => (await page.locator('#progress-panel').getAttribute('data-status')) === 'completed');
    await page.close();
  }

  // Dual: agy's panel follows the same rule.
  const a = await clients.codex.create({ cwd: root, ...settings }); a.title = 'Dual com agy';
  await hub.send(a.id, 'Olá.', 'dual-0', settings); clients.codex.finish(a, 'Olá.');
  const { dual } = await hub.startDual(a.id, { provider: 'antigravity', model: 'test', effort: 'low' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(id => { localStorage.setItem('hydraq.theme', 'atelier'); localStorage.setItem('hydraq.conversation', id); }, a.id);
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.locator('#composer-input, textarea').first().fill('Compara as duas abordagens.');
  await page.keyboard.press('Enter');
  const partner = clients.antigravity.conversation(dual.members.b.conversationId);
  await until(() => partner.status === 'running');
  think(clients.antigravity, partner, 'Resumo no Dual.');
  const panel = page.locator('.dual-stage .review-panel[data-client="antigravity"]').last(), dualBox = panel.locator('.claude-thought');
  await dualBox.waitFor({ timeout: 8000 });
  check('Dual agy: aberto enquanto trabalha', (await dualBox.getAttribute('open')) !== null);
  await page.screenshot({ path: path.join(out, 'dual-a-trabalhar.png') });
  for (const conversation of [clients.codex.conversation(dual.members.a.conversationId), partner]) (conversation === partner ? clients.antigravity : clients.codex).finish(conversation, 'Resposta do Dual.');
  await until(async () => (await panel.getAttribute('data-live')) === 'false');
  check('Dual agy: fecha quando a resposta fica pronta', (await dualBox.getAttribute('open')) === null);
  // Hydra: agy's participant open while it works and closed when done; Claude's stays closed. View isolated from the task scheduler.
  const hydra = await page.evaluate(async () => {
    const { ClaudeXUI } = await import('./claudex.js'), state = { providers: { claude: { models: [{ id: 'haiku', efforts: ['low'] }] }, antigravity: { models: [{ id: 'flash', efforts: ['low'] }] } }, claudex: { records: [] }, approvals: [], projectCatalog: { projects: [] } };
    const ui = new ClaudeXUI({ api: async () => ({}), getState: () => state, area: { view: 'claudex' }, toast() {}, markdown: t => { const e = document.createElement('p'); e.textContent = t; return e; } }); clearInterval(ui.timer);
    const detail = status => ({ id: 'fixture', cwd: '/tmp', roles: ['claude', 'antigravity'], status: 'discussing', author: 'claude', consensus: false, guards: { turns: 30, minutes: 60 }, members: { claude: { model: 'haiku', requestId: 'r-claude' }, antigravity: { model: 'flash', requestId: 'r-agy' } }, participants: { claude: { status, thought: 'Resumo do Claude.', thoughtLabel: 'Resumo do raciocínio · Claude', thoughtOpensLive: false }, antigravity: { status, thought: 'Resumo do agy.', thoughtLabel: 'Resumo do raciocínio · Antigravity', thoughtOpensLive: true } }, messages: [{ type: 'request', text: 'Pedido comum', seq: 1 }], candidates: [], approvals: {} });
    const open = role => ui.participants.querySelector(`[data-client="${role}"] .claude-thought`)?.open;
    ui.selected = 'fixture'; ui.detail = detail('running'); ui.renderDetail(); const working = { agy: open('antigravity'), claude: open('claude') };
    ui.detail = detail('completed'); ui.renderDetail(); return { working, done: { agy: open('antigravity'), claude: open('claude') } };
  });
  check('Hydra agy: aberto enquanto trabalha, Claude fechado', hydra.working.agy === true && hydra.working.claude === false, hydra);
  check('Hydra agy: fecha quando acaba', hydra.done.agy === false, hydra);
  await page.close();
  check('Sem erros de JavaScript', !errors.length, errors);
} catch (error) { check('Validação sem erros', false, error.message); }
finally {
  await browser?.close(); server?.close(); await hub.close?.().catch(() => {});
  console.log(JSON.stringify({ out, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).map(r => r.name), errors }));
  setTimeout(() => process.exit(0), 300).unref();
}
