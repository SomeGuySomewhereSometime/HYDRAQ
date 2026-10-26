import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isPublicAddress, resolvePublicDestination, startEgressProxy } from '../lib/antigravity-egress.mjs';

test('egress rejects private, special and mapped destinations', () => {
  for (const ip of ['127.0.0.1', '0.0.0.0', '10.2.3.4', '172.16.1.1', '192.168.1.1', '100.64.0.1', '169.254.169.254', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:7f00:1', '::ffff:127.0.0.1', '2002:7f00:1::', '2001::1', '2001:db8::1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  for (const entry of Object.values(os.networkInterfaces()).flat()) assert.equal(isPublicAddress(entry.address), false);
});

test('all DNS answers must be public, so mixed rebinding answers fail closed', async () => {
  await assert.rejects(resolvePublicDestination('mixed.test', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]));
  await assert.rejects(resolvePublicDestination('empty.test', async () => []));
  assert.deepEqual(await resolvePublicDestination('public.test', async () => [{ address: '8.8.8.8', family: 4 }]), { address: '8.8.8.8', family: 4 });
});

async function fixture(t, options) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hydraq-egress-'));
  const socketPath = path.join(dir, 'proxy.sock');
  const proxy = await startEgressProxy(socketPath, options);
  t.after(async () => { await proxy.close(); await rm(dir, { recursive: true, force: true }); });
  return socketPath;
}

function request(socketPath, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: url }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
}

test('Unix proxy rejects administrative API, alias, non-web ports and malformed requests', async t => {
  const socketPath = await fixture(t, { lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  for (const url of ['http://127.0.0.1:4318/api/bootstrap', 'http://host.test/api/bootstrap', 'http://8.8.8.8:4318/api/bootstrap', 'file:///etc/passwd', '/api/bootstrap', 'http://user:pass@8.8.8.8/']) assert.equal(await request(socketPath, url), 403, url);
});

test('CONNECT pins the validated address and carries bidirectional bytes', async t => {
  const echo = net.createServer(socket => socket.pipe(socket));
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => echo.close(resolve)));
  let target;
  const socketPath = await fixture(t, {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    connect: options => { target = options; return net.connect(echo.address().port, '127.0.0.1'); },
  });
  const response = await new Promise((resolve, reject) => {
    const client = net.connect(socketPath);
    let received = '';
    client.on('connect', () => client.write('CONNECT google.test:443 HTTP/1.1\r\nHost: google.test:443\r\n\r\nhello'));
    client.on('data', data => { received += data; if (received.endsWith('hello')) { client.destroy(); resolve(received); } });
    client.on('error', reject);
  });
  assert.match(response, /^HTTP\/1.1 200/);
  assert.deepEqual(target, { host: '8.8.8.8', family: 4, port: 443 });
});

test('CONNECT rejects local destinations and forbidden ports before opening a connection', async t => {
  let connections = 0;
  const socketPath = await fixture(t, { lookup: async () => [{ address: '10.0.0.1', family: 4 }], connect: () => { connections++; throw new Error('Unexpected connection'); } });
  for (const target of ['127.0.0.1:443', 'host.test:443', '8.8.8.8:4318', '[::1]:443', 'user:pass@8.8.8.8:443', '8.8.8.8:443/path']) {
    const response = await new Promise((resolve, reject) => {
      const client = net.connect(socketPath); let received = '';
      client.on('connect', () => client.write(`CONNECT ${target} HTTP/1.1\r\nHost: test\r\n\r\n`));
      client.on('data', data => { received += data; });
      client.on('end', () => resolve(received)); client.on('error', reject);
    });
    assert.match(response, /^HTTP\/1.1 403/, target);
  }
  assert.equal(connections, 0);
});

test('isolated bridge overrides inherited proxy bypass settings and preserves child status', async () => {
  const { spawn } = await import('node:child_process');
  const bridge = new URL('../lib/antigravity-net-bridge.mjs', import.meta.url).pathname;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge, process.execPath, '-e', 'console.log(JSON.stringify({http:process.env.HTTP_PROXY,https:process.env.https_proxy,no:process.env.NO_PROXY,lowerNo:process.env.no_proxy}));process.exitCode=7'], { env: { ...process.env, NO_PROXY: '*', no_proxy: 'localhost', HTTP_PROXY: 'http://host:4318' } });
    let output = ''; let errors = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject); child.on('exit', code => resolve({ code, output, errors }));
  });
  assert.equal(result.code, 7, result.errors);
  const env = JSON.parse(result.output);
  assert.match(env.http, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(env.https, env.http); assert.equal(env.no, ''); assert.equal(env.lowerNo, '');
});
