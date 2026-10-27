// Isolated QA of the Modo panel and of Hydra inside the conversation. Simulated clients only;
// no personal sessions. node validation/hydra-mode-ui.mjs [output-directory]
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { Providers } from '../lib/providers.mjs';
import { OpinionClient } from '../test/fixtures/opinion-client.mjs';
import { createHttpServer } from '../lib/http.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(repo, '.hydraq/hydra-mode-2026-10-26'));
await mkdir(out, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), 'hydraq-hydra-mode-'));
const clients = Object.fromEntries(['codex', 'claude', 'antigravity', 'cursor', 'opencode'].map(p => { const c = new OpinionClient(p, path.join(root, p), { behavior: 'hold' }); c.defaultCwd = root; return [p, c]; }));
for (const [role, id, name] of [['codex', 'gpt-6.1-sol', 'GPT-6.1 Sol'], ['claude', 'opus', 'Claude Opus 5.5'], ['antigravity', 'argon', 'Argon']]) clients[role].models.push({ ...clients[role].models[0], id, name });
const hub = new Providers({ dataDir: path.join(root, 'hub'), defaultCwd: root, clients, git: async () => [] });
const results = [], errors = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok) }); if (!ok) console.error('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
let browser, server;
try {
  await hub.load(); await hub.connectAll();
  const snapshot = hub.snapshot.bind(hub);
  hub.snapshot = () => { const value = snapshot(); return { ...value, nativeSessions: { ...(value.nativeSessions || {}), available: true, sessions: [] } }; };
  const normal = await clients.codex.create({ cwd: root, model: 'test', effort: 'high', sandbox: 'read-only' }); normal.title = 'Conversa normal';
  await hub.send(normal.id, 'Explica a estrutura.', 'normal-1', { model: 'test', effort: 'high', sandbox: 'read-only' });
  clients.codex.finish(clients.codex.conversations[0], 'Resposta de teste.');
  server = createHttpServer({ hydraq: hub, publicDir: path.join(repo, 'public') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(id => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('hydraq.theme', 'atelier'); localStorage.setItem('hydraq.conversation', id); sessionStorage.setItem('seeded', '1'); } }, normal.id);
  await page.goto(url); await page.waitForFunction(() => document.querySelector('#model').value);
  const tile = mode => page.locator(`.mode-tile[data-mode="${mode}"]`);
  check('mode panel above activity', await page.evaluate(() => document.querySelector('#mode-panel').compareDocumentPosition(document.querySelector('.activity-heading')) & Node.DOCUMENT_POSITION_FOLLOWING));
  check('normal active by default', await tile('normal').getAttribute('aria-pressed') === 'true');
  check('last request shows duration', /Duração/.test(await page.locator('#turn-usage').textContent()));
  check('terminal offered in the Modo panel', /Abrir no terminal · Codex/.test(await page.locator('#inspector-terminal').textContent()) && await page.locator('#inspector-terminal').isVisible());
  for (const theme of ['classic', 'mono', 'atelier']) {
    await page.evaluate(t => localStorage.setItem('hydraq.theme', t), theme); await page.reload(); await page.waitForFunction(() => document.querySelector('#model').value);
    await page.screenshot({ path: `${out}/normal-${theme}-1440.png` });
  }
  check('Linho is no longer offered', !await page.evaluate(() => [...document.querySelectorAll('#appearance-choices [role=radio]')].some(el => /Linho/.test(el.textContent))));
  // Client chips drive the composer.
  await page.locator('#mode-setup .mode-chip[data-client="claude"]').click();
  check('client chip switches composer provider', await page.locator('#provider').inputValue() === 'claude');
  await page.locator('#mode-setup .mode-chip[data-client="codex"]').click();
  await page.locator('#mode-setup .mode-current').click();
  check('model list expands', await page.locator('#mode-setup .mode-field:has(.mode-current) .mode-chips').isVisible());
  await page.locator('#mode-setup .mode-field:has(.mode-current) .mode-chip', { hasText: 'GPT-6.1 Sol' }).click();
  check('model chip sets composer model', await page.locator('#model').inputValue() === 'gpt-6.1-sol');
  check('model list collapses after choice', !await page.locator('#mode-setup .mode-field:has(.mode-current) .mode-chips').isVisible());
  // Hydra from a new conversation: each participant gets its own conversation (Hydra in a conversation with
  // history stays in it; see hydra-inplace-ui.mjs).
  await page.locator('#new-chat').click();
  await tile('hydra').click();
  await page.locator('#hydra-inline .cx-main').waitFor();
  check('hydra in a new conversation keeps it new', await page.evaluate(() => !localStorage.getItem('hydraq.conversation')));
  check('no history toggle any more', await page.locator('#hydra-view').count() === 0);
  check('task card shown in the conversation', await page.locator('#messages > #hydra-inline').isVisible() && await page.locator('#messages .welcome').count() === 0);
  check('hydra tile pressed', await tile('hydra').getAttribute('aria-pressed') === 'true');
  check('pairs visible', await page.locator('#hydra-pairs').isVisible() && await page.locator('.hydra-pair').count() === 3);
  check('composer shows only hydra chip', await page.locator('#hydra-chip').isVisible() && !await page.locator('#model').isVisible() && !await page.locator('#review-toggle').isVisible());
  check('send label starts ClaudeX', /Iniciar ClaudeX/.test(await page.locator('#send').textContent()));
  check('settings form hidden inline', !await page.locator('#hydra-inline .cx-settings').isVisible() && !await page.locator('#cx-prompt').isVisible());
  check('intro shown', await page.locator('#hydra-inline .cx-intro').isVisible());
  check('two participant cards', await page.locator('.mode-participant').count() === 2);
  await page.screenshot({ path: out + '/hydra-new-atelier.png' });
  await page.locator('.hydra-pair[data-pair="codex+antigravity"]').click();
  check('Geminex pair applied', (await page.locator('#hydra-inline .cx-heading h1').textContent()) === 'Geminex' && await page.locator('.mode-participant[data-client="antigravity"]').count() === 1);
  await page.locator('.hydra-pair[data-pair="claude+antigravity"]').click();
  check('Claudini pair applied', (await page.locator('#hydra-inline .cx-heading h1').textContent()) === 'Claudini');
  await page.screenshot({ path: out + '/hydra-claudini-atelier.png' });
  await page.locator('.hydra-pair[data-pair="codex+claude"]').click();
  check('ClaudeX pair applied', (await page.locator('#hydra-inline .cx-heading h1').textContent()) === 'ClaudeX');
  // Models of each participant and guards via the panel.
  for (const role of ['codex', 'claude']) {
    await page.locator(`.mode-participant[data-client="${role}"] .mode-current`).click();
    await page.locator(`.mode-participant[data-client="${role}"] .mode-chip`, { hasText: 'Modelo teste' }).click();
    check(role + ' model via panel', await page.locator(`#cx-${role}Model`).inputValue() === 'test');
  }
  const numbers = page.locator('.mode-guards input');
  await numbers.nth(0).fill('0'); await numbers.nth(1).fill('0');
  check('guards mirrored', await page.locator('#cx-guardTurns').inputValue() === '0' && await page.locator('#cx-guardMinutes').inputValue() === '0');
  await page.locator('.mode-field', { hasText: 'Autor da resposta comum' }).locator('.mode-chip', { hasText: 'Claude Code' }).click();
  check('author mirrored', await page.locator('#cx-author').inputValue() === 'claude');
  // Send from the normal composer.
  await page.locator('#prompt').fill('Planear um organizador offline.');
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('.cx-badge')?.textContent === 'Em diálogo', null, { timeout: 8000 });
  const r = hub.claudex.records[0];
  check('task created with pair, models, author and guards', r && r.roles.join() === 'codex,claude' && r.members.codex.model === 'test' && r.author === 'claude' && r.guards.turns === 0);
  await page.waitForFunction(() => localStorage.getItem('hydraq.conversation'), null, { timeout: 4000 }).catch(() => {});
  const selectedId = await page.evaluate(() => localStorage.getItem('hydraq.conversation'));
  check('conversation selected is the task group', [r.members.codex.conversationId, r.members.claude.conversationId].includes(selectedId), selectedId);
  await page.locator('#messages > .hydra-request', { hasText: 'Planear um organizador offline.' }).waitFor({ timeout: 4000 }).catch(() => {});
  check('request shown as the person\'s message, then the card', await page.evaluate(() => document.querySelector('#messages > .hydra-request')?.nextElementSibling?.id === 'hydra-inline'));
  check('inline hint not duplicated', !await page.locator('#hydra-inline .cx-actions .cx-hint').isVisible());
  check('composer cleared', await page.locator('#prompt').inputValue() === '');
  check('send label updates both', /Atualizar o pedido dos dois/.test(await page.locator('#send').textContent()));
  check('stop pauses both', await page.locator('#stop').isVisible() && /Pausar os dois/.test(await page.locator('#stop').textContent()));
  check('pair fixed after start', await page.locator('.hydra-pair[data-pair="codex+antigravity"]').isDisabled());
  check('sidebar lists the hydra conversation', await page.locator('#conversation-list').getByText(/ClaudeX · Planear um organizador/).count() >= 1);
  const call = (role, name, args = {}) => hub.claudex.tool([...hub.claudex.leases].find(([, l]) => l.taskId === r.id && l.role === role)[0], name, args);
  await page.waitForTimeout(300);
  for (const role of ['codex', 'claude']) await call(role, 'initial_position', { text: 'Posição ' + role });
  await call('claude', 'send_to_peer', { messageId: 'x1', type: 'discovery', text: 'O sistema tem de funcionar offline e exportar JSON.' });
  await page.locator('#hydra-inline .cx-message', { hasText: 'exportar JSON' }).waitFor();
  check('dialogue shown inline', await page.locator('#hydra-inline .cx-message[data-client="claude"]').count() >= 1);
  check('request can be copied from its message', await page.locator('#messages > .hydra-request .copy-message').count() === 1 && !await page.locator('#hydra-inline .cx-goal').isVisible());
  check('terminal not offered for a hydra member', !await page.locator('#inspector-terminal').isVisible() && !await page.locator('#terminal-switch').isVisible());
  await page.screenshot({ path: out + '/hydra-running-atelier.png' });
  // Update request through the composer.
  await page.locator('#prompt').fill('Também deve permitir importar JSON.');
  await page.locator('#send').click();
  await page.locator('#messages > .hydra-request', { hasText: 'importar JSON' }).waitFor();
  check('update reaches the task', r.revision === 2);
  // Pause through the composer stop.
  await page.locator('#stop').click();
  await page.waitForFunction(() => /Retomar a mesma tarefa/.test(document.querySelector('#send').textContent), null, { timeout: 8000 });
  check('paused: resume offered with empty box', !await page.locator('#send').isDisabled());
  check('paused: guards editable in panel', !await numbers.nth(0).isDisabled());
  // Leaving: Normal starts a new conversation; the task conversation reopens inline from the sidebar.
  await tile('normal').click();
  check('normal leaves hydra', !await page.locator('#hydra-inline').isVisible() && await page.locator('#messages').isVisible() && await page.locator('#model').isVisible());
  await page.locator('#conversation-list').getByText(/ClaudeX · Planear um organizador/).first().click();
  await page.locator('#messages > .hydra-request', { hasText: 'importar JSON' }).waitFor();
  check('sidebar reopens task inline', await page.locator('#hydra-inline').isVisible() && await tile('hydra').getAttribute('aria-pressed') === 'true');
  // The Hydra tab still shows the same task.
  await page.locator('#tab-claudex').click();
  check('tab shows same task', await page.locator('#claudex-view .cx-main').isVisible() && await page.locator('#claudex-view .cx-message', { hasText: 'importar JSON' }).count() === 1);
  check('tab shows settings form', await page.locator('#claudex-view .cx-settings').isVisible() && await page.locator('#cx-prompt').isVisible());
  await page.locator('#tab-conversations').click();
  await page.locator('#hydra-inline .cx-main').waitFor();
  check('back to conversation inline', await page.locator('#messages > .hydra-request', { hasText: 'importar JSON' }).count() === 1 && await page.locator('#hydra-inline .cx-message', { hasText: 'exportar JSON' }).isVisible());
  for (const theme of ['classic', 'mono', 'atelier']) {
    await page.evaluate(t => localStorage.setItem('hydraq.theme', t), theme); await page.reload();
    await page.locator('#hydra-inline .cx-main').waitFor();
    const loaded = await page.locator('#hydra-inline .cx-message', { hasText: 'exportar JSON' }).waitFor({ timeout: 900 }).then(() => true, () => false);
    check(`${theme} reload shows the dialogue at once`, loaded);
    check(`${theme} panel shows the task models`, await page.locator('.mode-participant[data-client="codex"] .mode-current').textContent() === 'Modelo teste');
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(150);
      check(`${theme} ${width} no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: `${out}/hydra-task-${theme}-${width}.png` });
    }
  }
  // Resume through the composer, finish the task, then a new request opens a new task from its progress.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('.cx-badge')?.textContent === 'Em diálogo', null, { timeout: 8000 });
  const startedBy = Date.now() + 6000;
  while (!['codex', 'claude'].every(role => hub.claudex.native(r, role).status === 'running')) { if (Date.now() > startedBy) throw Error('Participantes não retomaram'); await page.waitForTimeout(20); }
  for (const role of ['codex', 'claude']) await call(role, 'ready_to_conclude', await call(role, 'read_dialogue'));
  const draft = (await call('claude', 'propose_final', { ...await call('claude', 'read_dialogue'), text: 'Plano comum: funcionar offline, exportar e importar JSON.' })).candidate;
  for (const role of ['codex', 'claude']) { const v = await call(role, 'read_dialogue'); await call(role, 'review_final', { candidateId: draft.id, hash: draft.hash, revision: v.revision, reviewedThrough: v.reviewedThrough, decision: 'approve' }); clients[role].finish(hub.claudex.native(r, role), 'Contribuição terminada.'); }
  await page.locator('#messages .message.assistant', { hasText: 'Plano comum' }).waitFor({ timeout: 8000 });
  check('published result follows the card in the conversation', await page.evaluate(() => { const card = document.querySelector('#messages > #hydra-inline'), answer = [...document.querySelectorAll('#messages > .message.assistant')].find(e => e.textContent.includes('Plano comum')); return Boolean(card && answer && card.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING); }) && !await page.locator('#hydra-inline .cx-result').isVisible() && await page.locator('#messages .message.user:not(.hydra-request)', { hasText: 'Planear um organizador offline.' }).count() === 0);
  // The card's buttons follow the result shown in the conversation without waiting for the next poll (1,2 s).
  await page.waitForFunction(() => /Nova tarefa a partir deste progresso/.test(document.querySelector('#send').textContent), null, { timeout: 700 }).catch(() => {});
  check('finished task offers a new task from its progress', /Nova tarefa a partir deste progresso/.test(await page.locator('#send').textContent()));
  const before = await page.evaluate(() => localStorage.getItem('hydraq.conversation'));
  await page.locator('#prompt').fill('Aprofundar a exportação.');
  await page.locator('#send').click();
  await page.waitForFunction(old => localStorage.getItem('hydraq.conversation') && localStorage.getItem('hydraq.conversation') !== old, before, { timeout: 8000 }).catch(() => {});
  const next = hub.claudex.records.find(record => record.id !== r.id), opened = await page.evaluate(() => localStorage.getItem('hydraq.conversation'));
  check('new task from progress opened here', Boolean(next) && Object.values(next.members).some(member => member.conversationId === opened), { opened, next: next?.id });
  await page.locator('#hydra-inline .cx-message', { hasText: 'Progresso anterior incluído' }).waitFor({ timeout: 4000 }).catch(() => {});
  check('new task shows the carried progress', await page.locator('#hydra-inline .cx-message', { hasText: 'Progresso anterior incluído' }).count() === 1);
  // Dual while the new pair works in this folder: a new conversation and an explanation, no silent click.
  await tile('dual').click();
  check('dual blocked by running pair is explained', !await page.locator('#hydra-inline').isVisible() && /O Dual fica disponível/.test(await page.locator('#toast').textContent()) && await page.locator('dialog.dual-dialog[open]').count() === 0);
  await page.locator('#conversation-list').getByText(/ClaudeX · Aprofundar a exportação/).first().click();
  await page.locator('#hydra-inline .cx-main').waitFor();
  await page.waitForFunction(() => /Pausar os dois/.test(document.querySelector('#stop').textContent) && !document.querySelector('#stop').classList.contains('hidden'), null, { timeout: 8000 });
  await page.locator('#stop').click();
  await page.waitForFunction(() => /Retomar a mesma tarefa/.test(document.querySelector('#send').textContent), null, { timeout: 8000 });
  // Dual and Revisor tiles open their dialogs from a new conversation.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await tile('dual').click();
  check('dual tile leaves hydra and opens dual dialog', await page.locator('dialog.dual-dialog[open]').count() === 1 && !await page.locator('#hydra-inline').isVisible());
  await page.keyboard.press('Escape');
  await tile('review').click();
  check('review tile opens reviewer dialog', await page.locator('dialog.opinion-dialog[open]').count() >= 1);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  check('390 no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
} catch (error) { console.error('ERROR', error.stack || error.message); check('script completed', false); }
finally { await browser?.close(); server?.close(); await hub.close?.().catch(() => {}); await rm(root, { recursive: true, force: true }); }
check('no JavaScript errors', !errors.length, errors);
const summary = { out, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).map(r => r.name), results, errors };
await writeFile(path.join(out, 'results.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ out, passed: summary.passed, failed: summary.failed, errors }));
if (summary.failed.length) process.exitCode = 1;
