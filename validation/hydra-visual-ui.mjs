// Isolated QA of the Hydra and Dual visuals: the pair's colours in a gradient and the Dual → Hydra fusion, recorded on
// video for frame inspection. Simulated clients only. node validation/hydra-visual-ui.mjs [output-directory]
import { mkdtemp, mkdir, rm, writeFile, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { Providers } from '../lib/providers.mjs';
import { OpinionClient } from '../test/fixtures/opinion-client.mjs';
import { createHttpServer } from '../lib/http.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(repo, '.hydraq/hydra-visual-2026-10-27'));
await mkdir(out, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), 'hydraq-hydra-visual-'));
const clients = Object.fromEntries(['codex', 'claude', 'antigravity', 'cursor', 'opencode'].map(p => { const c = new OpinionClient(p, path.join(root, p), { behavior: 'hold' }); c.defaultCwd = root; return [p, c]; }));
const hub = new Providers({ dataDir: path.join(root, 'hub'), defaultCwd: root, clients, git: async () => [] });
const results = [], errors = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok) }); if (!ok) console.error('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
// Atelier's emerald (Codex) and orange (Claude), as the browser computes them.
const CODEX = 'rgb(16, 185, 129)', CLAUDE = 'rgb(249, 115, 22)';
let browser, server;
try {
  await hub.load(); await hub.connectAll();
  const snapshot = hub.snapshot.bind(hub);
  hub.snapshot = () => { const value = snapshot(); return { ...value, nativeSessions: { ...(value.nativeSessions || {}), available: true, sessions: [] } }; };
  const normal = await clients.codex.create({ cwd: root, model: 'test', effort: 'high', sandbox: 'read-only' }); normal.title = 'Dual para Hydra';
  await hub.send(normal.id, 'Olá.', 'normal-1', { model: 'test', effort: 'high', sandbox: 'read-only' });
  clients.codex.finish(normal, 'Olá! Em que posso ajudar?');
  await hub.startDual(normal.id, { provider: 'claude', model: 'test', effort: 'low' });
  server = createHttpServer({ hydraq: hub, publicDir: path.join(repo, 'public') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const open = async (theme, options = {}) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(theme + ' ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(theme + ' ' + m.text()); });
    await page.addInitScript(([id, theme]) => { localStorage.setItem('hydraq.theme', theme); localStorage.setItem('hydraq.conversation', id); }, [normal.id, theme]);
    await page.goto(url); await page.waitForFunction(() => document.querySelector('#dual-hydra') && !document.querySelector('#dual-hydra').hidden);
    return { context, page };
  };
  const composerImage = page => page.evaluate(() => getComputedStyle(document.querySelector('#composer')).backgroundImage);

  // Atelier, recorded: the Dual's quiet edge, then the fusion, then Hydra's pair gradient.
  const videoDir = path.join(out, 'video');
  const { context, page } = await open('atelier', { recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } } });
  const recordingStarted = Date.now();
  const dualImage = await composerImage(page);
  check('Dual: composer edge in the two participants\' colours', /linear-gradient/.test(dualImage) && (dualImage.match(/linear-gradient/g) || []).length === 2, dualImage);
  await page.screenshot({ path: out + '/dual-atelier.png' });
  const box = await page.locator('#composer').boundingBox();
  await page.waitForTimeout(600);
  const clickedAt = Date.now();
  await page.locator('#dual-hydra').click();
  const fusion = await page.evaluate(() => { const f = document.querySelector('.hydra-fusion'), top = document.querySelector('#composer').getBoundingClientRect().top; return f ? { pieces: f.children.length, mark: Boolean(f.querySelector('.hydra-mark')), a: getComputedStyle(f.querySelector('.hydra-fusion-a')).backgroundColor, b: getComputedStyle(f.querySelector('.hydra-fusion-b')).backgroundColor, core: getComputedStyle(f.querySelector('.hydra-fusion-core')).backgroundImage, left: parseFloat(f.style.left), top: parseFloat(f.style.top), composerTop: top } : null; });
  check('fusion starts on the click, in the pair\'s colours', fusion?.mark && fusion.a === CODEX && fusion.b === CLAUDE && fusion.core.includes(CODEX) && fusion.core.includes(CLAUDE), fusion);
  check('fusion sits on the composer\'s edge as laid out for Hydra', fusion && Math.abs(fusion.top - fusion.composerTop) < 2, fusion);
  await page.waitForTimeout(850);
  const middle = await page.evaluate(() => { const ring = document.querySelector('.hydra-fusion-ring'), mark = document.querySelector('.hydra-fusion .hydra-mark'); return ring && mark ? { ring: Number(getComputedStyle(ring).opacity), mark: Number(getComputedStyle(mark).opacity) } : null; });
  check('at 0,85 s, the ring is open and the mark appears', middle && middle.ring > 0 && middle.mark > 0, middle);
  await page.waitForTimeout(900);
  check('fusion removed when it ends', await page.locator('.hydra-fusion').count() === 0);
  await page.locator('#prompt').fill('Pergunta para o Hydra.');
  const hydraImage = await composerImage(page), send = await page.evaluate(() => getComputedStyle(document.querySelector('#send')).backgroundImage), chip = await page.evaluate(() => getComputedStyle(document.querySelector('#hydra-chip'), '::before').backgroundImage);
  check('Hydra: composer edge goes from one client\'s colour to the other\'s', hydraImage.includes(CODEX) && hydraImage.includes(CLAUDE) && hydraImage.indexOf(CODEX) < hydraImage.lastIndexOf(CLAUDE), hydraImage);
  check('Hydra: send button and chip in the pair gradient', send.includes(CODEX) && send.includes(CLAUDE) && chip.includes(CODEX) && chip.includes(CLAUDE), { send, chip });
  const card = await page.evaluate(() => getComputedStyle(document.querySelector('#messages > #hydra-inline')).backgroundImage);
  check('Hydra: task card edge in the pair gradient', (card.match(/linear-gradient/g) || []).length === 2, card);
  await page.screenshot({ path: out + '/hydra-atelier.png' });
  await page.locator('.mode-tile[data-mode="normal"]').click();
  await page.waitForFunction(() => !document.body.dataset.hydra);
  check('back to the Dual: no pair colours left on the page', await page.evaluate(() => !document.body.style.getPropertyValue('--pair-a')) && (await composerImage(page)).includes('linear-gradient'));
  const video = await page.video().path();
  await context.close();
  // Frames from 0,1 s before the click to 1,6 s after, around the composer's top edge: 25 per second, as recorded.
  const start = Math.max(0, (clickedAt - recordingStarted) / 1000 - 0.1);
  const crop = `crop=360:220:${Math.round(fusion.left - 180)}:${Math.max(0, Math.round(fusion.top - 110))}`;
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', start.toFixed(2), '-t', '1.7', '-i', video, '-vf', `${crop},fps=25,tile=9x5:padding=4`, '-frames:v', '1', path.join(out, 'fusion-frames.png')]);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', start.toFixed(2), '-t', '1.7', '-i', video, '-vf', `${crop},fps=25`, path.join(out, 'fusion-%02d.png')]);
  await rename(video, path.join(out, 'fusion-atelier.webm'));
  check('fusion frames extracted', (await readdir(out)).filter(name => /^fusion-\d+\.png$/.test(name)).length >= 30);

  // Reduced motion: the switch happens, without the animation.
  { const { context, page } = await open('atelier', { reducedMotion: 'reduce' });
    await page.locator('#dual-hydra').click();
    check('reduced motion: no fusion, Hydra still on', await page.locator('.hydra-fusion').count() === 0 && await page.evaluate(() => Boolean(document.body.dataset.hydra)));
    await page.locator('.mode-tile[data-mode="normal"]').click(); await context.close(); }
  // The other appearances keep their surfaces, with the pair edge.
  for (const theme of ['classic', 'mono']) {
    const { context, page } = await open(theme);
    await page.locator('#dual-hydra').click(); await page.waitForTimeout(1400);
    const image = await composerImage(page);
    check(`${theme}: Hydra composer edge in the pair gradient`, /linear-gradient/.test(image) && (image.match(/linear-gradient/g) || []).length === 2, image);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(150);
      check(`${theme} ${width} no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: `${out}/hydra-${theme}-${width}.png` });
    }
    await context.close();
  }
} catch (error) { console.error('ERROR', error.stack || error.message); check('script completed', false); }
finally { await browser?.close(); server?.close(); await hub.close?.().catch(() => {}); await rm(root, { recursive: true, force: true }); }
check('no JavaScript errors', !errors.length, errors);
const summary = { out, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).map(r => r.name), results, errors };
await writeFile(path.join(out, 'results.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ out, passed: summary.passed, failed: summary.failed, errors }));
if (summary.failed.length) process.exitCode = 1;
