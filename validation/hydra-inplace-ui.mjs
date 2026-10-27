// Isolated QA of Hydra in a conversation with history: Normal → Dual → Hydra → Dual → Hydra → Normal in one
// conversation. Simulated clients only; no personal sessions. node validation/hydra-inplace-ui.mjs [output-directory]
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { Providers } from '../lib/providers.mjs';
import { OpinionClient } from '../test/fixtures/opinion-client.mjs';
import { createHttpServer } from '../lib/http.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(repo, '.hydraq/hydra-inplace-2026-10-27'));
await mkdir(out, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), 'hydraq-hydra-inplace-'));
const clients = Object.fromEntries(['codex', 'claude', 'antigravity', 'cursor', 'opencode'].map(p => { const c = new OpinionClient(p, path.join(root, p), { behavior: 'hold' }); c.defaultCwd = root; return [p, c]; }));
const hub = new Providers({ dataDir: path.join(root, 'hub'), defaultCwd: root, clients, git: async () => [] });
const results = [], errors = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok) }); if (!ok) console.error('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
const until = async (predicate, ms = 8000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw Error('Tempo excedido'); await new Promise(r => setTimeout(r, 20)); } };
let browser, server;
try {
  await hub.load(); await hub.connectAll();
  const snapshot = hub.snapshot.bind(hub);
  hub.snapshot = () => { const value = snapshot(); return { ...value, nativeSessions: { ...(value.nativeSessions || {}), available: true, sessions: [] } }; };
  const normal = await clients.codex.create({ cwd: root, model: 'test', effort: 'high', sandbox: 'workspace-write' }); normal.title = 'Conversa com histórico';
  await hub.send(normal.id, 'Explica a estrutura.', 'normal-1', { model: 'test', effort: 'high', sandbox: 'workspace-write' });
  clients.codex.finish(normal, 'RESPOSTA-ANTES-DO-HYDRA');
  const { dual } = await hub.startDual(normal.id, { provider: 'claude', model: 'test', effort: 'low' });
  const partner = clients.claude.conversation(dual.members.b.conversationId);
  const conversationsBefore = hub.conversations().length;
  server = createHttpServer({ hydraq: hub, publicDir: path.join(repo, 'public') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(id => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('hydraq.theme', 'atelier'); localStorage.setItem('hydraq.conversation', id); sessionStorage.setItem('seeded', '1'); } }, normal.id);
  await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForFunction(() => document.querySelector('#model').value);
  const tile = mode => page.locator(`.mode-tile[data-mode="${mode}"]`), selected = () => page.evaluate(() => localStorage.getItem('hydraq.conversation'));
  const call = (r, role, name, args = {}) => hub.claudex.tool([...hub.claudex.leases].find(([, l]) => l.taskId === r.id && l.role === role)[0], name, args);
  check('starts in Dual', await tile('dual').getAttribute('aria-pressed') === 'true');

  // Hydra stays in this conversation; its history is one click away.
  await tile('hydra').click();
  await page.locator('#hydra-inline .cx-main').waitFor();
  check('hydra stays in the conversation', await selected() === normal.id);
  check('task view shown, history toggle offered', await page.locator('#hydra-inline').isVisible() && !await page.locator('#messages').isVisible() && await page.locator('#hydra-view').isVisible());
  await page.locator('#hydra-view').click();
  check('toggle shows the earlier conversation', await page.locator('#messages').isVisible() && await page.locator('#messages').getByText('RESPOSTA-ANTES-DO-HYDRA').count() === 1 && !await page.locator('#hydra-inline').isVisible());
  check('toggle label flips', (await page.locator('#hydra-view').textContent()) === 'Ver o Hydra' && await page.locator('#hydra-chip').isVisible());
  await page.locator('#hydra-view').click();
  check('toggle returns to the task view', await page.locator('#hydra-inline').isVisible() && !await page.locator('#messages').isVisible());
  await page.locator('#prompt').fill('Comparar duas abordagens.');
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('.cx-badge')?.textContent === 'Em diálogo', null, { timeout: 8000 });
  const first = hub.claudex.records[0];
  check('task runs in place with the Dual sessions', first.inPlace && first.members.codex.conversationId === normal.id && first.members.claude.conversationId === partner.id, first.members);
  check('no new conversation', hub.conversations().length === conversationsBefore && await selected() === normal.id);
  await until(() => ['codex', 'claude'].every(role => hub.claudex.native(first, role).status === 'running'));
  for (const role of ['codex', 'claude']) await call(first, role, 'initial_position', { text: 'Posição ' + role });
  await call(first, 'claude', 'send_to_peer', { messageId: 'p1', type: 'discovery', text: 'A segunda abordagem funciona offline.' });
  await page.locator('#hydra-inline .cx-message', { hasText: 'funciona offline' }).waitFor();
  check('dialogue shown in the task view', true);
  await page.locator('#hydra-view').click();
  await page.locator('#messages .handoff-note', { hasText: 'Hydra · ronda do Codex' }).waitFor();
  check('rounds noted in the conversation, not as handoff summaries', await page.locator('#messages .handoff-note', { hasText: 'Hydra · ronda do Claude' }).count() >= 1 && await page.locator('#messages', { hasText: 'resumo de passagem' }).count() === 0);
  await page.screenshot({ path: out + '/inplace-history-atelier.png' });
  await page.locator('#hydra-view').click();
  await page.screenshot({ path: out + '/inplace-task-atelier.png' });
  // Both approve; the conversation comes back to Dual with the result in it.
  for (const role of ['codex', 'claude']) await call(first, role, 'ready_to_conclude', await call(first, role, 'read_dialogue'));
  const draft = (await call(first, first.author, 'propose_final', { ...await call(first, first.author, 'read_dialogue'), text: 'PLANO-COMUM: segunda abordagem.' })).candidate;
  for (const role of ['codex', 'claude']) { const v = await call(first, role, 'read_dialogue'); await call(first, role, 'review_final', { candidateId: draft.id, hash: draft.hash, revision: v.revision, reviewedThrough: v.reviewedThrough, decision: 'approve' }); clients[role].finish(hub.claudex.native(first, role), 'Contribuição terminada.'); }
  await until(() => first.released);
  await page.waitForFunction(() => document.querySelector('.mode-tile[data-mode="dual"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 8000 });
  check('back to Dual after the task', await page.locator('#messages').isVisible() && await page.locator('#hydra-inline').isHidden() && await tile('hydra').getAttribute('aria-pressed') === 'false');
  check('common result in the conversation', await page.locator('#messages .message.assistant', { hasText: 'PLANO-COMUM' }).count() === 1);
  check('settings restored', normal.sandbox === 'workspace-write' && normal.claudexTask === undefined && partner.claudexTask === undefined);
  await page.screenshot({ path: out + '/inplace-back-to-dual-atelier.png' });

  // Hydra again; leaving to Normal stops it, gives the conversation back and turns Dual off.
  await tile('hydra').click();
  await page.locator('#hydra-inline .cx-main').waitFor();
  await page.locator('#prompt').fill('Segunda tarefa.');
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('.cx-badge')?.textContent === 'Em diálogo', null, { timeout: 8000 });
  const second = hub.claudex.records.find(record => record.id !== first.id);
  check('second task in the same conversation', second?.inPlace && second.members.codex.conversationId === normal.id && await selected() === normal.id);
  await tile('normal').click();
  check('leaving is explained', await page.waitForFunction(() => /parado/.test(document.querySelector('#toast')?.textContent), null, { timeout: 4000 }).then(() => true, () => false));
  await until(() => second.released, 10000);
  // From Dual, Normal opens the Dual dialog to turn it off, as without Hydra.
  await page.locator('dialog.dual-dialog[open]').waitFor({ timeout: 10000 });
  check('back in Dual first, then its dialog', second.status === 'interrupted' && await page.locator('#hydra-inline').isHidden() && await page.locator('#messages').isVisible());
  await page.locator('dialog.dual-dialog[open] button', { hasText: 'Desligar Dual' }).click();
  await page.waitForFunction(() => document.querySelector('.mode-tile[data-mode="normal"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 10000 });
  check('normal after leaving: Dual off', await tile('dual').getAttribute('aria-pressed') === 'false' && await page.locator('#model').isVisible());
  await page.locator('#prompt').fill('Continua sem o Hydra.');
  await page.locator('#send').click();
  await until(() => clients.codex.logs.at(-1)?.text.includes('Continua sem o Hydra.'));
  check('next request tells the model the task ended', /\[HYDRAQ\] A tarefa ClaudeX desta conversa terminou \(parada pelo utilizador\)/.test(clients.codex.logs.at(-1).text));
  clients.codex.finish(normal, 'Resposta normal.');
  for (const theme of ['classic', 'mono', 'atelier']) {
    await page.evaluate(t => localStorage.setItem('hydraq.theme', t), theme); await page.reload(); await page.waitForFunction(() => document.querySelector('#model').value);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(150);
      check(`${theme} ${width} no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: `${out}/inplace-after-${theme}-${width}.png` });
    }
  }
} catch (error) { console.error('ERROR', error.stack || error.message); check('script completed', false); }
finally { await browser?.close(); server?.close(); await hub.close?.().catch(() => {}); await rm(root, { recursive: true, force: true }); }
check('no JavaScript errors', !errors.length, errors);
const summary = { out, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).map(r => r.name), results, errors };
await writeFile(path.join(out, 'results.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ out, passed: summary.passed, failed: summary.failed, errors }));
if (summary.failed.length) process.exitCode = 1;
