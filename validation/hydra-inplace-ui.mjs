// Isolated QA of Hydra in a conversation with history: Normal → Dual → Hydra → Dual → Hydra → Normal, a reload,
// then another Hydra that pauses. The conversation stays in view throughout: the person's requests are their
// messages, each task is a card in its place and the common answer follows it, with nothing shown twice.
// Simulated clients only; no personal sessions. node validation/hydra-inplace-ui.mjs [output-directory]
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
// The transcript's top-level entries, in order: what the person sees from top to bottom.
const transcript = page => page.evaluate(() => [...document.querySelector('#messages').children].map(e => e.id === 'hydra-inline' ? 'live:' + e.querySelector('.cx-badge')?.textContent : e.classList.contains('cx-card') ? 'card:' + e.dataset.status : e.classList.contains('hydra-request') ? 'request:' + e.querySelector('.message-content').textContent : e.classList.contains('message') ? (e.classList.contains('user') ? 'user:' : 'answer:') + e.querySelector('.message-content')?.textContent.trim() : e.className));
const inOrder = (list, ...wanted) => { let at = -1; for (const w of wanted) { const next = list.findIndex((entry, i) => i > at && entry.startsWith(w)); if (next < 0) return false; at = next; } return true; };
const once = (list, prefix) => list.filter(entry => entry.startsWith(prefix)).length === 1;
let browser, server;
try {
  await hub.load(); await hub.connectAll();
  const snapshot = hub.snapshot.bind(hub);
  hub.snapshot = () => { const value = snapshot(); return { ...value, nativeSessions: { ...(value.nativeSessions || {}), available: true, sessions: [] } }; };
  const normal = await clients.codex.create({ cwd: root, model: 'test', effort: 'high', sandbox: 'workspace-write' }); normal.title = 'Conversa com histórico';
  for (const [index, text] of ['Olá.', 'Explica a estrutura.', 'E os testes?'].entries()) {
    await hub.send(normal.id, text, 'normal-' + index, { model: 'test', effort: 'high', sandbox: 'workspace-write' });
    clients.codex.finish(normal, index === 1 ? 'RESPOSTA-ANTES-DO-HYDRA' : 'Resposta ' + index + '. ' + 'Texto de enchimento para dar altura ao histórico. '.repeat(12));
  }
  const { dual } = await hub.startDual(normal.id, { provider: 'claude', model: 'test', effort: 'low' });
  const partner = clients.claude.conversation(dual.members.b.conversationId);
  const conversationsBefore = hub.conversations().length;
  server = createHttpServer({ hydraq: hub, publicDir: path.join(repo, 'public') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(id => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('hydraq.theme', 'atelier'); localStorage.setItem('hydraq.conversation', id); sessionStorage.setItem('seeded', '1'); } }, normal.id);
  await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForFunction(() => document.querySelector('#model').value);
  const tile = mode => page.locator(`.mode-tile[data-mode="${mode}"]`), selected = () => page.evaluate(() => localStorage.getItem('hydraq.conversation'));
  const call = (r, role, name, args = {}) => hub.claudex.tool([...hub.claudex.leases].find(([, l]) => l.taskId === r.id && l.role === role)[0], name, args);
  const scrollTo = where => page.evaluate(where => { const view = document.querySelector('#messages'); view.scrollTop = where === 'top' ? 0 : view.scrollHeight; view.dispatchEvent(new Event('scroll')); }, where);
  const scrollTop = () => page.evaluate(() => document.querySelector('#messages').scrollTop);
  const atBottom = () => page.evaluate(() => { const view = document.querySelector('#messages'); return view.scrollHeight - view.scrollTop - view.clientHeight < 120; });
  await page.waitForFunction(()=>document.querySelector('.mode-tile[data-mode="dual"]')?.getAttribute('aria-pressed')==='true');
  check('starts in Dual', await tile('dual').getAttribute('aria-pressed') === 'true');

  // Choosing Hydra keeps the conversation; the task card waits at its end.
  await tile('hydra').click();
  await page.locator('#messages > #hydra-inline .cx-main').waitFor();
  check('hydra stays in the conversation', await selected() === normal.id);
  check('conversation still in view with Hydra chosen', await page.locator('#messages').isVisible() && await page.locator('#messages').getByText('RESPOSTA-ANTES-DO-HYDRA').count() === 1);
  check('no history toggle any more', await page.locator('#hydra-view').count() === 0 && await page.locator('#hydra-chip').isVisible());
  check('card waits at the end of the conversation', (await transcript(page)).at(-1).startsWith('live:'));
  await page.locator('#prompt').fill('Comparar duas abordagens.');
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('.cx-badge')?.textContent === 'Plano em discussão', null, { timeout: 8000 });
  const first = hub.claudex.records[0];
  check('task runs in place with the Dual sessions', first.inPlace && first.members.codex.conversationId === normal.id && first.members.claude.conversationId === partner.id, first.members);
  check('no new conversation', hub.conversations().length === conversationsBefore && await selected() === normal.id);
  await page.locator('#messages > .hydra-request', { hasText: 'Comparar duas abordagens.' }).waitFor();
  let order = await transcript(page);
  check('request shown as the person\'s message, card right after it', inOrder(order, 'answer:RESPOSTA-ANTES-DO-HYDRA', 'request:Comparar duas abordagens.', 'live:Plano em discussão') && order.at(-1).startsWith('live:'), order);
  check('request labelled with the pair and copyable', /Tu · para o ClaudeX/.test(await page.locator('.hydra-request .message-header').first().textContent()) && await page.locator('.hydra-request .copy-message').count() === 1);
  await until(() => ['codex', 'claude'].every(role => hub.claudex.native(first, role).status === 'running'));
  for (const role of ['codex', 'claude']) await call(first, role, 'initial_position', { text: 'Posição ' + role });
  await call(first, 'claude', 'send_to_peer', { messageId: 'p1', type: 'discovery', text: 'A segunda abordagem funciona offline.' });
  await page.locator('#messages #hydra-inline .cx-message', { hasText: 'funciona offline' }).waitFor();
  check('dialogue shown in the card, inside the conversation', await page.locator('#messages #hydra-inline .cx-message', { hasText: 'funciona offline' }).isVisible() && await page.locator('#messages').getByText('RESPOSTA-ANTES-DO-HYDRA').count() === 1);
  check('rounds not repeated as notes', await page.locator('#messages .handoff-note', { hasText: 'Hydra · ronda' }).count() === 0 && await page.locator('#messages', { hasText: 'resumo de passagem' }).count() === 0);
  check('task card and its participants', await page.locator('#hydra-inline .cx-participant').count() === 2 && !await page.locator('#hydra-inline .cx-goal').isVisible());
  // A new requirement is the person's message too, not a line inside the models' dialogue.
  await page.locator('#prompt').fill('Requisito novo: tem de funcionar offline.');
  await page.locator('#send').click();
  await page.locator('#messages > .hydra-request', { hasText: 'Requisito novo' }).waitFor({ timeout: 8000 });
  order = await transcript(page);
  check('update shown as the person\'s message, card follows it', inOrder(order, 'request:Comparar duas abordagens.', 'request:Requisito novo', 'live:') && /novo requisito para o ClaudeX/.test(await page.locator('.hydra-request', { hasText: 'Requisito novo' }).locator('.message-header').textContent()), order);
  check('update not repeated inside the dialogue', !await page.locator('#hydra-inline .cx-message', { hasText: 'Requisito novo' }).isVisible());
  // A changed request requires fresh independent intent classification.
  for (const role of ['codex','claude']) await call(first,role,'initial_position',{text:'Posição atualizada '+role,intent:'read-only',revision:first.revision});
  // Reading earlier messages: updates to the card neither pull the scroll nor close what was opened.
  const scrollable = await page.evaluate(() => { const view = document.querySelector('#messages'); return view.scrollHeight > view.clientHeight + 200; });
  check('transcript long enough to test the scroll', scrollable);
  await scrollTo('top');
  await call(first, 'codex', 'send_to_peer', { messageId: 'p2', type: 'objection', text: 'Objeção: a sincronização falha sem rede.' });
  await page.locator('#hydra-inline .cx-message', { hasText: 'sincronização falha' }).waitFor();
  await page.waitForTimeout(400);
  check('reading earlier messages: the card does not pull the scroll', await scrollTop() < 40, await scrollTop());
  await scrollTo('bottom');
  await call(first, 'claude', 'send_to_peer', { messageId: 'p3', type: 'discovery', text: 'Descoberta: guarda localmente e sincroniza depois.' });
  await page.locator('#hydra-inline .cx-message', { hasText: 'sincroniza depois' }).waitFor();
  await page.waitForTimeout(400);
  check('at the end: the card keeps the newest in view', await atBottom());
  await page.screenshot({ path: out + '/inplace-running-atelier.png' });
  // Both approve; the conversation comes back to Dual with the result in it.
  for (const role of ['codex', 'claude']) await call(first, role, 'ready_to_conclude', await call(first, role, 'read_dialogue'));
  const draft = (await call(first, first.author, 'propose_final', { ...await call(first, first.author, 'read_dialogue'), text: 'PLANO-COMUM: segunda abordagem.' })).candidate;
  await page.locator('#hydra-inline .cx-draft > summary').waitFor();
  await page.locator('#hydra-inline .cx-draft > summary').click();
  await page.locator('#hydra-inline .cx-draft details > summary', { hasText: 'Versão 1' }).click();
  const reviewed = await call(first, 'codex', 'read_dialogue');
  await call(first, 'codex', 'review_final', { candidateId: draft.id, hash: draft.hash, revision: reviewed.revision, reviewedThrough: reviewed.reviewedThrough, decision: 'approve' });
  await page.locator('#hydra-inline .cx-participant .cx-approved').waitFor();
  check('an opened version stays open while the card updates', await page.locator('#hydra-inline .cx-draft details', { hasText: 'Versão 1' }).evaluate(e => e.open));
  for (const role of ['codex', 'claude']) { const v = await call(first, role, 'read_dialogue'); if (role === 'claude') await call(first, role, 'review_final', { candidateId: draft.id, hash: draft.hash, revision: v.revision, reviewedThrough: v.reviewedThrough, decision: 'approve' }); clients[role].finish(hub.claudex.native(first, role), 'Contribuição terminada.'); }
  await until(() => first.released);
  await page.waitForFunction(() => document.querySelector('.mode-tile[data-mode="dual"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 8000 });
  await page.locator('#messages > .cx-card').waitFor({ timeout: 8000 });
  order = await transcript(page);
  check('back to Dual after the task', await page.locator('#messages').isVisible() && await page.locator('#hydra-inline').isHidden() && await tile('hydra').getAttribute('aria-pressed') === 'false');
  check('finished task is a card in its place, then the common answer', inOrder(order, 'answer:RESPOSTA-ANTES-DO-HYDRA', 'request:Comparar duas abordagens.', 'request:Requisito novo', 'card:completed', 'answer:PLANO-COMUM'), order);
  // The real Codex client reports a finished progress for the publication turn, as for any turn; the simulated one does not.
  const published = normal.turns.find(turn => turn.source === 'claudex-publication');
  normal.progress = { turnId: published.id, status: 'completed', title: 'Pedido concluído', counts: { completed: 0, running: 0, failed: 0, declined: 0 }, steps: [], actions: [], completedSteps: 0 };
  hub.emit('state', hub.snapshot());
  await page.waitForTimeout(400);
  check('the publication\'s progress does not float above the conversation', await page.evaluate(id => document.querySelector('#progress-panel').classList.contains('hidden'), published.id));
  check('request and common answer shown once', once(order, 'request:Comparar duas abordagens.') && !order.some(e => e.startsWith('user:Comparar')) && once(order, 'answer:PLANO-COMUM'), order);
  check('card names the outcome and the contributions', /Hydra · ClaudeX/.test(await page.locator('.cx-card').first().textContent()) && /Acordo de todos/.test(await page.locator('.cx-card').first().textContent()) && /contributos/.test(await page.locator('.cx-card').first().textContent()));
  check('settings restored', normal.sandbox === 'workspace-write' && normal.claudexTask === undefined && partner.claudexTask === undefined);
  await page.locator('.cx-card > summary').first().click();
  await page.locator('.cx-card .cx-message', { hasText: 'funciona offline' }).waitFor();
  check('finished card opens to its dialogue, without the person\'s requests', await page.locator('.cx-card .cx-message', { hasText: 'Requisito novo' }).count() === 0);
  await page.screenshot({ path: out + '/inplace-back-to-dual-atelier.png' });

  // Hydra again; leaving to Normal stops it, gives the conversation back and turns Dual off.
  await tile('hydra').click();
  await page.locator('#messages > #hydra-inline .cx-main').waitFor();
  await page.locator('#prompt').fill('Segunda tarefa.');
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('.cx-badge')?.textContent === 'Plano em discussão', null, { timeout: 8000 });
  const second = hub.claudex.records.find(record => record.id !== first.id);
  check('second task in the same conversation', second?.inPlace && second.members.codex.conversationId === normal.id && await selected() === normal.id);
  check('an opened finished card stays open while another task runs', await page.locator('.cx-card').first().evaluate(e => e.open));
  await tile('normal').click();
  check('leaving is explained', await page.waitForFunction(() => /parado/.test(document.querySelector('#toast')?.textContent), null, { timeout: 4000 }).then(() => true, () => false));
  await until(() => second.released, 10000);
  // From Dual, Normal opens the Dual dialog to turn it off, as without Hydra.
  await page.locator('dialog.dual-dialog[open]').waitFor({ timeout: 10000 });
  check('back in Dual first, then its dialog', second.status === 'interrupted' && await page.locator('#hydra-inline').isHidden() && await page.locator('#messages').isVisible());
  await page.locator('dialog.dual-dialog[open] button', { hasText: 'Desligar Multi' }).click();
  await page.waitForFunction(() => document.querySelector('.mode-tile[data-mode="normal"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 10000 });
  check('normal after leaving: Dual off', await tile('dual').getAttribute('aria-pressed') === 'false' && await page.locator('#model').isVisible());
  await page.locator('#prompt').fill('Continua sem o Hydra.');
  await page.locator('#send').click();
  await until(() => clients.codex.logs.at(-1)?.text.includes('Continua sem o Hydra.'));
  check('next request tells the model the task ended', /\[HYDRAQ\] A tarefa ClaudeX desta conversa terminou \(parada pelo utilizador\)/.test(clients.codex.logs.at(-1).text));
  clients.codex.finish(normal, 'Resposta normal.');
  await page.locator('#messages .message.assistant', { hasText: 'Resposta normal.' }).waitFor();

  // After a reload the history is the same: ordered, cards in place, nothing repeated.
  await page.reload(); await page.waitForFunction(() => document.querySelector('#model').value);
  await page.waitForFunction(() => document.querySelectorAll('#messages > .cx-card').length === 2, null, { timeout: 8000 });
  order = await transcript(page);
  check('reload keeps the history in order with both cards', inOrder(order, 'answer:RESPOSTA-ANTES-DO-HYDRA', 'request:Comparar duas abordagens.', 'request:Requisito novo', 'card:completed', 'answer:PLANO-COMUM', 'request:Segunda tarefa.', 'card:interrupted', 'user:Continua sem o Hydra.', 'answer:Resposta normal.'), order);
  check('reload repeats nothing', ['request:Comparar', 'request:Requisito novo', 'request:Segunda tarefa.', 'answer:PLANO-COMUM', 'user:Continua sem o Hydra.'].every(prefix => once(order, prefix)) && !order.some(e => e.startsWith('user:Comparar') || e.startsWith('user:Segunda')), order);
  check('stopped task named in its card', /Parado/.test(await page.locator('.cx-card[data-status="interrupted"]').textContent()));
  // Another Hydra after the reload, paused: its card stays live in place, also after another reload.
  await tile('hydra').click();
  await page.locator('#messages > #hydra-inline .cx-main').waitFor();
  await page.locator('#prompt').fill('Terceira tarefa.');
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('.cx-badge')?.textContent === 'Plano em discussão', null, { timeout: 8000 });
  const third = hub.claudex.records.find(record => ![first.id, second.id].includes(record.id));
  await until(() => ['codex', 'claude'].every(role => hub.claudex.native(third, role).status === 'running'));
  await page.waitForFunction(() => /Pausar todos/.test(document.querySelector('#stop').textContent) && !document.querySelector('#stop').classList.contains('hidden'), null, { timeout: 8000 });
  await page.locator('#stop').click();
  await page.waitForFunction(() => /Retomar a mesma tarefa/.test(document.querySelector('#send').textContent), null, { timeout: 8000 });
  await page.reload(); await page.waitForFunction(() => document.querySelector('#model').value || document.body.dataset.hydra);
  await page.locator('#messages > #hydra-inline .cx-main').waitFor();
  await page.waitForFunction(() => document.querySelector('#messages > .hydra-request:last-of-type')?.textContent.includes('Terceira tarefa.'), null, { timeout: 8000 });
  order = await transcript(page);
  check('paused task stays live in its place after a reload', inOrder(order, 'card:completed', 'card:interrupted', 'answer:Resposta normal.', 'request:Terceira tarefa.', 'live:Em pausa') && order.at(-1).startsWith('live:'), order);
  check('paused task resumes from the composer', /Retomar a mesma tarefa/.test(await page.locator('#send').textContent()));
  await page.screenshot({ path: out + '/inplace-paused-atelier.png' });
  await tile('normal').click();
  await until(() => third.released, 10000);
  await page.waitForFunction(() => document.querySelectorAll('#messages > .cx-card').length === 3, null, { timeout: 8000 });
  order = await transcript(page);
  check('paused task given back: its card stays in place', inOrder(order, 'request:Terceira tarefa.', 'card:') && order.filter(e => e.startsWith('card:')).length === 3 && !order.some(e => e.startsWith('live:')), order);
  // A task that gave its conversation back offers a new task from its progress, never a resume.
  await page.locator('#tab-claudex').click();
  await page.locator('#claudex-view .cx-history nav button', { hasText: 'Segunda tarefa' }).click();
  await page.waitForFunction(() => /Nova tarefa a partir deste progresso/.test(document.querySelector('#claudex-view .cx-composer button.primary')?.textContent), null, { timeout: 6000 }).catch(() => {});
  check('given-back task offers a new task, not a resume', /Nova tarefa a partir deste progresso/.test(await page.locator('#claudex-view .cx-composer button.primary').textContent()) && await page.locator('#claudex-view .cx-composer', { hasText: 'Retomar' }).count() === 0);
  check('the Hydra tab still shows the request and the answer of a task', await page.locator('#claudex-view .cx-goal').isVisible());
  await page.locator('#tab-conversations').click();
  for (const theme of ['classic', 'mono', 'atelier']) {
    await page.evaluate(t => localStorage.setItem('hydraq.theme', t), theme); await page.reload(); await page.waitForFunction(() => document.querySelector('#model').value);
    await page.locator('#messages > .cx-card').first().waitFor();
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
