import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { unlink, chmod } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';

// Fail closed: only globally routed unicast destinations are eligible for egress.
export function isPublicAddress(address) {
  const normalize = value => net.isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname : value;
  if (Object.values(networkInterfaces()).flat().some(entry => entry && normalize(entry.address) === normalize(address))) return false;
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) || (a === 192 && b === 88 && c === 99));
  }
  if (family !== 6 || address.includes('.')) return false;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const first = parseInt(canonical.split(':')[0], 16);
  return first >= 0x2000 && first <= 0x3fff &&
    !canonical.startsWith('2001:db8:') &&
    !(first === 0x2001 && (parseInt(canonical.split(':')[1] || '0', 16) < 0x200)) &&
    !canonical.startsWith('2002:');
}

export async function resolvePublicDestination(hostname, lookup = dnsLookup) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const answers = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] :
    await boundedLookup(host, lookup);
  if (!answers.length || answers.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Destination is not public');
  }
  return answers[0];
}

async function boundedLookup(host, lookup) {
  let timer;
  try {
    return await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 10_000); timer.unref(); }),
    ]);
  } finally { clearTimeout(timer); }
}

function cleanHeaders(headers) {
  const result = { ...headers };
  const connectionTokens = String(result.connection || '').split(',').map(s => s.trim().toLowerCase());
  for (const name of [...connectionTokens, 'connection', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'keep-alive', 'upgrade', 'te', 'trailer']) delete result[name];
  return result;
}

export async function startEgressProxy(socketPath, { lookup = dnsLookup, connect = net.connect } = {}) {
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.setTimeout(120_000, () => socket.destroy()); return socket; };
  const server = http.createServer({ maxHeaderSize: 32 * 1024, headersTimeout: 30_000, requestTimeout: 120_000 }, async (req, res) => {
    try {
      const url = new URL(req.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['80', '443', ''].includes(url.port)) throw new Error('Invalid destination');
      const destination = await resolvePublicDestination(url.hostname, lookup);
      if (req.destroyed) return;
      const headers = cleanHeaders(req.headers);
      headers.host = url.host;
      const upstream = (url.protocol === 'https:' ? https : http).request({
        hostname: destination.address, family: destination.family,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        servername: net.isIP(url.hostname) ? undefined : url.hostname,
        method: req.method, path: url.pathname + url.search, headers,
        agent: false, timeout: 120_000,
      }, incoming => { res.writeHead(incoming.statusCode, cleanHeaders(incoming.headers)); incoming.pipe(res); incoming.on('error', () => res.destroy()); });
      upstream.on('socket', track);
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    } catch { res.writeHead(403); res.end('Egress destination denied'); }
  });
  server.maxConnections = 128;
  server.maxRequestsPerSocket = 100;
  server.on('connection', track);
  server.on('connect', async (req, client, head) => {
    try {
      const url = new URL(`http://${req.url}`);
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['443', '80'].includes(url.port || '80')) throw new Error('Invalid CONNECT');
      const destination = await resolvePublicDestination(url.hostname, lookup);
      if (client.destroyed) return;
      const upstream = track(connect({ host: destination.address, family: destination.family, port: Number(url.port || 80) }));
      upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return { close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await unlink(socketPath).catch(() => {}); } };
}
