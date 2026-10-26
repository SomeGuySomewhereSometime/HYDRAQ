import test from 'node:test';
import assert from 'node:assert/strict';
import { readLayout, clampWidth, defaultLayout, PANEL_LIMITS, MIN_CONVERSATION } from '../public/layout.js';

test('reading preferences survive reload and reject corrupt or unsupported values', () => {
  const saved = { column: 'narrow', prose: 'full', textSize: 20 };
  const restored = readLayout(JSON.stringify(saved));
  for (const [key, value] of Object.entries(saved)) assert.equal(restored[key], value);
  for (const textSize of [12, 23, 15.5, '20', null, {}, true]) assert.equal(readLayout(JSON.stringify({ textSize })).textSize, 15);
  // Old alignment choices no longer affect the layout, while text size is preserved.
  for (const textAlign of ['left', 'center', 'justify']) {
    const legacy = readLayout(JSON.stringify({ textAlign, textSize: 20 }));
    assert.equal('textAlign' in legacy, false);
    assert.equal(legacy.textSize, 20);
  }
  for (const textSize of [13, 15, 22]) assert.equal(readLayout(JSON.stringify({ textSize })).textSize, textSize);
  const old = readLayout(JSON.stringify({ theme: 'classic', column: 'medium' }));
  assert.equal(old.textSize, 15);
  assert.equal(old.column, 'medium');
});

test('layout preferences fall back to defaults when missing or invalid', () => {
  assert.deepEqual(readLayout(null), defaultLayout());
  assert.deepEqual(readLayout('{not json'), defaultLayout());
  assert.deepEqual(readLayout('"texto"'), defaultLayout());
  const value = readLayout(JSON.stringify({ sidebar: { width: 'x', open: 'sim' }, inspector: { width: 9999, open: false }, prose: 'gigante', extra: true }));
  assert.equal(value.sidebar.width, PANEL_LIMITS.sidebar.initial);
  assert.equal(value.sidebar.open, true);
  assert.equal(value.inspector.width, PANEL_LIMITS.inspector.max);
  assert.equal(value.inspector.open, false);
  assert.equal(value.prose, 'comfortable');
  assert.equal(value.theme, 'atelier');
  assert.equal(readLayout(JSON.stringify({ prose: 'full', theme: 'classic' })).prose, 'full');
  assert.equal(readLayout(JSON.stringify({ theme: 'classic' })).theme, 'classic');
  assert.equal(readLayout(JSON.stringify({ theme: 'atelier' }), 'classic').theme, 'classic');
  assert.equal(readLayout(JSON.stringify({ theme: 'invalido' }), 'outro').theme, 'atelier');
});

test('panel widths stay within limits and leave room for the conversation', () => {
  assert.equal(clampWidth('sidebar', 10), PANEL_LIMITS.sidebar.min);
  assert.equal(clampWidth('sidebar', 5000), PANEL_LIMITS.sidebar.max);
  assert.equal(clampWidth('inspector', 333.6), 334);
  // 1200px window with a 340px inspector leaves 400px for the sidebar before the conversation minimum.
  assert.equal(clampWidth('sidebar', 440, { viewport: 1200, other: 340 }), 1200 - 340 - MIN_CONVERSATION);
  // Too narrow for both: the panel keeps its own minimum instead of disappearing.
  assert.equal(clampWidth('inspector', 500, { viewport: 700, other: 264 }), PANEL_LIMITS.inspector.min);
});

test('appearance offers Grafite, Atelier and Mono; removed themes, Linho included, fall back to the default', async () => {
  const { THEMES, APPEARANCES, appearanceOf } = await import('../public/layout.js');
  assert.deepEqual(THEMES, ['classic', 'atelier', 'mono']);
  assert.deepEqual(APPEARANCES.map(entry => entry.name), ['Grafite', 'Atelier', 'Mono']);
  assert.equal(defaultLayout().theme, 'atelier');
  assert.equal(readLayout(JSON.stringify({ theme: 'linho' })).theme, defaultLayout().theme);
  assert.equal(readLayout(null, 'linho').theme, defaultLayout().theme);
  assert.equal(appearanceOf('linho').name, 'Grafite');
  assert.equal(readLayout(JSON.stringify({ theme: 'mono' })).theme, 'mono');
  assert.equal(readLayout(null, 'mono').theme, 'mono');
  assert.equal(appearanceOf('mono').name, 'Mono');
  // Preferences saved with Editorial, Meridiano or old palettes open on the default appearance.
  for (const old of ['editorial', 'meridiano', 'neon']) assert.equal(readLayout(JSON.stringify({ theme: old })).theme, defaultLayout().theme);
  const classic = readLayout(JSON.stringify({ theme: 'classic', palette: 'nevoa', mode: 'dark' }));
  assert.equal(classic.theme, 'classic');
  assert.equal('palette' in classic || 'mode' in classic, false);
  // The separate theme key wins over the layout copy, as before.
  assert.equal(readLayout(JSON.stringify({ theme: 'atelier' }), 'classic').theme, 'classic');
  assert.equal(readLayout(JSON.stringify({ theme: 'classic' }), 'meridiano').theme, 'classic');
  assert.equal(appearanceOf('classic').name, 'Grafite');
  assert.equal(appearanceOf('atelier').name, 'Atelier');
  assert.equal(appearanceOf('editorial').name, 'Grafite');
});

test('conversation width and client colours accept only known values', async () => {
  const { COLUMNS, CLIENTS, HUES, DEFAULT_COLORS } = await import('../public/layout.js');
  assert.deepEqual(COLUMNS.map(entry => entry.value), ['full', 'medium', 'narrow']);
  assert.equal(defaultLayout().column, 'full');
  assert.equal(readLayout(JSON.stringify({ column: 'narrow' })).column, 'narrow');
  assert.equal(readLayout(JSON.stringify({ column: 'gigante' })).column, 'full');
  assert.deepEqual(CLIENTS.map(client => client.id), ['codex', 'antigravity', 'claude', 'cursor', 'opencode']);
  assert.deepEqual(defaultLayout().colors, DEFAULT_COLORS);
  // Claude is orange by default; every client starts with its own distinct, known hue.
  assert.equal(DEFAULT_COLORS.claude, 'laranja');
  assert.equal(new Set(Object.values(DEFAULT_COLORS)).size, CLIENTS.length);
  for (const client of CLIENTS) assert.ok(HUES.some(hue => hue.id === DEFAULT_COLORS[client.id]), client.id);
  const colors = readLayout(JSON.stringify({ colors: { codex: 'azul', claude: 'neon', cursor: 7, outro: 'rosa' } })).colors;
  assert.deepEqual(colors, { ...DEFAULT_COLORS, codex: 'azul' });
  assert.deepEqual(readLayout(JSON.stringify({ colors: 'rosa' })).colors, DEFAULT_COLORS);
});
