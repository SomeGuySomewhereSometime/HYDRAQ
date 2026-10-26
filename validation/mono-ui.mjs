// Isolated appearance QA. Simulated clients, no access to personal sessions.
// node validation/mono-ui.mjs [output-directory]
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { Providers } from '../lib/providers.mjs';
import { OpinionClient } from '../test/fixtures/opinion-client.mjs';
import { createHttpServer } from '../lib/http.mjs';
import { APPEARANCES } from '../public/layout.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(repo, '.hydraq/mono-2026-10-25'));
const root = await mkdtemp(path.join(tmpdir(), 'hydraq-mono-'));
await mkdir(out, { recursive: true });
const results = [], errors = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), ...(detail ? { detail } : {}) });
  if (!ok) console.error('FAIL', name, JSON.stringify(detail || ''));
};
const clients = Object.fromEntries(['codex', 'claude', 'antigravity', 'cursor', 'opencode'].map(p => {
  const c = new OpinionClient(p, path.join(root, p), { behavior: 'hold' });
  c.defaultCwd = repo;
  if (p === 'opencode') c.refreshModels = async cwd => ({ cwd, models: c.models, stale: false });
  return [p, c];
}));
const hub = new Providers({ dataDir: path.join(root, 'hub'), defaultCwd: repo, clients, git: async () => [] });
let browser, server;
try {
  await hub.load(); await hub.connectAll();
  const conversation = await clients.codex.create({ cwd: repo, model: 'test', effort: 'high', sandbox: 'read-only' });
  conversation.title = 'Arquitetura e próximos passos';
  server = createHttpServer({ hydraq: hub, publicDir: path.join(repo, 'public') });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const css = await readFile(path.join(repo, 'public/style.css'), 'utf8');
  const old = execFileSync('git', ['show', 'HEAD:public/style.css'], { cwd: repo, encoding: 'utf8' });
  check('CSS of the other appearances remains byte-identical', css.split('/* Mono —')[0] === old.split('/* Mono —')[0]);
  async function open(theme, width, height) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(theme => {
      if (!sessionStorage.getItem('mono-seeded')) {
        localStorage.setItem('hydraq.theme', theme);
        localStorage.setItem('hydraq.provider', 'codex');
        sessionStorage.setItem('mono-seeded', '1');
      }
    }, theme);
    await page.goto(url);
    await page.waitForFunction(theme => document.body.dataset.theme === theme && document.querySelector('#model').value, theme);
    return page;
  }
  const shot = (page, name) => page.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' });
  const styles = page => page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().width && el.getBoundingClientRect().height && !el.matches('[data-swatch="mono"]')).map(el => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return [el.tagName, el.id, el.className?.baseVal ?? el.className, r.x, r.y, r.width, r.height,
      ...['backgroundColor', 'color', 'borderColor', 'borderRadius', 'fontFamily', 'fontSize', 'lineHeight', 'padding', 'margin', 'display', 'boxShadow'].map(p => s[p])];
  }));
  const fits = async (page, name) => {
    const m = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, scroll: document.documentElement.scrollWidth, rect: document.querySelector('#composer').getBoundingClientRect().toJSON() }));
    check(name + ': no horizontal overflow', m.scroll <= m.w, m);
    check(name + ': composer fully inside viewport', m.rect.x >= 0 && m.rect.right <= m.w + 1 && m.rect.y >= 0 && m.rect.bottom <= m.h + 1, m);
  };
  for (const theme of ['classic', 'atelier']) {
    const page = await open(theme, 1440, 1000);
    await shot(page, 'preserved-' + theme);
    const before = await styles(page);
    await page.evaluate(() => {
      for (const sheet of document.styleSheets) for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
        const text = sheet.cssRules[i].cssText;
        if (text.includes('[data-theme="mono"]') || text.includes('[data-swatch="mono"]')) sheet.deleteRule(i);
      }
    });
    const after = await styles(page);
    const changes = before.flatMap((entry, i) => JSON.stringify(entry) === JSON.stringify(after[i]) ? [] : [{ before: entry, after: after[i] }]);
    check(theme + ': unchanged visible styles and geometry', before.length === after.length && !changes.length, changes.slice(0, 2));
    await page.close();
  }
  for (const [width, height] of [[1440, 1000], [1024, 900], [768, 1024], [390, 844], [375, 812], [844, 390]]) {
    const page = await open('mono', width, height);
    await fits(page, 'Welcome ' + width);
    await shot(page, 'mono-welcome-' + width);
    if (width === 1440) {
      check('Approved logo replaces the old Mono brand', await page.locator('.mono-brand-art').isVisible() && !(await page.locator('.brand-mark').isVisible()));
      check('Approved symbol also appears on welcome', await page.locator('.welcome-mark > .mono-logo-symbol').isVisible());
      for (const provider of Object.keys(clients)) {
        await page.selectOption('#provider', provider);
        await page.waitForFunction(provider => document.body.dataset.provider === provider, provider);
        const identity = await page.evaluate(provider => {
          const probe = document.createElement('span'); probe.style.color = `var(--c-${provider})`; document.body.append(probe);
          const expected = getComputedStyle(probe).color; probe.remove();
          return { expected, symbol: getComputedStyle(document.querySelector('.mono-brand-symbol')).fill,
            name: getComputedStyle(document.querySelector('#provider-label')).color,
            wordmark: getComputedStyle(document.querySelector('.mono-brand-wordmark')).fill };
        }, provider);
        check('Brand and client status follow ' + provider, identity.symbol === identity.expected && identity.name === identity.expected && identity.wordmark === 'rgb(242, 242, 242)', identity);
        if (provider === 'antigravity') await shot(page, 'mono-welcome-antigravity');
      }
      await page.selectOption('#provider', 'codex');
    }
    await page.click('#theme-toggle');
    check('All four appearances available ' + width, await page.locator('#appearance-menu [role="menuitemradio"]').count() === APPEARANCES.length);
    await page.keyboard.press('Escape');
    await page.locator('.suggestions button').first().click();
    check('Suggestion fills draft ' + width, (await page.locator('#prompt').inputValue()).includes('Analisa este projeto'));
    await page.locator('#prompt').fill('Um rascunho preservado.');
    if (width === 1440) {
      await page.click('#theme-toggle');
      await page.getByRole('menuitemradio', { name: /Grafite/ }).click();
      await page.click('#theme-toggle');
      await page.getByRole('menuitemradio', { name: /Mono/ }).click();
      check('Changing appearance preserves draft', await page.locator('#prompt').inputValue() === 'Um rascunho preservado.');
    }
    await page.locator('#prompt').fill('');
    await page.click('#inspector-toggle');
    if (width > 800) await page.click('#inspector-toggle');
    await page.locator('#settings-details').evaluate(el => { el.open = true; });
    await page.locator('#appearance-choices').scrollIntoViewIfNeeded();
    check('Mono selected in settings ' + width, await page.getByRole('radio', { name: /^Mono/ }).getAttribute('aria-checked') === 'true');
    await shot(page, 'mono-settings-' + width);
    if (width <= 800) await page.locator('#inspector-scrim').click({ position: { x: 10, y: 10 } });
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.theme === 'mono' && document.querySelector('#model').value);
    check('Theme survives reload ' + width, await page.locator('#theme-label').textContent() === 'Mono');
    await page.click('#dual-toggle'); await page.locator('.dual-dialog[open]').waitFor();
    await shot(page, 'mono-dual-dialog-' + width);
    check('Dual dialog fits ' + width, await page.locator('.dual-dialog').evaluate(el => { const r = el.getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth; }));
    await page.keyboard.press('Escape');
    if (width === 1440) {
      await page.keyboard.press('Control+k'); await page.locator('#command-palette[open]').waitFor();
      await page.locator('#command-palette-input').fill('Mono'); await shot(page, 'mono-palette');
      await page.keyboard.press('Escape');
      if (await page.locator('#command-palette').evaluate(el => el.open)) await page.keyboard.press('Escape');
      await page.locator('#theme-toggle').focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
      check('Keyboard focus visible', await page.locator('#theme-toggle').evaluate(el => el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none'));
      const contrast = await page.evaluate(() => {
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
        const light = c => { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const v = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(x => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }); return v[0] * .2126 + v[1] * .7152 + v[2] * .0722; };
        const ratio = (a, b) => { const x = light(a), y = light(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
        const s = getComputedStyle(document.body), t = k => s.getPropertyValue(k).trim();
        const values = Object.fromEntries(['primary', 'secondary', 'tertiary'].map(k => [k, ratio(t('--text-' + k), t('--bg-app'))]));
        for (const h of ['esmeralda', 'lima', 'ambar', 'laranja', 'rubi', 'rosa', 'violeta', 'azul', 'ciano']) values[h] = ratio(t('--hue-' + h), t('--bg-surface'));
        const send = getComputedStyle(document.querySelector('#send'));
        values.send = ratio(send.color, send.backgroundColor);
        const sub = getComputedStyle(document.querySelector('.command-item-main small'));
        values.palette = ratio(sub.color, '#333333');
        return values;
      });
      check('Text, all nine client hues and primary action meet 4.5:1', Object.values(contrast).every(v => v >= 4.5), contrast);
      await hub.send(conversation.id, 'Analisa a arquitetura e propõe os próximos passos.', 'mono-reading', { model: 'test', effort: 'high', sandbox: 'read-only' });
      clients.codex.finish(conversation, '### Uma base clara para construir\n\nMantemos **as decisões visíveis**, o contexto e os passos verificáveis.\n\n1. Compreender o problema.\n2. Implementar com cuidado.\n3. Verificar o resultado.\n\n> Tudo começa com uma boa pergunta.\n\n| Etapa | Estado |\n| --- | --- |\n| Análise | Concluída |\n| Implementação | Por iniciar |\n\n```js\nconst project = "HYDRAQ";\nconsole.log(project);\n```');
      Object.assign(conversation.turns.at(-1).usage, { cachedInputTokens: 70, uncachedInputTokens: 30, cachePercent: 70 });
      // Announce terminal availability without connecting or launching a real client.
      hub.nativeSessions.codex.client = { call: async () => {}, off: () => {} };
      clients.codex.changed();
      await page.locator('.conversation-link').first().click(); await page.locator('.message.assistant').waitFor();
      await shot(page, 'mono-conversation');
      check('Terminal action visible beside composer', await page.locator('#terminal-switch').isVisible());
      await page.locator('#settings-details').evaluate(el => { el.open = true; });
      await page.locator('#text-size').evaluate(el => { el.value = '22'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      check('22px reading preference preserved', await page.locator('.message.assistant .message-content').evaluate(el => getComputedStyle(el).fontSize === '22px'));
      await shot(page, 'mono-conversation-22px');
      await page.locator('#text-size').evaluate(el => { el.value = '15'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      for (const provider of Object.keys(clients).filter(provider => provider !== 'codex')) {
        const peer = await clients[provider].create({ cwd: repo, group: conversation.id, model: 'test', effort: 'high', sandbox: 'read-only' });
        await clients[provider].send(peer.id, 'Como continuarias este projeto?', 'mono-identity-' + provider);
        const name = { claude: 'Claude Code', antigravity: 'Antigravity', cursor: 'Cursor', opencode: 'OpenCode' }[provider];
        clients[provider].finish(peer, `### Uma contribuição do ${name}\n\nCada resposta mantém a identidade de quem a escreveu, com o contexto disponível para o próximo passo.`);
        Object.assign(peer.turns.at(-1).usage, { cachedInputTokens: 70, uncachedInputTokens: 30, cachePercent: 70 });
        clients[provider].changed();
        await page.locator(`.message.assistant[data-provider="${provider}"]`).waitFor();
      }
      const authors = await page.locator('.message.assistant').evaluateAll(messages => messages.map(message => {
        const avatar = message.querySelector('.avatar'), mark = avatar.querySelector('.mono-message-symbol');
        const probe = document.createElement('span'); probe.style.color = `var(--c-${message.dataset.provider})`; message.append(probe);
        const expected = getComputedStyle(probe).color; probe.remove();
        return { provider: message.dataset.provider, expected, avatar: getComputedStyle(avatar).color,
          markVisible: getComputedStyle(mark).display !== 'none', rail: getComputedStyle(message).borderInlineStartWidth };
      }));
      check('All five authors retain their own colour and approved symbol', authors.length === 5 && authors.every(author => author.avatar === author.expected && author.markVisible && author.rail === '2px'), authors);
      await shot(page, 'mono-multiple-clients');
      await page.locator('.client-color-row[data-client="antigravity"] [data-hue="azul"]').click();
      check('Custom client colour updates an earlier answer independently of the active client', await page.locator('.message.assistant[data-provider="antigravity"] .avatar').evaluate(avatar => {
        const probe = document.createElement('span'); probe.style.color = 'var(--hue-azul)'; document.body.append(probe);
        const expected = getComputedStyle(probe).color; probe.remove();
        return getComputedStyle(avatar).color === expected && getComputedStyle(document.querySelector('.mono-brand-symbol')).fill !== expected;
      }));
      await page.locator('.client-color-row[data-client="antigravity"] [data-hue="ciano"]').click();
      const { dual } = await hub.startDual(conversation.id, { provider: 'antigravity', model: 'test', effort: 'high' });
      await hub.sendDual(dual.id, { text: 'Como preservar a identidade de cada resposta?', requestId: 'mono-dual-identity' });
      for (const member of Object.values(dual.members)) {
        const c = clients[member.provider].conversation(member.conversationId);
        clients[member.provider].finish(c, 'Cada resposta conserva o seu cliente, a sua cor e uma leitura clara.');
        Object.assign(c.turns.at(-1).usage, { cachedInputTokens: 70, uncachedInputTokens: 30, cachePercent: 70 });
        clients[member.provider].changed();
      }
      await page.locator('.dual-stage .review-panel').first().waitFor();
      check('Dual retains two independent panels', await page.locator('.dual-stage .review-panel').count() === 2);
      check('Dual panels fit without horizontal overflow', await page.locator('.dual-stage .review-panel').evaluateAll(panels => panels.every(panel => {
        const r = panel.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && panel.scrollWidth <= panel.clientWidth + 1;
      })));
      await shot(page, 'mono-dual-identities');
      await hub.endDual(dual.id);
    }
    await page.close();
  }
  check('No browser JavaScript/console errors', errors.length === 0, errors);
} finally {
  await browser?.close();
  if (server) { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await hub.close(); await rm(root, { recursive: true, force: true });
  await writeFile(path.join(out, 'results.json'), JSON.stringify({ results, errors }, null, 2));
}
const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({ passed: results.length - failed.length, failed, out }));
process.exitCode = failed.length ? 1 : 0;
