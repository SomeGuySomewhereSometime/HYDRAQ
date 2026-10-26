// Isolated QA of reply formatting, Copiar on the person's messages and the terminal control.
// Simulated clients only; terminal requests are answered by the browser route, never by a real client.
// node validation/messages-terminal-ui.mjs [output-directory]
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { Providers } from '../lib/providers.mjs';
import { OpinionClient } from '../test/fixtures/opinion-client.mjs';
import { createHttpServer } from '../lib/http.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(repo, '.hydraq/messages-terminal-2026-10-26'));
await mkdir(out, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), 'hydraq-messages-terminal-'));
const clients = Object.fromEntries(['codex', 'claude', 'antigravity', 'cursor', 'opencode'].map(p => { const c = new OpinionClient(p, path.join(root, p), { behavior: 'hold' }); c.defaultCwd = root; return [p, c]; }));
const hub = new Providers({ dataDir: path.join(root, 'hub'), defaultCwd: root, clients, git: async () => [] });
const results = [], errors = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok) }); if (!ok) console.error('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
const reply = [
  'Intro com *ênfase*, ~~riscado~~, `código` e https://example.com/a.',
  'Também [ver https://a.pt](https://b.pt) e **[negrito ligado](https://c.pt)**.',
  '## Secção principal',
  'Parágrafo logo após o título.',
  '### Subsecção',
  'Lista:',
  '- primeiro',
  '  - encaixado',
  '- segundo',
  '',
  '3. três',
  '',
  '4. quatro',
  '',
  '   continuação do quatro',
  '5. cinco',
  '',
  '- [x] feito',
  '- [ ] por fazer',
  '',
  '> Citação com **negrito**.',
  '',
  '| Nome | Valor | Uma coluna bastante larga para obrigar a tabela a deslizar em ecrãs estreitos |',
  '| --- | ---: | --- |',
  '| a | 1 | texto_com_sublinhados_que_não_são_ênfase |',
  '| b | 2 | [ligação](https://example.org/x) |',
  '',
  '---',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '```diff',
  '-velho',
  '+novo',
  '```',
  '',
  '```text',
  ...Array.from({ length: 30 }, (_, i) => 'linha ' + (i + 1)),
  '```',
  'Fim.',
].join('\n');
const held = { codex: null, claude: null };
let browser, server, page;
try {
  await hub.load(); await hub.connectAll();
  const normal = await clients.codex.create({ cwd: root, model: 'test', effort: 'high', sandbox: 'read-only' }); normal.title = 'Formatação';
  await hub.send(normal.id, 'Mostra exemplos de formatação.\nCom duas linhas.', 'fmt-1', { model: 'test', effort: 'high', sandbox: 'read-only' });
  const running = async c => { const by = Date.now() + 5000; while (c.turns.at(-1)?.status !== 'running') { if (Date.now() > by) throw Error('O pedido simulado não começou.'); await new Promise(r => setTimeout(r, 20)); } };
  await running(normal); clients.codex.finish(normal, reply);
  const fresh = await clients.codex.create({ cwd: root, model: 'test', effort: 'high', sandbox: 'read-only' }); fresh.title = 'Sem pedidos';
  const claude = await clients.claude.create({ cwd: root, model: 'test', effort: 'high', sandbox: 'plan' }); claude.title = 'Claude no terminal';
  await hub.send(claude.id, 'Olá Claude.', 'cl-1', { model: 'test', effort: 'high', sandbox: 'plan' });
  await running(claude); clients.claude.finish(claude, 'Olá.');
  const snapshot = hub.snapshot.bind(hub);
  hub.snapshot = () => {
    const value = snapshot();
    return { ...value,
      nativeSessions: { ...(value.nativeSessions || {}), available: true, sessions: held.codex ? [held.codex] : [] },
      claudeTerminal: { available: true, pending: [] },
      conversations: value.conversations.map(c => held.claude && c.id === held.claude.id ? { ...c, terminal: { since: held.claude.since } } : c) };
  };
  server = createHttpServer({ hydraq: hub, publicDir: path.join(repo, 'public') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const calls = { open: 0, release: 0 };
  // A slow terminal request: it answers only once the check lets it go.
  let hold = null;
  const delay = () => { let resolve; const promise = new Promise(r => { resolve = r; }); hold = promise; return () => { hold = null; resolve(); }; };
  const appears = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 2000 }).then(() => true, () => false);
  await page.route(/\/api\/conversations\/[^/]+\/(native|claude)-(open|release)$/, async route => {
    const [, client, action] = /(native|claude)-(open|release)$/.exec(route.request().url());
    calls[action]++;
    if (hold) await hold;
    await route.fulfill({ json: action === 'open' ? { conversationId: client === 'native' ? normal.id : claude.id, command: `cd /tmp && ${client === 'native' ? 'codex resume' : 'claude --resume'} TESTE` } : { released: true, imported: 0 } });
  });
  await page.addInitScript(id => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('hydraq.theme', 'atelier'); localStorage.setItem('hydraq.conversation', id); sessionStorage.setItem('seeded', '1'); } }, normal.id);
  await page.goto(url); await page.waitForFunction(() => document.querySelector('.message.assistant .message-content'));
  const content = page.locator('.message.assistant .message-content').first();
  const count = selector => content.locator(selector).count();
  const text = selector => content.locator(selector).first().textContent();

  // Copiar on the person's own message.
  const userCopy = page.locator('.message.user .copy-message').first();
  check('user message has Copiar', await userCopy.count() === 1);
  await page.locator('.message.user').first().hover();
  await userCopy.click();
  check('user Copiar copies the request', await page.evaluate(() => navigator.clipboard.readText()) === 'Mostra exemplos de formatação.\nCom duas linhas.');
  check('user Copiar confirms', /Copiado/.test(await userCopy.textContent()));
  check('assistant Copiar kept', await page.locator('.message.assistant .copy-message').count() === 1);

  // Reply formatting.
  check('inline em/del/code', await text('em') === 'ênfase' && await text('del') === 'riscado' && await count('p code') >= 1);
  check('bare link without the full stop', await content.locator('a[href="https://example.com/a"]').count() === 1);
  check('an address inside a link label stays text', await content.locator('a[href="https://b.pt"]').count() === 1 && await content.locator('a a').count() === 0 && await content.locator('a[href="https://a.pt"]').count() === 0);
  check('link inside bold', await content.locator('strong a[href="https://c.pt"]').count() === 1);
  check('## is h3, ### is h4', await text('h3') === 'Secção principal' && await text('h4') === 'Subsecção');
  check('paragraph right after a heading stays a paragraph', await content.locator('p', { hasText: 'Parágrafo logo após o título.' }).count() === 1);
  check('list right after a line is a list', await content.locator('p', { hasText: 'Lista:' }).count() === 1 && await count(':scope > ul > li > ul > li') === 1);
  check('ordered list keeps its start and stays one list', await content.locator('ol').count() === 1 && await content.locator('ol').getAttribute('start') === '3' && await content.locator('ol > li').count() === 3);
  check('indented paragraph stays inside its item', await content.locator('ol > li').nth(1).locator('p', { hasText: 'continuação do quatro' }).count() === 1);
  check('task list', await count('li.task') === 2 && await content.locator('li.task .task-box').first().textContent() === '☑');
  check('blockquote with inline marks', await count('blockquote strong') === 1);
  check('table with header, rows and alignment', await count('.table-wrap table th') === 3 && await count('table tbody tr') === 2 && await count('td[data-align="right"]') === 2);
  check('underscores inside words are not emphasis', await content.locator('td', { hasText: 'texto_com_sublinhados_que_não_são_ênfase' }).count() === 1);
  check('link inside a table cell', await content.locator('td a[href="https://example.org/x"]').count() === 1);
  check('horizontal rule', await count('hr') === 1);
  check('three code blocks', await count('.code-block') === 3);
  check('diff block keeps colours', await count('.code-block .diff-add') === 1 && await count('.code-block .diff-remove') === 1);
  const long = content.locator('.code-block.code-folded');
  check('long code block folds', await long.count() === 1 && await long.locator('.code-toggle').textContent() === 'Mostrar as 30 linhas');
  const foldedHeight = await long.locator('pre').evaluate(e => e.clientHeight);
  await long.locator('.code-toggle').click();
  const opened = content.locator('.code-block').nth(2);
  check('long code block unfolds', !await opened.evaluate(e => e.classList.contains('code-folded')) && await opened.locator('.code-toggle').textContent() === 'Recolher' && await opened.locator('pre').evaluate(e => e.clientHeight) > foldedHeight);
  check('short code block does not fold', await content.locator('.code-block').first().locator('.code-toggle').count() === 0);
  check('last paragraph after a fence', await content.locator('p', { hasText: /^Fim\.$/ }).count() === 1);
  for (const theme of ['atelier', 'classic', 'mono']) {
    await page.evaluate(t => localStorage.setItem('hydraq.theme', t), theme); await page.reload();
    await page.waitForFunction(() => document.querySelector('.message.assistant .message-content table'));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(150);
      check(`${theme} ${width} reply without horizontal page scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator('.message.assistant .message-content table').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/formatting-${theme}-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => localStorage.setItem('hydraq.theme', 'atelier')); await page.reload();
  await page.waitForFunction(() => document.querySelector('.message.assistant .message-content'));

  // Terminal control: ready to open.
  const composer = page.locator('#terminal-switch'), inspector = page.locator('#inspector-terminal');
  check('open offered beside the composer', /Abrir no terminal · Codex/.test(await composer.textContent()) && !await composer.locator('button').isDisabled());
  check('open offered in the Modo panel without a caption', /Abrir no terminal · Codex/.test(await inspector.textContent()) && await inspector.locator('.terminal-switch-caption').count() === 0);
  // While the open request waits, both controls say so, whichever of the three buttons asked.
  const opening = () => [...document.querySelectorAll('#terminal-switch [data-terminal="open"], #inspector-terminal [data-terminal="open"]')].every(b => b.textContent === 'A abrir no terminal · Codex…' && b.disabled);
  const ready = () => [...document.querySelectorAll('#terminal-switch [data-terminal="open"], #inspector-terminal [data-terminal="open"]')].every(b => b.textContent === 'Abrir no terminal · Codex' && !b.disabled);
  for (const [where, click] of [['composer', () => composer.locator('[data-terminal="open"]').click()], ['Modo panel', () => inspector.locator('[data-terminal="open"]').click()], ['settings', () => page.evaluate(() => document.querySelector('[data-native-open]').click())]]) {
    const letGo = delay(), before = calls.open;
    await click();
    check(`open from the ${where} shows A abrir in both controls`, await appears(opening));
    letGo();
    check(`open from the ${where} settles in both controls`, await appears(ready) && calls.open === before + 1);
  }
  // A conversation without a saved session: the reason is written in the panel, the composer keeps a tooltip.
  await page.evaluate(id => { localStorage.setItem('hydraq.conversation', id); }, fresh.id); await page.reload();
  await page.waitForFunction(() => document.querySelector('#inspector-terminal .terminal-switch-caption'));
  check('disabled open explains why in the panel', /Envia primeiro um pedido/.test(await inspector.locator('.terminal-switch-caption').textContent()) && await inspector.locator('button').isDisabled());
  check('composer keeps the reason in the tooltip', await composer.locator('.terminal-switch-caption').count() === 0 && /Envia primeiro/.test(await composer.locator('button').getAttribute('data-tip')));

  // Codex held by a terminal that disconnected.
  held.codex = { conversationId: normal.id, group: normal.id, connected: false, owner: 'terminal', preparing: false };
  await page.evaluate(id => { localStorage.setItem('hydraq.conversation', id); }, normal.id); await page.reload();
  await page.waitForFunction(() => document.querySelector('#terminal-switch[data-state="held"]'));
  check('held status says the terminal disconnected', /Codex no terminal · desligado/.test(await composer.locator('.terminal-switch-status').textContent()) && await composer.getAttribute('data-live') === 'false');
  check('held offers command and return', await composer.locator('[data-terminal="command"]').textContent() === 'Copiar comando' && await composer.locator('[data-terminal="release"]').textContent() === 'Continuar na HYDRAQ');
  check('panel says the Codex terminal is not connected', /não está ligado/.test(await inspector.locator('.terminal-switch-caption').textContent()));
  await composer.locator('[data-terminal="command"]').click();
  await page.waitForFunction(() => /Copiado/.test(document.querySelector('#terminal-switch [data-terminal="command"]').textContent));
  check('command copied', await page.evaluate(() => navigator.clipboard.readText()) === 'cd /tmp && codex resume TESTE' && calls.open === 4);
  check('command stays visible in the settings', await page.locator('[aria-label="Comando do terminal Codex"]').inputValue() === 'cd /tmp && codex resume TESTE');
  await page.waitForFunction(() => document.querySelector('#terminal-switch [data-terminal="command"]').textContent === 'Copiar comando', null, { timeout: 4000 });
  check('copy label resets', true);
  for (const theme of ['atelier', 'classic', 'mono']) {
    await page.evaluate(t => localStorage.setItem('hydraq.theme', t), theme); await page.reload();
    await page.waitForFunction(() => document.querySelector('#terminal-switch[data-state="held"]'));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(150);
      check(`${theme} ${width} held control without horizontal page scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      check(`${theme} ${width} held buttons fit`, await composer.evaluate(e => [...e.querySelectorAll('button')].every(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth + 1 && b.scrollWidth <= b.clientWidth + 1; })));
      await composer.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/terminal-held-${theme}-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  held.codex.connected = true; await page.reload();
  await page.waitForFunction(() => document.querySelector('#terminal-switch[data-live="true"]'));
  check('connected Codex terminal: live status and steps', /^Codex no terminal$/.test(await composer.locator('.terminal-switch-status').textContent()) && /Fecha o Codex no terminal/.test(await inspector.locator('.terminal-switch-caption').textContent()));
  const letGo = delay();
  await composer.locator('[data-terminal="release"]').click();
  check('return shows A voltar in both controls while it waits', await appears(() => [...document.querySelectorAll('#terminal-switch [data-terminal="release"], #inspector-terminal [data-terminal="release"]')].every(b => b.textContent === 'A voltar…' && b.disabled)));
  letGo();
  check('return settles in both controls', await appears(() => [...document.querySelectorAll('#terminal-switch [data-terminal="release"], #inspector-terminal [data-terminal="release"]')].every(b => b.textContent === 'Continuar na HYDRAQ' && !b.disabled)));
  check('return goes through the section', calls.release === 1);

  // Claude held: the time it went to the terminal.
  held.codex = null; held.claude = { id: claude.id, since: '2026-10-26T13:05:00.000Z' };
  await page.evaluate(id => { localStorage.setItem('hydraq.conversation', id); }, claude.id); await page.reload();
  await page.waitForFunction(() => document.querySelector('#terminal-switch[data-state="held"]'));
  const since = new Date(held.claude.since).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
  check('Claude held shows since when', (await composer.locator('.terminal-switch-status').textContent()) === `Claude no terminal · desde as ${since}` && await composer.getAttribute('data-live') === 'unknown');
  check('Claude panel writes the way back', /Sai do Claude \(\/exit\)/.test(await inspector.locator('.terminal-switch-caption').textContent()));
  await composer.locator('[data-terminal="command"]').click();
  await page.waitForFunction(() => /Copiado/.test(document.querySelector('#terminal-switch [data-terminal="command"]').textContent));
  check('Claude command copied', await page.evaluate(() => navigator.clipboard.readText()) === 'cd /tmp && claude --resume TESTE');
  await page.screenshot({ path: `${out}/terminal-held-claude-atelier.png` });

  // A reply still streaming: an unfolded block stays open while its lines keep arriving, even short ones.
  const live = await clients.codex.create({ cwd: root, model: 'test', effort: 'high', sandbox: 'read-only' }); live.title = 'Em curso';
  await hub.send(live.id, 'Escreve código.', 'live-1', { model: 'test', effort: 'high', sandbox: 'read-only' });
  await running(live);
  const code = n => ['Código:', '```text', ...Array.from({ length: n }, (_, i) => 'l' + (i + 1))].join('\n');
  const streamed = { id: 'live-reply', role: 'assistant', text: code(30), at: new Date().toISOString(), turnId: live.turns.at(-1).id, requestId: 'live-1', streaming: true };
  live.messages.push(streamed); clients.codex.changed();
  await page.evaluate(id => { localStorage.setItem('hydraq.conversation', id); }, live.id); await page.reload();
  await page.waitForFunction(() => document.querySelector('.message.assistant .code-block.code-folded'));
  const liveBlock = page.locator('.message.assistant .code-block').first();
  check('streaming block of 30 short lines folds', await liveBlock.locator('.code-toggle').textContent() === 'Mostrar as 30 linhas' && streamed.text.length < 200);
  await liveBlock.locator('.code-toggle').click();
  for (const n of [31, 32]) {
    streamed.text = code(n); clients.codex.changed();
    check(`line ${n} arrives`, await appears(last => document.querySelector('.message.assistant .code-block pre')?.textContent.endsWith(last), 'l' + n));
    check(`unfolded block stays open at ${n} lines`, await liveBlock.evaluate(e => !e.classList.contains('code-folded')) && await liveBlock.locator('.code-toggle').textContent() === 'Recolher');
  }
  await liveBlock.locator('.code-toggle').click();
  streamed.text = code(33); clients.codex.changed();
  check('a block folded again stays folded', await appears(() => document.querySelector('.message.assistant .code-toggle')?.textContent === 'Mostrar as 33 linhas') && await liveBlock.evaluate(e => e.classList.contains('code-folded')));
  clients.codex.finish(live, 'Fim.');
} catch (error) { console.error('ERROR', error.stack || error.message); check('script completed', false); await page?.screenshot({ path: out + '/failure.png' }).catch(() => {}); console.error('TOAST', (await page?.evaluate(() => document.querySelector('#toast')?.textContent).catch(e => e.message)) || ''); }
finally { await browser?.close(); server?.close(); await hub.close?.().catch(() => {}); await rm(root, { recursive: true, force: true }); }
check('no JavaScript errors', !errors.length, errors);
const summary = { out, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).map(r => r.name), results, errors };
await writeFile(path.join(out, 'results.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ out, passed: summary.passed, failed: summary.failed, errors }));
if (summary.failed.length) process.exitCode = 1;
