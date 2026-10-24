// Isolated visual QA with simulated clients; never connects to the running HYDRAQ.
// node validation/linho-ui.mjs [output-directory]
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { Providers } from '../lib/providers.mjs';
import { OpinionClient } from '../test/fixtures/opinion-client.mjs';
import { createHttpServer } from '../lib/http.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(repo, '.hydraq/linho-2026-10-24'));
const scratch = await mkdtemp(path.join(tmpdir(), 'hydraq-linho-'));
await mkdir(out, { recursive: true });
const results = [], errors = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), ...(detail ? { detail } : {}) });
  if (!ok) console.error('FAIL', name, detail || '');
};
const clients = Object.fromEntries(['codex', 'claude', 'antigravity', 'cursor', 'opencode'].map(p => [p, new OpinionClient(p, path.join(scratch, p), { behavior: 'hold' })]));
const hub = new Providers({ dataDir: path.join(scratch, 'hub'), defaultCwd: repo, clients, git: async () => [] });
let browser, server;
try {
  await hub.load();
  await hub.connectAll();
  const c = await clients.codex.create({ cwd: repo, model: 'test', effort: 'high', sandbox: 'read-only' });
  c.title = 'Arquitetura e próximos passos';
  server = createHttpServer({ hydraq: hub, publicDir: path.join(repo, 'public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const sheet = await readFile(path.join(repo, 'public/style.css'), 'utf8');
  const marker = sheet.indexOf('/* Linho —');
  const original = execFileSync('git', ['show', 'HEAD:public/style.css'], { cwd: repo, encoding: 'utf8' });
  check('Existing CSS preserved byte for byte before the appended theme', marker > 0 && sheet.slice(0, marker).trimEnd() === original.trimEnd());

  async function open(theme, width, height) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(theme => {
      if (!sessionStorage.getItem('linho-seeded')) {
        localStorage.setItem('hydraq.theme', theme);
        localStorage.setItem('hydraq.provider', 'codex');
        sessionStorage.setItem('linho-seeded', '1');
      }
    }, theme);
    await page.goto(url);
    await page.locator('#welcome h1').waitFor();
    await page.waitForFunction(theme => document.body.dataset.theme === theme && document.querySelector('#model').value, theme);
    return page;
  }
  const shot = (page, name) => page.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' });
  const visibleStyles = page => page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().width && el.getBoundingClientRect().height && !el.matches('[data-swatch="linho"]')).map(el => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return [el.tagName, el.id, el.className?.baseVal ?? el.className, r.x, r.y, r.width, r.height,
      ...['backgroundColor', 'color', 'borderColor', 'borderRadius', 'fontFamily', 'fontSize', 'lineHeight', 'padding', 'margin', 'display', 'boxShadow'].map(p => s[p])];
  }));
  async function overflow(page, name) {
    const sizes = await page.evaluate(() => ({ viewport: innerWidth, height: innerHeight, document: document.documentElement.scrollWidth, composer: document.querySelector('#composer').getBoundingClientRect().toJSON() }));
    check(name + ': no horizontal overflow', sizes.document <= sizes.viewport, sizes);
    check(name + ': composer remains in viewport', sizes.composer.x >= 0 && sizes.composer.right <= sizes.viewport + 1 && sizes.composer.y >= 0 && sizes.composer.bottom <= sizes.height + 1, sizes);
  }
  for (const theme of ['classic', 'atelier']) {
    const page = await open(theme, 1440, 1000);
    await shot(page, theme + '-with-linho-css');
    const before = await visibleStyles(page);
    await page.evaluate(() => {
      for (const sheet of document.styleSheets) for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
        if (sheet.cssRules[i].cssText.includes('linho')) sheet.deleteRule(i);
      }
    });
    await shot(page, theme + '-without-linho-css');
    const after = await visibleStyles(page);
    const changes = before.flatMap((entry, i) => JSON.stringify(entry) === JSON.stringify(after[i]) ? [] : [{ before: entry, after: after[i] }]);
    check(theme + ': identical visible styles and geometry with and without Linho', !changes.length && before.length === after.length, changes.slice(0, 2));
    await page.close();
  }

  for (const [width, height] of [[1440, 1000], [1024, 900], [768, 1024], [390, 844], [375, 812], [844, 390]]) {
    const page = await open('linho', width, height);
    await overflow(page, 'Welcome ' + width);
    await shot(page, 'linho-welcome-' + width);
    await page.click('#theme-toggle');
    check('Menu ' + width + ': all three appearances', await page.locator('#appearance-menu [role="menuitemradio"]').count() === 3);
    await page.keyboard.press('Escape');
    await page.locator('.suggestions button').first().click();
    check('Suggestion fills prompt ' + width, (await page.locator('#prompt').inputValue()).includes('Analisa este projeto'));
    await page.locator('#prompt').fill('');
    await page.click('#inspector-toggle');
    if (width <= 800) await page.locator('#inspector-scrim').click({ position: { x: 10, y: 10 } });
    else await page.click('#inspector-toggle');
    await page.click('#sidebar-toggle');
    if (width <= 800) await page.locator('#sidebar-scrim').click({ position: { x: width - 10, y: 10 } });
    else await page.click('#sidebar-toggle');
    if (width <= 800) await page.click('#inspector-toggle');
    await page.locator('#settings-details').evaluate(e => { e.open = true; });
    await page.locator('#appearance-choices').scrollIntoViewIfNeeded();
    check('Settings ' + width + ': Linho selected', await page.getByRole('radio', { name: /Linho/ }).getAttribute('aria-checked') === 'true');
    await shot(page, 'linho-settings-' + width);
    if (width <= 800) await page.locator('#inspector-scrim').click({ position: { x: 10, y: 10 } });
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.theme === 'linho');
    check('Reload ' + width + ': preference survives', await page.locator('#theme-label').textContent() === 'Linho');
    await page.click('#dual-toggle');
    await page.locator('.dual-dialog[open]').waitFor();
    await shot(page, 'linho-dual-dialog-' + width);
    check('Dialog ' + width + ': fits viewport', await page.locator('.dual-dialog').evaluate(el => { const r = el.getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth; }));
    await page.keyboard.press('Escape');
    if (width === 1440) {
      await page.keyboard.press('Control+k');
      await page.locator('#command-palette[open]').waitFor();
      await page.locator('#command-palette-input').fill('Linho');
      await shot(page, 'linho-command-palette');
      await page.keyboard.press('Escape');
      // Chromium first clears a search field; a second Escape dismisses its dialog.
      if (await page.locator('#command-palette').evaluate(el => el.open)) await page.keyboard.press('Escape');
      const contrast = await page.evaluate(() => {
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
        const luminance = color => {
          ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
          const v = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(x => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; });
          return v[0] * .2126 + v[1] * .7152 + v[2] * .0722;
        };
        const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
        const style = getComputedStyle(document.body), token = name => style.getPropertyValue(name).trim();
        const pairs = [['primary', '--text-primary', '--bg-app'], ['secondary', '--text-secondary', '--bg-app'], ['muted', '--text-tertiary', '--bg-surface']];
        const result = Object.fromEntries(pairs.map(([name, a, b]) => [name, ratio(token(a), token(b))]));
        for (const hue of ['esmeralda', 'lima', 'ambar', 'laranja', 'rubi', 'rosa', 'violeta', 'azul', 'ciano']) result[hue] = ratio(token('--hue-' + hue), token('--bg-surface'));
        result.sidebar = ratio('#c4cec1', '#193c31');
        result.paletteSubtitle = ratio(getComputedStyle(document.querySelector('.command-item-main small')).color, token('--bg-surface'));
        const badge = getComputedStyle(document.querySelector('.command-item-badge'));
        result.paletteBadge = ratio(badge.color, badge.backgroundColor);
        return result;
      });
      check('All semantic text and client hues meet 4.5:1 contrast', Object.values(contrast).every(v => v >= 4.5), contrast);
      await page.locator('#theme-toggle').focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const focus = await page.locator('#theme-toggle').evaluate(el => ({ active: document.activeElement.id, visible: el.matches(':focus-visible'), outline: getComputedStyle(el).outlineStyle, dialogs: [...document.querySelectorAll('dialog[open]')].map(d => d.id || d.className) }));
      check('Visible keyboard focus', focus.visible && focus.outline !== 'none', focus);
      await hub.send(c.id, 'Propõe um plano de implementação, sem alterar ficheiros.', 'linho-reading', { model: 'test', effort: 'high', sandbox: 'read-only' });
      clients.codex.finish(c, '### Um espaço para pensar\n\nO plano mantém **decisões claras**, passos verificáveis e o contexto da conversa.\n\n1. Identificar o problema.\n2. Verificar as hipóteses.\n3. Implementar e testar.\n\n> Uma decisão de cada vez.\n\n| Etapa | Estado |\n| --- | --- |\n| Análise | Concluída |\n| Implementação | Por iniciar |\n\n```js\nconst message = "Olá, HYDRAQ";\nconsole.log(message);\n```');
      await page.locator('.conversation-link').first().click();
      await page.locator('.message.assistant').waitFor();
      await page.locator('#settings-details').evaluate(el => { el.open = true; });
      await page.locator('#text-size').evaluate(el => { el.value = '22'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      check('Reading preference reaches 22px', await page.locator('.message.assistant .message-content').evaluate(el => getComputedStyle(el).fontSize === '22px'));
      await shot(page, 'linho-conversation-22px');
      await page.locator('#text-size').evaluate(el => { el.value = '15'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await shot(page, 'linho-conversation');
    }
    await page.close();
  }
  check('No browser JavaScript or console errors', errors.length === 0, errors);
} finally {
  await browser?.close();
  if (server) { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await hub.close();
  await rm(scratch, { recursive: true, force: true });
  await writeFile(path.join(out, 'results.json'), JSON.stringify({ results, errors }, null, 2));
}
const failed = results.filter(result => !result.ok);
console.log(JSON.stringify({ passed: results.length - failed.length, failed, output: out }));
process.exitCode = failed.length ? 1 : 0;
