import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Providers } from '../lib/providers.mjs';
import { ProviderSettings } from '../lib/provider-settings.mjs';
import { Hydraq } from '../lib/hydraq.mjs';
import { CodexClient } from '../lib/codex.mjs';
import { ClaudeCode } from '../lib/claude.mjs';
import { Antigravity } from '../lib/antigravity.mjs';
import { Cursor } from '../lib/cursor.mjs';
import { OpenCode } from '../lib/opencode.mjs';
import { OpenCodeRuntime } from '../lib/opencode-runtime.mjs';
import { createHttpServer } from '../lib/http.mjs';

const fixture = name => fileURLToPath(new URL('./fixtures/fake-' + name + '.mjs', import.meta.url));

async function waitFor(predicate) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('O cliente simulado não chegou ao estado esperado.');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

async function setup(t) {
  const root = await mkdtemp('/tmp/hydraq-provider-settings-');
  const dataDir = root + '/state';
  await mkdir(root + '/auth', { mode: 0o700 });
  const credentialFile = root + '/auth/cursor.env';
  await writeFile(credentialFile, 'CURSOR_API_KEY=TEST-CURSOR-SECRET\n', { mode: 0o600 });
  const make = () => {
    const common = { defaultCwd: root, executable: process.execPath };
    const clients = {
      codex: new Hydraq({ ...common, dataDir, modelMetadataPath: root + '/no-model-metadata', client: new CodexClient({ executable: process.execPath, args: [fixture('codex')] }) }),
      claude: new ClaudeCode({ ...common, dataDir: dataDir + '/claude', prefixArgs: [fixture('claude')] }),
      antigravity: new Antigravity({ ...common, dataDir: dataDir + '/antigravity', prefixArgs: [fixture('agy')], settingsFile: root + '/agy-settings.json' }),
      cursor: new Cursor({ ...common, dataDir: dataDir + '/cursor', prefixArgs: [fixture('cursor')], credentialFile }),
      opencode: new OpenCode({
        ...common, dataDir: dataDir + '/opencode',
        runtime: new OpenCodeRuntime({ directory: dataDir + '/opencode/native', executable: process.execPath, args: [fixture('opencode-native')], manifest: false, minimumSettleMs: 0, settleMs: 5000 }),
      }),
    };
    return new Providers({ dataDir, defaultCwd: root, clients, git: async () => [] });
  };
  const hub = make();
  let current = hub;
  let server;
  t.after(async () => {
    if (server?.listening) {
      server.closeStreams();
      await new Promise(resolve => server.close(resolve));
    }
    await current.close();
    await rm(root, { recursive: true, force: true });
  });
  await hub.load();
  return {
    root, dataDir, hub,
    restart: async () => {
      await current.close();
      current = make();
      await current.load();
      return current;
    },
    listen: async () => {
      server = createHttpServer({ hydraq: hub, publicDir: fileURLToPath(new URL('../public/', import.meta.url)) });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const origin = 'http://127.0.0.1:' + server.address().port;
      const { token } = await fetch(origin + '/api/bootstrap', { headers: { 'X-HYDRAQ-Bootstrap': '1' } }).then(r => r.json());
      return (route, body) => fetch(origin + route, {
        method: 'POST', headers: { 'x-hydraq-token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    },
  };
}

const toggle = (hub, provider, enabled) => hub.changeProviderSettings({ provider, enabled, revision: hub.providerSettings.data.revision });

test('os cinco clientes retomam a sessão depois de desligar e reativar, sem arrancar quando desativados', async t => {
  const { root, hub, restart } = await setup(t);
  const startup = await hub.connectAll();
  assert.deepEqual(startup.map(r => [r.provider, r.status]), Object.keys(hub.clients).map(id => [id, 'fulfilled']));
  const models = { codex: 'gpt-test', claude: 'haiku', antigravity: 'gemini-4-argon', cursor: 'grok-4.7', opencode: 'opencode/test-free' };
  const conversations = [];
  for (const [provider, model] of Object.entries(models)) {
    const created = await hub.create({ provider, model, cwd: root, effort: 'low' });
    const client = hub.clients[provider];
    const chat = client.conversation(created.id);
    await hub.send(chat.id, 'Primeiro pedido', provider + '-first');
    await waitFor(() => chat.status === 'completed');
    const nativeId = chat.threadId;
    assert.ok(nativeId);
    const off = await toggle(hub, provider, false);
    assert.equal(off.providers[provider].enabled, false);
    assert.equal(off.providers[provider].connection, 'disconnected');
    assert.ok(off.conversations.some(c => c.id === chat.id && c.threadId === nativeId));
    await assert.rejects(hub.connect(provider), { code: 'PROVIDER_DISABLED' });
    await assert.rejects(hub.send(chat.id, 'Não enviar', provider + '-blocked'), { code: 'PROVIDER_DISABLED' });
    if (provider === 'opencode') {
      assert.equal(client.runtime.children.size, 0);
      await assert.rejects(hub.refreshOpenCode({ cwd: root }), { code: 'PROVIDER_DISABLED' });
    }
    const on = await toggle(hub, provider, true);
    assert.equal(on.providers[provider].connection, 'connected');
    assert.equal(chat.turns.length, 1);
    await hub.send(chat.id, 'Segundo pedido', provider + '-next');
    await waitFor(() => chat.status === 'completed');
    assert.equal(chat.threadId, nativeId);
    assert.equal(chat.turns.length, 2);
    await toggle(hub, provider, false);
    conversations.push(chat.id);
  }

  const restored = await restart();
  assert.deepEqual(await restored.connectAll(), []);
  assert.deepEqual(restored.snapshot().conversations.map(c => c.id).sort(), conversations.sort());
  await assert.rejects(restored.create({ cwd: root }), /Ativa um cliente/);
  await toggle(restored, 'claude', true);
  assert.equal((await restored.create({ cwd: root, model: 'haiku' })).provider, 'claude');
});

test('HTTP recusa uma desativação durante o envio, rejeita uma revisão antiga e permite passagem rápida', async t => {
  const { root, hub, listen } = await setup(t);
  await hub.connect('codex');
  await hub.connect('claude');
  const post = await listen();
  const chat = await hub.create({ provider: 'codex', cwd: root, model: 'gpt-test' });
  const originalSend = hub.clients.codex.send.bind(hub.clients.codex);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  hub.clients.codex.send = async (...args) => { await gate; return originalSend(...args); };
  const send = hub.send(chat.id, 'Começar', 'request');
  try {
    const during = await post('/api/providers/settings', { revision: 0, provider: 'codex', enabled: false });
    assert.equal(during.status, 409);
  } finally { release(); await send; }
  await waitFor(() => !hub.providerBlocker('codex'));
  const off = await post('/api/providers/settings', { revision: 0, provider: 'codex', enabled: false });
  assert.equal(off.status, 200);
  assert.equal((await off.json()).providers.codex.enabled, false);
  const stale = await post('/api/providers/settings', { revision: 0, provider: 'codex', enabled: true });
  assert.equal(stale.status, 409);
  const connect = await post('/api/connect', { provider: 'codex' });
  assert.equal(connect.status, 409);
  assert.equal((await connect.json()).code, 'PROVIDER_DISABLED');
  const handoff = await hub.send(chat.id, 'Passar para Claude', 'handoff', { provider: 'claude', model: 'haiku', handoffMode: 'quick' });
  await waitFor(() => hub.clients.claude.conversation(handoff.conversationId).status === 'completed');

  hub.clients.codex.connect = async () => {
    hub.clients.codex.connectionError = 'Autenticação simulada indisponível';
    throw Error(hub.clients.codex.connectionError);
  };
  const failed = await toggle(hub, 'codex', true);
  assert.equal(failed.providers.codex.enabled, true);
  assert.equal(failed.providers.codex.connection, 'disconnected');
  assert.match(failed.providers.codex.connectionError, /Autenticação/);
});

test('Multi conserva os destinatários e recusa a ronda inteira se um estiver desativado', async t => {
  const { root, hub } = await setup(t);
  await Promise.all([hub.connect('codex'), hub.connect('claude')]);
  const chat = await hub.create({ provider: 'codex', cwd: root, model: 'gpt-test' });
  const { dual } = await hub.startDual(chat.id, { provider: 'claude', model: 'haiku', effort: 'low' });
  await toggle(hub, 'claude', false);
  await assert.rejects(hub.sendDual(dual.id, { text: 'Ronda', requestId: 'round', target: 'all', multiVersion: 2 }), { code: 'PROVIDER_DISABLED' });
  assert.equal(hub.dual.record(dual.id).rounds.length, 0);
  assert.equal(hub.dual.record(dual.id).members.b.provider, 'claude');
  assert.ok(hub.conversations().every(c => !c.turns.length));
});

test('preferências privadas e arquivo corrompido preservado sem ligar clientes', async t => {
  const root = await mkdtemp('/tmp/hydraq-provider-store-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProviderSettings(root, () => ['codex', 'claude']);
  await store.load();
  await store.save('claude', false);
  assert.equal((await stat(store.file)).mode & 0o777, 0o600);
  await writeFile(store.file, '{corrompido');
  const restored = new ProviderSettings(root, () => ['codex', 'claude']);
  await restored.load();
  assert.equal(restored.enabled('codex'), false);
  assert.equal(restored.enabled('claude'), false);
  assert.throws(() => restored.validate({ provider: 'codex', enabled: true, revision: 0 }), /preservado/);
  assert.equal(await readFile(store.file, 'utf8'), '{corrompido');
});
