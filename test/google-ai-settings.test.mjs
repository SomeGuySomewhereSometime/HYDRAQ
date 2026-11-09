import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { EventEmitter, once } from 'node:events';
import { GoogleAiSettings } from '../lib/google-ai-settings.mjs';
import { Companion } from '../lib/companion.mjs';
import { createHttpServer } from '../lib/http.mjs';

async function setup(t, env = {}) {
  const directory = await mkdtemp('/tmp/hydraq-google-ai-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new GoogleAiSettings(directory, env);
  await settings.load();
  return settings;
}

test('chave privada persiste, substitui o ambiente e pode ser removida sem expor o segredo', async t => {
  const settings = await setup(t, { GEMINI_API_KEY: 'environment-secret' });
  assert.equal(settings.status().source, 'environment');
  const result = await settings.save({ apiKey: '  stored-secret  ' });
  assert.deepEqual(result, { configured: true, saved: true, source: 'settings', error: null });
  assert.equal(settings.apiKey(), 'stored-secret');
  assert.equal((await stat(settings.file)).mode & 0o777, 0o600);
  const restarted = new GoogleAiSettings(settings.directory, settings.env);
  await restarted.load();
  assert.equal(restarted.apiKey(), 'stored-secret');
  await restarted.save({ apiKey: 'replacement-secret' });
  assert.equal(restarted.apiKey(), 'replacement-secret');
  await restarted.save({ remove: true });
  assert.equal(restarted.apiKey(), 'environment-secret');
  assert.equal(restarted.status().saved, false);
  assert.doesNotMatch(await readFile(settings.file, 'utf8'), /stored-secret|replacement-secret/);
  restarted.env = {};
  assert.equal(restarted.status().configured, false);
});

test('validação e fila preservam a chave perante pedidos inválidos', async t => {
  const settings = await setup(t);
  await settings.save({ apiKey: 'original-secret' });
  for (const body of [null, [], {}, { apiKey: 42 }, { apiKey: '' }, { apiKey: 'a b' }, { apiKey: 'a\nb' }, { apiKey: 'x'.repeat(513) }, { remove: false }, { remove: true, apiKey: 'x' }]) {
    await assert.rejects(settings.save(body), error => error.status === 400 && !error.message.includes('original-secret'));
    assert.equal(settings.apiKey(), 'original-secret');
  }
  await Promise.all([settings.save({ apiKey: 'first-secret' }), settings.save({ apiKey: 'last-secret' })]);
  assert.equal(settings.apiKey(), 'last-secret');
  assert.equal(JSON.parse(await readFile(settings.file, 'utf8')).apiKey, 'last-secret');
});

test('ficheiros inválidos e ligações simbólicas são preservados', async t => {
  const settings = await setup(t);
  await writeFile(settings.file, 'invalid-private-data');
  await settings.load();
  assert.ok(settings.status().error);
  await assert.rejects(settings.save({ apiKey: 'new-secret' }), { status: 409 });
  assert.equal(await readFile(settings.file, 'utf8'), 'invalid-private-data');
  await rm(settings.file);
  await writeFile(settings.directory + '/target', '{"version":1,"apiKey":"outside-secret"}');
  await symlink(settings.directory + '/target', settings.file);
  const linked = new GoogleAiSettings(settings.directory, {});
  await linked.load();
  assert.ok(linked.status().error);
  assert.equal(linked.apiKey(), '');
});

test('API autenticada guarda a chave da mascote sem a devolver no estado, e aceita remoção', async t => {
  const settings = await setup(t);
  const hub = new EventEmitter();
  hub.projects = { data: { projects: [] } };
  hub.companion = new Companion({ hub, directory: settings.directory + '/companion', env: {} });
  hub.snapshot = () => ({ googleAi: hub.companion.googleAiStatus() });
  await hub.companion.load();
  const server = createHttpServer({ hydraq: hub, publicDir: new URL('../public/', import.meta.url).pathname });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeStreams(); server.close(resolve); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const route = origin + '/api/settings/google-ai';
  assert.equal((await fetch(route)).status, 403);
  assert.equal((await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"apiKey":"unauthorized"}' })).status, 403);
  const bootstrap = await fetch(origin + '/api/bootstrap', { headers: { 'X-HYDRAQ-Bootstrap': '1' } }).then(r => r.json());
  const headers = { 'x-hydraq-token': bootstrap.token, 'Content-Type': 'application/json' };
  const crossOrigin = await fetch(route, { method: 'POST', headers: { ...headers, Origin: 'http://example.com' }, body: '{"apiKey":"unauthorized"}' });
  assert.equal(crossOrigin.status, 403);
  const response = await fetch(route, { method: 'POST', headers, body: '{"apiKey":"private-live-secret"}' });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /private-live-secret/);
  assert.equal(hub.companion.apiKey(), 'private-live-secret');
  assert.equal(hub.companion.available(), true);
  const state = await fetch(origin + '/api/state', { headers }).then(r => r.text());
  assert.doesNotMatch(state, /private-live-secret/);
  assert.equal((await fetch(route, { method: 'POST', headers, body: JSON.stringify({ apiKey: 'x'.repeat(2500) }) })).status, 413);
  const removed = await fetch(route, { method: 'POST', headers, body: '{"remove":true}' }).then(r => r.json());
  assert.equal(removed.configured, false);
  assert.equal(hub.companion.available(), false);
});
