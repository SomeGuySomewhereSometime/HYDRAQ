// Isolated browser QA: simulated catalogs/quotas, no inference or production state.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { Providers } from '../lib/providers.mjs';
import { OpinionClient } from '../test/fixtures/opinion-client.mjs';
import { createHttpServer } from '../lib/http.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'hydraq-quota-ui-'));
const out = path.resolve(process.argv[2] || '/tmp/hydraq-provider-status-ui'); await mkdir(out, { recursive: true });
const checks = [], errors = [], check = (name, value) => { checks.push({ name, ok: Boolean(value) }); console.log(`${value ? 'PASS' : 'FAIL'} ${name}`); };
const reset = Math.floor(Date.now()/1000);
let clock = Date.now(), version = 0, fail = false, catalogReads = 0;
const clients = Object.fromEntries(['codex', 'claude', 'antigravity', 'cursor'].map(id => [id, new OpinionClient(id, path.join(root, id))]));
clients.claude.models.push({id:'opus',name:'Claude Opus',efforts:['low','high'],defaultEffort:'high'});
clients.antigravity.models.push(...[['gemini-3.8-flash','Gemini Flash'],['gemini-4-argon','Gemini 4 Argon'],['claude-opus-5-5','Claude Opus · agy']].map(([id,name])=>({id,name,efforts:['low','high'],defaultEffort:'high'})));
for (const id of ['codex', 'claude', 'antigravity']) {
  clients[id].refreshCatalog = async () => {
    catalogReads++; if (fail) throw Error('Test-secret-must-not-appear');
    if (version && id === 'codex') clients[id].models = [...clients[id].models.filter(m => m.id !== 'gpt-6.1-terra'),
      { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', efforts: ['low', 'high', 'ultra'], defaultEffort: 'low', description: 'Modelo novo do catálogo nativo', inputModalities: ['text', 'image'], contextWindow: 200000 }];
  };
  clients[id].readQuotas = async () => {
    if (fail) throw Error('Test-secret-must-not-appear');
    if (id === 'codex') return { rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: reset + 7200 }, secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: reset + 4 * 86400 } } };
    if (id === 'claude') return { rate_limits_available: true, rate_limits: { five_hour: { utilization: 14 }, seven_day: { utilization: 72 } } };
    return { groups: [{ name: 'Gemini Models', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: .99 }, { id: 'gemini-weekly', window: 'weekly', remaining_fraction: .97 }] },
      {name:'Claude and GPT models',buckets:[{id:'3p-5h',window:'5h',remaining_fraction:.6},{id:'3p-weekly',window:'weekly',remaining_fraction:.45}]}, { name: 'Gemini 4 Argon', buckets: [{ id: 'argon-weekly', window: 'weekly', remaining_fraction: .79 }] }] };
  };
}
const hub = new Providers({ dataDir: path.join(root, 'hub'), defaultCwd: root, clients, git: async () => [] });
hub.catalogMonitor.clock = () => clock;
let browser, server;
try {
  await hub.load(); await hub.connectAll();
  server = createHttpServer({ hydraq: hub, publicDir: path.resolve('public') }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { localStorage.setItem('hydraq.theme', 'atelier'); localStorage.setItem('hydraq.provider', 'codex'); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#model option[value="test"]').waitFor({ state: 'attached' });
  check('Limites selecionados visíveis com catálogo fechado', await page.locator('.quota-selected-card').isVisible() && !(await page.locator('.quota-browser').evaluate(e=>e.open)));
  check('Dois limites do modelo selecionado', await page.locator('.quota-selected-card .quota-window').count()===2);
  await page.locator('.quota-browser > summary').click();
  check('Três clientes com quotas', await page.locator('.provider-quota-card').count() === 3);
  check('Codex: 75% e 40% livres', JSON.stringify(await page.locator('.provider-quota-card[data-provider="codex"] .quota-value strong').allTextContents())===JSON.stringify(['75%','40%']));
  check('Claude: 86% e 28% livres', JSON.stringify(await page.locator('.provider-quota-card[data-provider="claude"] .quota-value strong').allTextContents())===JSON.stringify(['86%','28%']));
  check('Argon separado dos restantes Gemini', (await page.locator('.provider-quota-card[data-provider="antigravity"]').innerText()).includes('Gemini 4 Argon'));
  check('Sem data inventada para Claude', (await page.locator('.provider-quota-card[data-provider="claude"]').innerText()).includes('Reposição não comunicada'));
  await page.selectOption('#effort', 'high'); clock += 11_000; version = 1;
  await page.locator('.quota-selected-card').getByRole('button', { name: 'Atualizar modelos e quotas do Codex', exact: true }).click();
  await page.locator('#model option[value="gpt-6.1-terra"]').waitFor({ state: 'attached' });
  check('Novo Terra aparece sem recarregar página', await page.locator('#model option[value="gpt-6.1-terra"]').count() === 1);
  check('Seleção anterior preservada', await page.inputValue('#model') === 'test' && await page.inputValue('#effort') === 'high');
  await page.selectOption('#model', 'gpt-6.1-terra'); await page.selectOption('#effort', 'ultra');
  check('Cartão segue o modelo escolhido imediatamente', (await page.locator('.quota-selected-card h3').innerText())==='GPT-6.1 Terra');
  check('Terra oferece ultra do catálogo', await page.inputValue('#effort') === 'ultra');
  await page.locator('.provider-quota-card[data-provider="codex"] .provider-models > summary').click();
  await page.locator('.provider-quota-card[data-provider="codex"] .provider-model-detail > summary').filter({ hasText: 'GPT-6.1 Terra' }).click();
  check('Metadados visíveis', (await page.locator('.provider-quota-card[data-provider="codex"]').innerText()).includes('Entrada: texto · imagens') && (await page.locator('.provider-quota-card[data-provider="codex"]').innerText()).includes('200'));
  await page.locator('.quota-browser > summary').click();
  await page.screenshot({ path: path.join(out, 'atelier-modelos-quotas.png') });
  await page.locator('.quota-browser > summary').click();
  clock += 7 * 60 * 60_000; fail = true; await hub.catalogMonitor.refresh('codex');
  await page.waitForFunction(() => document.querySelector('.provider-quota-card[data-provider="codex"]')?.textContent.includes('última lista válida'));
  check('Falha mantém Terra e ultra', await page.inputValue('#model') === 'gpt-6.1-terra' && await page.inputValue('#effort') === 'ultra');
  check('Falha mantém quotas e indica valores anteriores', (await page.locator('.provider-quota-card[data-provider="codex"] .quota-value strong').allTextContents()).includes('75%') && (await page.locator('.provider-quota-card[data-provider="codex"]').innerText()).includes('valores anteriores'));
  check('Erros não expõem conteúdo nativo', !(await page.locator('body').innerText()).includes('Test-secret'));
  fail = false; clock += 11_000; await hub.catalogMonitor.refresh('codex', { force: true });
  // Model-aware native groups and the user's client colors.
  await page.selectOption('#provider','antigravity'); await page.selectOption('#model','gemini-3.8-flash');
  check('Flash mostra só o grupo Gemini',JSON.stringify(await page.locator('.quota-selected-card .quota-window').evaluateAll(es=>es.map(e=>e.dataset.window)))===JSON.stringify(['gemini-5h','gemini-weekly']));
  await page.selectOption('#model','gemini-4-argon');
  check('Argon mostra a sua quota e não atribui a de cinco horas de outro grupo',JSON.stringify(await page.locator('.quota-selected-card .quota-window').evaluateAll(es=>es.map(e=>e.dataset.window)))===JSON.stringify(['argon-weekly']));
  await page.selectOption('#model','claude-opus-5-5');
  check('Claude via agy mostra Claude/GPT da Google',JSON.stringify(await page.locator('.quota-selected-card .quota-window').evaluateAll(es=>es.map(e=>e.dataset.window)))===JSON.stringify(['3p-5h','3p-weekly']));
  await page.evaluate(()=>document.body.style.setProperty('--c-antigravity','#fa78cc'));
  check('Barras respeitam a cor personalizada do cliente',(await page.locator('.quota-selected-card progress').first().evaluate(e=>getComputedStyle(e).accentColor))==='rgb(250, 120, 204)');
  await page.selectOption('#provider','claude');await page.selectOption('#model','opus');
  check('Trocar cliente atualiza nome e limites',(await page.locator('.quota-selected-card h3').innerText())==='Claude Opus' && (await page.locator('.quota-selected-card .quota-value strong').allTextContents()).includes('86%'));
  await page.selectOption('#provider','cursor');
  check('Cursor não recebe quotas de outra subscrição',await page.locator('.quota-selected-card .quota-window').count()===0 && (await page.locator('.quota-selected-card').innerText()).includes('Sem quotas'));
  await page.selectOption('#provider','codex');await page.selectOption('#model','gpt-6.1-terra');
  clients.codex.emit('quotas',{rateLimits:{limitId:'codex',primary:{usedPercent:96,windowDurationMins:300},secondary:{usedPercent:100,windowDurationMins:10080}}});
  await page.waitForFunction(()=>document.querySelector('.quota-selected-card .quota-warning')?.textContent==='Pouca quota');
  check('Avisos de pouca quota e limite atingido',(await page.locator('.quota-selected-card').innerText()).includes('Limite atingido'));
  check('Zero é zero e a barra não fica cheia',(await page.locator('.quota-selected-card progress').last().getAttribute('value'))==='0');
  await page.screenshot({path:path.join(out,'quotas-baixas.png')});
  clients.codex.emit('quotas',{rateLimits:{limitId:'codex',primary:{usedPercent:25,windowDurationMins:300,resetsAt:reset+7200},secondary:{usedPercent:60,windowDurationMins:10080,resetsAt:reset+4*86400}}});
  // A dual draft changes no server conversation and must show both models at once.
  await page.locator('#dual-toggle').click();await page.locator('.dual-dialog').getByLabel('Segundo modelo · cliente').selectOption('claude');
  await page.locator('.dual-dialog select').nth(1).selectOption('opus');
  await page.locator('.dual-dialog').getByRole('button',{name:'Usar no primeiro pedido'}).click();
  check('Dual: os dois modelos e limites visíveis',await page.locator('.quota-selected-card').count()===2 && await page.locator('.quota-selected-card .quota-window').count()===4);
  check('Dual: cada participante tem a sua cor',await page.locator('.quota-selected-card').evaluateAll(es=>new Set(es.map(e=>getComputedStyle(e).getPropertyValue('--quota-color'))).size===2));
  await page.locator('.quota-browser').evaluate(e=>e.open=false);
  await page.screenshot({path:path.join(out,'dual-limites.png')});
  await page.locator('#tab-claudex').click(); await page.locator('#cx-codexModel option[value="gpt-6.1-terra"]').waitFor({ state: 'attached' });
  check('Hydra também recebe Terra', await page.locator('#cx-codexModel option[value="gpt-6.1-terra"]').count() === 1);
  check('Hydra: quotas dos dois selecionados',await page.locator('.quota-selected-card').count()===2 && (await page.locator('.quota-selected-card .quota-mode').allTextContents()).every(t=>t==='Hydra'));
  await page.selectOption('#cx-participant1','antigravity');await page.selectOption('#cx-antigravityModel','gemini-4-argon');
  check('Hydra: seleção do Argon troca os limites imediatamente',await page.locator('.quota-selected-card[data-provider="antigravity"] [data-window="argon-weekly"]').count()===1 && await page.locator('.quota-selected-card[data-provider="claude"]').count()===0);
  await page.locator('#tab-conversations').click();
  await page.locator('#mode-choices [data-mode=hydra]').click();
  check('Hydra na conversa: dois modelos continuam visíveis',await page.locator('.quota-selected-card').count()===2 && (await page.locator('.quota-selected-card .quota-mode').allTextContents()).every(t=>t==='Hydra'));
  for (const theme of ['atelier', 'classic', 'mono']) {
    await page.evaluate(theme => { document.body.dataset.theme = theme; }, theme);
    await page.screenshot({path:path.join(out,theme+'-limites.png')});
    check(`${theme}: todos os grupos continuam acessíveis`, await page.locator('.provider-status-body .quota-window').count() === 9);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  check('390px sem overflow horizontal', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('Nenhuma consulta enviou pedidos aos modelos', Object.values(clients).every(c => c.logs.length === 0 && c.conversations.length === 0));
  check('Botão consultou catálogo', catalogReads >= 2); check('Sem erros de JavaScript', errors.length === 0);
} finally {
  await browser?.close(); server?.closeStreams(); if (server) await new Promise(r => server.close(r)); await hub.close();
  await writeFile(path.join(out, 'results.json'), JSON.stringify({ checks, errors }, null, 2)); await rm(root, { recursive: true, force: true });
}
if (checks.some(c => !c.ok) || errors.length) process.exitCode = 1;
