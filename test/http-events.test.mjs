import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHttpServer } from '../lib/http.mjs';

test('terminar um stream lento limpa o heartbeat antes de voltar a escrever', async t => {
  const hub = Object.assign(new EventEmitter(), { snapshot: () => ({}) });
  const server = createHttpServer({ hydraq: hub, publicDir: process.cwd() + '/public' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const bootstrap = await (await fetch(base + '/api/bootstrap', { headers: { 'x-hydraq-bootstrap': '1' } })).json();
  const response = await fetch(base + '/api/events', { headers: { 'x-hydraq-token': bootstrap.token } });
  const reader = response.body.getReader();
  await reader.read();
  t.mock.timers.enable({ apis: ['setInterval'] });
  // The stream's first timer predates the mocked clock. Capture a second one.
  const second = await fetch(base + '/api/events', { headers: { 'x-hydraq-token': bootstrap.token } });
  const secondReader = second.body.getReader();
  await secondReader.read();
  // Consecutive writes fill the server buffer synchronously and trigger its backpressure limit.
  for (let i = 0; i < 3; i++) hub.emit('state', { text: 'x'.repeat(2_100_000) });
  t.mock.timers.tick(20_000);
  await new Promise(resolve => setImmediate(resolve));
  let bytes = 0;
  while (true) {
    const { value, done } = await secondReader.read();
    if (done) break;
    bytes += value.byteLength;
  }
  assert.ok(bytes > 2_000_000, 'a ligação terminou depois de exceder a memória de envio');
  await reader.cancel();
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.app, 'HYDRAQ');
});
