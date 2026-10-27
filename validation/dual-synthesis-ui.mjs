// Isolated QA of the Dual synthesis and of the quick way from the Dual to Hydra. Simulated clients only; no personal
// sessions. node validation/dual-synthesis-ui.mjs [output-directory]
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { Providers } from '../lib/providers.mjs';
import { OpinionClient } from '../test/fixtures/opinion-client.mjs';
import { createHttpServer } from '../lib/http.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(repo, '.hydraq/dual-synthesis-ui-2026-10-27'));
await mkdir(out, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), 'hydraq-dual-synthesis-'));
const clients = Object.fromEntries(['codex', 'claude', 'antigravity', 'cursor', 'opencode'].map(p => { const c = new OpinionClient(p, path.join(root, p), { behavior: 'hold' }); c.defaultCwd = root; return [p, c]; }));
const runtimes = [], control = { behavior: 'success', answer: 'SINTESE-FINAL: plano único com o melhor das duas.' };
const hub = new Providers({ dataDir: path.join(root, 'hub'), defaultCwd: root, clients, git: async () => [], opinionSupervisor: { available: async () => ({ available: true }), stop: async () => {} },
  opinionClientFactory: async ({ job, directory, cwd }) => { const client = new OpinionClient(job.provider, directory, { behavior: control.behavior, answer: control.answer }); await client.load(); runtimes.push(client); return { client, cwd }; } });
const results = [], errors = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok) }); if (!ok) console.error('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
const until = async (predicate, ms = 8000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw Error('Tempo excedido'); await new Promise(r => setTimeout(r, 20)); } };
let browser, server;
try {
  await hub.load(); await hub.connectAll();
  const snapshot = hub.snapshot.bind(hub);
  hub.snapshot = () => { const value = snapshot(); return { ...value, nativeSessions: { ...(value.nativeSessions || {}), available: true, sessions: [] } }; };
  const normal = await clients.codex.create({ cwd: root, model: 'test', effort: 'high', sandbox: 'read-only' }); normal.title = 'Dual com síntese';
  await hub.send(normal.id, 'Olá.', 'normal-1', { model: 'test', effort: 'high', sandbox: 'read-only' });
  clients.codex.finish(normal, 'Olá! Em que posso ajudar?');
  const { dual } = await hub.startDual(normal.id, { provider: 'claude', model: 'test', effort: 'low' });
  const partner = clients.claude.conversation(dual.members.b.conversationId);
  server = createHttpServer({ hydraq: hub, publicDir: path.join(repo, 'public') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(id => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('hydraq.theme', 'atelier'); localStorage.setItem('hydraq.conversation', id); sessionStorage.setItem('seeded', '1'); } }, normal.id);
  await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForFunction(() => document.querySelector('#prompt'));
  const tile = mode => page.locator(`.mode-tile[data-mode="${mode}"]`);
  const lastStage = () => page.locator('.dual-stage').last();
  // One round to both, answered by both.
  const ask = async (text, answers = ['Resposta do Codex: dividir por módulos.', 'Resposta do Claude: dividir por funcionalidades.']) => {
    await page.locator('#prompt').fill(text); await page.locator('#send').click();
    await until(() => normal.status === 'running' && partner.status === 'running');
    clients.codex.finish(normal, answers[0]); clients.claude.finish(partner, answers[1]);
    await page.locator('.dual-stage', { hasText: answers[1] }).waitFor();
  };
  check('starts in Dual', await tile('dual').getAttribute('aria-pressed') === 'true');
  check('Modo shows the Dual synthesis as manual', /Manual · botão em cada ronda/.test(await page.locator('.mode-synthesis').textContent()));
  await ask('Como organizar o projeto?');

  // Manual synthesis by a third model, with instructions; not in the context.
  await lastStage().locator('.dual-synthesis-ask', { hasText: 'Sintetizar' }).click();
  const dialog = page.locator('dialog.dual-dialog[open]');
  await dialog.waitFor();
  check('dialog offers both Dual models and another', (await dialog.locator('select').first().locator('option').allTextContents()).join('|').match(/^Codex · .*\|Claude · .*\|Outro modelo…$/));
  check('context off by default, automatic off', !await dialog.getByLabel('Entra no contexto da ronda seguinte').isChecked() && !await dialog.getByLabel('Fazer automaticamente no fim de cada ronda aos dois').isChecked());
  await dialog.locator('select').first().selectOption('other');
  await dialog.getByLabel('Cliente').selectOption('antigravity');
  await dialog.getByLabel('Instruções opcionais').fill('Foca a manutenção.');
  await dialog.locator('button.primary-button', { hasText: 'Sintetizar' }).click();
  await lastStage().locator('.dual-synthesis .review-panel', { hasText: 'SINTESE-FINAL' }).waitFor();
  const panel = lastStage().locator('.dual-synthesis .review-panel').first();
  check('synthesis under the two answers, by the chosen model', /Síntese · Antigravity/.test(await panel.locator('.review-panel-title').textContent()) && /Pronta/.test(await panel.locator('.review-panel-status').textContent()));
  check('synthesis says it does not go to the next round', /Não entra no contexto dos dois/.test(await panel.locator('.review-panel-foot').textContent()));
  check('synthesis can be copied', await panel.locator('.review-panel-tool').first().isVisible());
  check('synthesis runs apart from the Dual sessions', clients.codex.logs.length === 2 && clients.claude.logs.length === 1 && /Foca a manutenção\./.test(runtimes[0].logs[0].text));
  check('not shown as a second opinion', await page.locator('.opinion-batch').count() === 0);
  await page.screenshot({ path: out + '/synthesis-manual-atelier.png' });

  // Another synthesis, into the next round's context and automatic from now on.
  control.answer = 'SINTESE-PARA-A-RONDA: plano final.';
  await lastStage().locator('.dual-synthesis-ask', { hasText: 'Outra síntese' }).click();
  await dialog.waitFor();
  await dialog.getByLabel('Entra no contexto da ronda seguinte').check();
  await dialog.getByLabel('Fazer automaticamente no fim de cada ronda aos dois').check();
  await dialog.locator('button.primary-button', { hasText: 'Sintetizar' }).click();
  await lastStage().locator('.dual-synthesis > .review-panel', { hasText: 'SINTESE-PARA-A-RONDA' }).waitFor();
  check('earlier synthesis folded', /Sínteses anteriores desta ronda · 1/.test(await lastStage().locator('.dual-synthesis-older summary').textContent()));
  check('synthesis says it goes to the next round', /Segue para os dois na próxima ronda/.test(await lastStage().locator('.dual-synthesis > .review-panel .review-panel-foot').textContent()));
  check('Modo shows automatic with context', /Automática · Antigravity · Modelo teste.*entra na ronda seguinte/.test(await page.locator('.mode-synthesis').textContent()));

  // A late synthesis: the next round goes without it, and the composer says so before sending.
  control.behavior = 'hold'; control.answer = 'SINTESE-AUTOMATICA';
  await ask('E os testes?', ['Codex: testes por módulo.', 'Claude: testes de ponta a ponta.']);
  check('the round carried the previous synthesis to both', ['codex', 'claude'].every(p => /SINTESE-PARA-A-RONDA/.test(clients[p].logs.at(-1).text)));
  await lastStage().locator('.dual-synthesis .review-panel', { hasText: 'A preparar a síntese' }).waitFor({ timeout: 8000 });
  check('automatic synthesis after the round', /automática/.test(await lastStage().locator('.dual-synthesis .review-panel-meta').first().textContent()) && /A sintetizar|A iniciar|Na fila/.test(await lastStage().locator('.dual-synthesis .review-panel-status').first().textContent()));
  await page.locator('#prompt').fill('Pergunta seguinte.');
  await page.waitForFunction(() => /A síntese ainda está a ser escrita: se enviares agora, esta ronda segue sem ela/.test(document.querySelector('#composer-hint').textContent), null, { timeout: 4000 }).catch(() => {});
  check('composer warns before sending while the synthesis is written', /A síntese ainda está a ser escrita/.test(await page.locator('#composer-hint').textContent()));
  const late = runtimes.at(-1);
  // Written in steps: the panel follows the new text without rebuilding the conversation.
  late.conversations[0].messages.push({ id: 'partial', requestId: late.conversations[0].turns[0].requestId, turnId: late.conversations[0].turns[0].id, role: 'assistant', text: 'SINTESE-AUTOMATICA em curso', at: new Date().toISOString(), streaming: true }); late.changed();
  await lastStage().locator('.dual-synthesis .review-panel', { hasText: 'SINTESE-AUTOMATICA em curso' }).waitFor({ timeout: 4000 }).catch(() => {});
  check('text written so far is shown', await lastStage().locator('.dual-synthesis .review-panel', { hasText: 'SINTESE-AUTOMATICA em curso' }).count() === 1);
  late.conversations[0].messages.pop();
  late.finish(late.conversations[0], 'SINTESE-AUTOMATICA final');
  await lastStage().locator('.dual-synthesis .review-panel', { hasText: 'SINTESE-AUTOMATICA final' }).waitFor();
  await page.waitForFunction(() => !/A síntese ainda está a ser escrita/.test(document.querySelector('#composer-hint').textContent), null, { timeout: 4000 }).catch(() => {});
  check('warning gone once the synthesis is written', !/A síntese ainda está a ser escrita/.test(await page.locator('#composer-hint').textContent()));
  await page.screenshot({ path: out + '/synthesis-automatic-atelier.png' });
  control.behavior = 'success';
  await page.locator('#prompt').fill('');

  // A missing answer: automatic does not run; the button asks for a partial synthesis.
  const synthesesBefore = hub.opinions.batches.filter(b => b.kind === 'synthesis').length;
  await page.locator('#prompt').fill('E a documentação?'); await page.locator('#send').click();
  await until(() => normal.status === 'running' && partner.status === 'running');
  check('next round carried the late synthesis', ['codex', 'claude'].every(p => /SINTESE-AUTOMATICA final/.test(clients[p].logs.at(-1).text)));
  clients.codex.finish(normal, 'Codex: documentação junto ao código.'); await clients.claude.interrupt(partner.id);
  await lastStage().locator('.dual-synthesis-ask', { hasText: 'Síntese parcial · sem o Claude' }).waitFor();
  await new Promise(r => setTimeout(r, 200));
  check('automatic synthesis waits when an answer is missing', hub.opinions.batches.filter(b => b.kind === 'synthesis').length === synthesesBefore);
  await lastStage().locator('.dual-synthesis-ask', { hasText: 'Síntese parcial' }).click();
  await dialog.waitFor();
  await dialog.locator('button.primary-button', { hasText: 'Pedir síntese parcial' }).click();
  await lastStage().locator('.dual-synthesis .review-panel-foot', { hasText: 'Parcial: falta a resposta do Claude' }).waitFor();
  check('partial synthesis names the missing answer', /síntese é parcial e qual resposta falta/.test(runtimes.at(-1).logs[0].text));
  await page.screenshot({ path: out + '/synthesis-partial-atelier.png' });

  // From the Dual to Hydra: same pair, same models, same conversation; back to the Dual with its synthesis choices.
  check('quick Hydra button names the pair', await page.locator('#dual-hydra').isVisible() && (await page.locator('#dual-hydra').textContent()) === '⇢ ClaudeX' && !await page.locator('#dual-hydra').isDisabled());
  await page.locator('#dual-hydra').click();
  await page.locator('#messages > #hydra-inline .cx-main').waitFor();
  check('Hydra with the Dual pair in the same conversation', await tile('hydra').getAttribute('aria-pressed') === 'true' && (await page.locator('#hydra-chip').textContent()) === 'Hydra · ClaudeX' && await page.evaluate(() => localStorage.getItem('hydraq.conversation')) === normal.id);
  check('Hydra keeps the Dual models and reasoning', await page.locator('#cx-codexEffort').inputValue() === 'high' && await page.locator('#cx-claudeEffort').inputValue() === 'low' && await page.locator('#cx-codexModel').inputValue() === 'test');
  check('history still in view', await page.locator('#messages').getByText('Codex: documentação junto ao código.').count() >= 1);
  await page.screenshot({ path: out + '/dual-to-hydra-atelier.png' });
  await tile('normal').click();
  await page.waitForFunction(() => document.querySelector('.mode-tile[data-mode="dual"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 4000 }).catch(() => {});
  check('back to the Dual, synthesis choices kept', await tile('dual').getAttribute('aria-pressed') === 'true' && /Automática/.test(await page.locator('.mode-synthesis').textContent()));
  // The Modo tile follows the same rule as the button.
  await tile('hydra').click();
  await page.locator('#messages > #hydra-inline .cx-main').waitFor();
  check('Modo tile also takes the Dual pair', (await page.locator('#hydra-chip').textContent()) === 'Hydra · ClaudeX');
  await tile('normal').click();
  await page.waitForFunction(() => document.querySelector('.mode-tile[data-mode="dual"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 4000 }).catch(() => {});
  // A second pass after a task: the reasoning now in use in the Dual, not the one of the earlier task.
  await page.locator('#dual-hydra').click();
  await page.locator('#messages > #hydra-inline .cx-main').waitFor();
  await page.locator('#prompt').fill('Tarefa Hydra curta.'); await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('.cx-badge')?.textContent === 'Em diálogo', null, { timeout: 8000 });
  const task = hub.claudex.records.at(-1);
  check('Hydra task in place, from the Dual', task?.inPlace && task.members.codex.effort === 'high');
  await tile('dual').click();
  await until(() => task.released, 10000);
  await page.locator('dialog.dual-dialog[open]').waitFor({ timeout: 8000 }); await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.mode-tile[data-mode="dual"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 4000 }).catch(() => {});
  await page.evaluate(() => { const effort = document.querySelector('#effort'); effort.value = 'low'; effort.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.locator('#dual-hydra').click();
  await page.locator('#messages > #hydra-inline .cx-main').waitFor();
  await page.waitForTimeout(200);
  check('second pass takes the reasoning now in use in the Dual', await page.locator('#cx-codexEffort').inputValue() === 'low', await page.locator('#cx-codexEffort').inputValue());
  await tile('dual').click();
  await page.waitForFunction(() => document.querySelector('.mode-tile[data-mode="dual"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 4000 }).catch(() => {});
  await page.locator('dialog.dual-dialog[open]').waitFor({ timeout: 1500 }).then(() => page.keyboard.press('Escape'), () => {});
  // A Dual with a client Hydra cannot take: the button explains instead.
  await hub.replaceDualMember(dual.id, { key: 'b', provider: 'cursor', model: 'test', effort: 'low' });
  await page.waitForFunction(() => document.querySelector('#dual-hydra')?.disabled, null, { timeout: 4000 }).catch(() => {});
  check('Hydra button disabled for a pair with Cursor, with the reason', await page.locator('#dual-hydra').isDisabled() && /junta o Codex, o Claude e o Gemini/.test(await page.locator('#dual-hydra').getAttribute('data-tip')));
  for (const theme of ['classic', 'mono', 'atelier']) {
    await page.evaluate(t => localStorage.setItem('hydraq.theme', t), theme); await page.reload(); await page.locator('.dual-synthesis').first().waitFor();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(150);
      check(`${theme} ${width} no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator('.dual-synthesis').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/synthesis-${theme}-${width}.png` });
    }
  }
} catch (error) { console.error('ERROR', error.stack || error.message); check('script completed', false); }
finally { await browser?.close(); server?.close(); await hub.close?.().catch(() => {}); await rm(root, { recursive: true, force: true }); }
check('no JavaScript errors', !errors.length, errors);
const summary = { out, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).map(r => r.name), results, errors };
await writeFile(path.join(out, 'results.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ out, passed: summary.passed, failed: summary.failed, errors }));
if (summary.failed.length) process.exitCode = 1;
