import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedQuotas, resetLabel } from '../public/provider-status.js';

const quota = (id, group, windowDurationMins = 10080) => ({ id, group, windowDurationMins });
test('limites Codex partilhados e próprios do modelo, sem confundir com outros modelos', () => {
  const windows = [quota('codex:secondary', 'codex'), quota('codex:primary', 'codex', 300), quota('gpt-6.1-terra:primary', 'Terra', 300), quota('other:primary', 'Outro')];
  assert.deepEqual(selectedQuotas('codex', 'gpt-6.1-terra', windows).windows.map(w => w.id), ['codex:primary', 'gpt-6.1-terra:primary', 'codex:secondary']);
  assert.equal(selectedQuotas('codex', 'gpt-6.1-sol', windows).windows.length, 2);
});
test('Claude mostra quota geral e apenas o limite adicional da família selecionada', () => {
  const windows = ['seven_day', 'five_hour', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'].map(id => quota(id, 'Claude', id === 'five_hour' ? 300 : 10080));
  assert.deepEqual(selectedQuotas('claude', 'opus', windows).windows.map(w => w.id), ['five_hour', 'seven_day', 'seven_day_opus']);
  assert.deepEqual(selectedQuotas('claude', 'haiku', windows).windows.map(w => w.id), ['five_hour', 'seven_day']);
  assert.equal(selectedQuotas('claude', 'custom-alias', windows, { metadata: { resolvedModel: 'claude-sonnet-5-5' } }).windows.at(-1).id, 'seven_day_sonnet');
});
test('Antigravity distingue Flash, Argon e Claude/GPT na mesma conta', () => {
  const windows = [quota('gemini-weekly', 'Gemini Models'), quota('gemini-5h', 'Gemini Models', 300), quota('3p-weekly', 'Claude and GPT models'), quota('3p-5h', 'Claude and GPT models', 300), quota('gemini-argon-wtu-weekly', 'Gemini 4 Argon')];
  assert.deepEqual(selectedQuotas('antigravity', 'gemini-3.8-flash', windows).windows.map(w => w.id), ['gemini-5h', 'gemini-weekly']);
  assert.deepEqual(selectedQuotas('antigravity', 'gemini-4-argon', windows).windows.map(w => w.id), ['gemini-argon-wtu-weekly']);
  for (const model of ['claude-opus-5-5', 'gpt-oss-120b']) assert.deepEqual(selectedQuotas('antigravity', model, windows).windows.map(w => w.id), ['3p-5h', '3p-weekly']);
  const unknown = selectedQuotas('antigravity', 'future-family', windows); assert.equal(unknown.unmapped, true); assert.deepEqual(unknown.windows, []);
  assert.deepEqual(selectedQuotas('cursor', 'grok', windows).windows, []);
});
test('reposição relativa não inventa datas e distingue limite ainda por repor', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(resetLabel(null, now), 'Reposição não comunicada');
  assert.equal(resetLabel('bad', now), 'Reposição não comunicada');
  assert.equal(resetLabel('2026-10-28T11:00:00Z', now), 'Aguarda reposição');
  assert.equal(resetLabel('2026-10-28T12:00:10Z', now), 'Repõe em 1m');
  assert.equal(resetLabel('2026-10-28T14:15:00Z', now), 'Repõe em 2h 15m');
  assert.equal(resetLabel('2026-10-30T15:00:00Z', now), 'Repõe em 2d 3h');
});
