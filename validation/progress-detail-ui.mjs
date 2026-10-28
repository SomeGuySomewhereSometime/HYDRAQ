// Isolated QA of the detailed progress: readable actions, running times, actions in parallel, the request summary,
// every action listed, no timer after the end, Dual panels, Hydra participants, the Activity panel and the page without
// the shared module (a server not yet restarted). Simulated clients only. node validation/progress-detail-ui.mjs [dir]
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { Providers } from '../lib/providers.mjs';
import { summarizeProgress } from '../lib/progress.mjs';
import { OpinionClient } from '../test/fixtures/opinion-client.mjs';
import { createHttpServer } from '../lib/http.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(repo, '.hydraq/progress-detail-2026-10-28'));
await mkdir(out, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), 'hydraq-progress-detail-'));
const clients = Object.fromEntries(['codex', 'claude', 'antigravity', 'cursor', 'opencode'].map(p => { const c = new OpinionClient(p, path.join(root, p), { behavior: 'hold' }); c.defaultCwd = root; return [p, c]; }));
const hub = new Providers({ dataDir: path.join(root, 'hub'), defaultCwd: root, clients, git: async () => [] });
const results = [], errors = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok) }); if (!ok) console.error('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
const until = async (predicate, ms = 8000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw Error('Tempo excedido'); await new Promise(r => setTimeout(r, 20)); } };
const ago = ms => new Date(Date.now() - ms).toISOString();
let browser, server;
try {
  await hub.load(); await hub.connectAll();
  // Real clients attach their progress to each conversation; the simulated ones get it the same way.
  const snapshot = hub.snapshot.bind(hub);
  hub.snapshot = () => { const value = snapshot(); value.conversations = value.conversations.map(c => ({ ...c, progress: summarizeProgress(c) })); return { ...value, nativeSessions: { ...(value.nativeSessions || {}), available: true, sessions: [] } }; };
  const settings = { model: 'test', effort: 'high', sandbox: 'read-only' };
  const c = await clients.codex.create({ cwd: root, ...settings }); c.title = 'Progresso detalhado';
  await hub.send(c.id, 'Corre os testes e diz o que falha.', 'now-1', settings);
  await until(() => c.status === 'running');
  const turn = c.turns.at(-1); turn.startedAt = ago(65_000);
  c.items.push({ id: 'read-1', turnId: turn.id, type: 'mcpToolCall', server: 'Claude Code', tool: 'Read', parameters: { file_path: root + '/lib/a.js', offset: 1, limit: 40 }, status: 'inProgress', at: ago(4000) },
    { id: 'cmd-1', turnId: turn.id, type: 'commandExecution', command: 'npm test', commandActions: [{ type: 'unknown', command: 'npm test' }], status: 'inProgress', at: ago(1500) });
  clients.codex.changed();
  server = createHttpServer({ hydraq: hub, publicDir: path.join(repo, 'public') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(id => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('hydraq.theme', 'atelier'); localStorage.setItem('hydraq.conversation', id); sessionStorage.setItem('seeded', '1'); } }, c.id);
  await page.goto('http://127.0.0.1:' + server.address().port);
  const card = page.locator('#messages #progress-panel');
  await card.waitFor();

  // Two actions at once: both shown, each with its time, and the request's time.
  check('parallel actions both shown', (await card.locator('strong').first().textContent()) === '2 ações em curso' && await card.locator('.progress-running li').count() === 2);
  check('each in words', /A ler lib\/a\.js · 1–40/.test(await card.locator('.progress-running').textContent()) && /A correr npm test/.test(await card.locator('.progress-running').textContent()));
  check('request time shown', /pedido 1 min 0[5-9] s/.test(await card.locator('.progress-clock').textContent()), await card.locator('.progress-clock').textContent());
  const first = await card.locator('.progress-running li').first().locator('time').textContent();
  await page.waitForTimeout(1300);
  check('running times move on their own', (await card.locator('.progress-running li').first().locator('time').textContent()) !== first, first);
  await page.screenshot({ path: out + '/progress-parallel-atelier.png' });

  // Nothing running, no text arriving: working, without claiming thinking; then text arriving.
  const read = c.items.find(i => i.id === 'read-1'); Object.assign(read, { status: 'completed', completedAt: new Date(Date.parse(read.at) + 3000).toISOString() });
  Object.assign(c.items.find(i => i.id === 'cmd-1'), { status: 'completed', exitCode: 1, durationMs: 2300, completedAt: ago(200) });
  clients.codex.changed();
  await page.waitForFunction(() => document.querySelector('#progress-panel strong')?.textContent === 'Codex a trabalhar · sem atividade detalhada', null, { timeout: 4000 }).catch(() => {});
  check('no action, no text: working without detail', (await card.locator('strong').first().textContent()) === 'Codex a trabalhar · sem atividade detalhada');
  c.messages.push({ id: 'stream', role: 'assistant', turnId: turn.id, requestId: 'now-1', text: 'Os testes', streaming: true, at: ago(0) }); clients.codex.changed();
  await page.waitForFunction(() => document.querySelector('#progress-panel strong')?.textContent === 'A escrever a resposta', null, { timeout: 4000 }).catch(() => {});
  check('text arriving: writing the answer', (await card.locator('strong').first().textContent()) === 'A escrever a resposta');
  c.messages.pop();

  // The same file read again, a refused edit and a web search; then the end.
  c.items.push({ id: 'read-2', turnId: turn.id, type: 'mcpToolCall', server: 'Claude Code', tool: 'Read', parameters: { file_path: root + '/lib/a.js', offset: 41, limit: 40 }, status: 'completed', at: ago(900), completedAt: ago(800) },
    { id: 'edit-1', turnId: turn.id, type: 'fileChange', server: 'Claude Code', tool: 'Edit', changes: [{ path: root + '/lib/a.js', diff: '' }], status: 'declined', permissionDenied: true, at: ago(700), completedAt: ago(650) },
    { id: 'web-1', turnId: turn.id, type: 'webSearch', query: 'node test runner', status: 'completed', at: ago(600), completedAt: ago(100) });
  turn.completedAt = new Date().toISOString(); clients.codex.finish(c, 'Falha o teste X.');
  await page.waitForFunction(() => document.querySelector('#progress-panel')?.dataset.status === 'completed');
  await page.waitForTimeout(300);
  const summary = await card.locator('.progress-summary').textContent();
  check('summary counts confirmed things: one file read twice is one file', summary.startsWith('Leu 1 ficheiro · 1 comando (1 falhou) · 1 pesquisa na web · 1 alteração recusada · 1 min 0'), summary);
  check('no running time after the end', await card.locator('[data-elapsed-since]').count() === 0 && /^1 min 0/.test(await card.locator('.progress-clock').textContent()));
  await card.locator('details summary').click();
  const lines = await card.locator('.progress-actions li').allTextContents();
  check('every action of the request listed', lines.length === 5, lines);
  check('client duration plain, measured duration marked', lines.some(l => /Correr npm test2,3 s · Com erro/.test(l)) && lines.some(l => /Ler lib\/a\.js · 1–40≈ 3,0 s · Concluída/.test(l)), lines);
  check('refused edit shown as refused', lines.some(l => /Alterar lib\/a\.js.*Recusada/.test(l)), lines);
  await page.screenshot({ path: out + '/progress-done-atelier.png' });

  // A long request: all its actions, beyond the 30 the summary keeps.
  await hub.send(c.id, 'Pedido longo.', 'now-2', settings); await until(() => c.status === 'running');
  const long = c.turns.at(-1);
  for (let i = 0; i < 45; i++) c.items.push({ id: 'many-' + i, turnId: long.id, type: 'commandExecution', command: 'echo ' + i, status: 'completed', exitCode: 0, at: ago(5000 - i * 10), completedAt: ago(4990 - i * 10) });
  clients.codex.finish(c, 'Feito.');
  await page.waitForFunction(() => document.querySelector('#progress-panel')?.dataset.status === 'completed' && document.querySelectorAll('#progress-panel .progress-actions li').length > 0 || document.querySelector('#progress-panel details summary')?.textContent.includes('45'), null, { timeout: 4000 }).catch(() => {});
  check('«ver todas» has all 45 actions', /Ações deste pedido · 45/.test(await card.locator('details summary').textContent()) && await card.locator('.progress-actions li').count() === 45);
  // Clients keep the last 200 actions per conversation: a request that lost its first ones says so.
  await hub.send(c.id, 'Pedido enorme.', 'now-3', settings); await until(() => c.status === 'running');
  const huge = c.turns.at(-1);
  c.items.splice(0, c.items.length, ...Array.from({ length: 200 }, (_, i) => ({ id: 'huge-' + i, turnId: huge.id, type: 'commandExecution', command: 'echo ' + i, status: 'completed', exitCode: 0, at: ago(9000 - i * 10) })));
  clients.codex.finish(c, 'Feito.');
  await page.waitForFunction(() => /últimas 200/.test(document.querySelector('#progress-panel details')?.textContent || ''), null, { timeout: 4000 }).catch(() => {});
  check('lost first actions are announced', /As primeiras ações deste pedido já não estão guardadas/.test(await card.locator('details').textContent()));
  // Interrupted with an action running: not claimed as finished, no time running.
  await hub.send(c.id, 'Pedido interrompido.', 'now-4', settings); await until(() => c.status === 'running');
  const cut = c.turns.at(-1);
  c.items.push({ id: 'cut-1', turnId: cut.id, type: 'commandExecution', command: 'sleep 60', status: 'inProgress', at: ago(2000) }); clients.codex.changed();
  await card.locator('[data-elapsed-since]').first().waitFor();
  await clients.codex.interrupt(c.id);
  await page.waitForFunction(() => document.querySelector('#progress-panel')?.dataset.status === 'interrupted');
  await card.locator('details summary').click();
  check('interrupted: action without confirmed end, no timer', await card.locator('[data-elapsed-since]').count() === 0 && /Correr sleep 60.*Sem conclusão confirmada/.test(await card.locator('.progress-actions').textContent()));
  // The Activity panel uses the same words and durations.
  check('Activity panel in the same words', /Codex · Correr sleep 60/.test(await page.locator('#activity').textContent()) || /Correr echo/.test(await page.locator('#activity').textContent()));

  // Dual: each panel says what it does now, with its time, and sums up at the end.
  const { dual } = await hub.startDual(c.id, { provider: 'claude', model: 'test', effort: 'low' });
  const partner = clients.claude.conversation(dual.members.b.conversationId);
  await page.reload(); await page.waitForFunction(() => document.querySelector('#prompt'));
  await page.locator('#prompt').fill('Comparem as duas abordagens.'); await page.locator('#send').click();
  await until(() => c.status === 'running' && partner.status === 'running');
  partner.items.push({ id: 'p-read', turnId: partner.turnId, type: 'mcpToolCall', server: 'Claude Code', tool: 'Grep', parameters: { pattern: 'hydraTask', path: root + '/public' }, status: 'inProgress', at: ago(2500) }); clients.claude.changed();
  const partnerPanel = page.locator('.dual-stage .review-panel[data-client="claude"]').last();
  await partnerPanel.locator('.review-panel-foot', { hasText: 'A procurar «hydraTask» em public' }).waitFor({ timeout: 6000 });
  check('Dual panel: current step in words with its time', await partnerPanel.locator('.review-panel-foot [data-elapsed-since]').count() === 1);
  Object.assign(partner.items.at(-1), { status: 'completed', completedAt: ago(100) }); clients.claude.finish(partner, 'Resposta do Claude.'); clients.codex.finish(c, 'Resposta do Codex.');
  await partnerPanel.locator('.dual-work-summary').waitFor({ timeout: 6000 });
  check('Dual panel: summary at the end', /1 pesquisa no projeto/.test(await partnerPanel.locator('.dual-work-summary').textContent()));
  await page.screenshot({ path: out + '/progress-dual-atelier.png' });

  // Hydra: each participant's running actions in words, with their time.
  await page.locator('#dual-hydra').click();
  await page.locator('#messages > #hydra-inline .cx-main').waitFor();
  await page.locator('#prompt').fill('Planeiem juntos.'); await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('.cx-badge')?.textContent === 'Em diálogo', null, { timeout: 8000 });
  const task = hub.claudex.records.at(-1);
  await until(() => hub.claudex.native(task, 'claude').status === 'running');
  const member = hub.claudex.native(task, 'claude');
  member.items.push({ id: 'h-read', turnId: member.turnId, type: 'mcpToolCall', server: 'Claude Code', tool: 'Read', parameters: { file_path: root + '/notas.md' }, status: 'inProgress', at: ago(3000) }); clients.claude.changed();
  await page.locator('.cx-participant[data-client="claude"] .cx-tool-activity', { hasText: 'A ler notas.md' }).waitFor({ timeout: 6000 });
  check('Hydra participant: running action in words with its time', await page.locator('.cx-participant[data-client="claude"] .cx-tool-activity [data-elapsed-since]').count() === 1);
  await page.screenshot({ path: out + '/progress-hydra-atelier.png' });
  await hub.claudex.stop(task.id).catch(() => {});

  // A server not yet restarted does not serve the shared module: the page keeps working, with the former card.
  const old = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const oldErrors = []; old.on('pageerror', e => oldErrors.push(e.message));
  await old.route('**/actions.js', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Página não encontrada."}' }));
  await old.addInitScript(id => { localStorage.setItem('hydraq.theme', 'atelier'); localStorage.setItem('hydraq.conversation', id); }, c.id);
  await old.goto('http://127.0.0.1:' + server.address().port); await old.waitForFunction(() => document.querySelector('#prompt'));
  await old.waitForTimeout(600);
  check('without the shared module the page still works', !oldErrors.length && await old.locator('#messages .message').count() > 0, oldErrors);
  await old.close();
  for (const theme of ['classic', 'mono']) {
    await page.evaluate(t => localStorage.setItem('hydraq.theme', t), theme); await page.reload(); await page.waitForTimeout(500);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(150);
      check(`${theme} ${width} no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
  }
} catch (error) { console.error('ERROR', error.stack || error.message); check('script completed', false); }
finally { await browser?.close(); server?.close(); await hub.close?.().catch(() => {}); await rm(root, { recursive: true, force: true }); }
check('no JavaScript errors', !errors.length, errors);
const summary = { out, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).map(r => r.name), results, errors };
await writeFile(path.join(out, 'results.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ out, passed: summary.passed, failed: summary.failed, errors }));
if (summary.failed.length) process.exitCode = 1;
