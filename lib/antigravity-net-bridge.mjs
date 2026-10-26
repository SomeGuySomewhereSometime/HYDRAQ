import net from 'node:net';
import { spawn } from 'node:child_process';

// This listener lives exclusively inside the isolated network namespace. The Unix
// transport reaches the host's validating proxy, never the host's TCP loopback.
const clients = new Set();
const server = net.createServer(client => {
  const upstream = net.connect('/run/hydraq/egress.sock');
  clients.add(client); clients.add(upstream);
  client.pipe(upstream); upstream.pipe(client);
  for (const socket of [client, upstream]) {
    socket.on('error', () => { client.destroy(); upstream.destroy(); });
    socket.on('close', () => { clients.delete(socket); client.destroy(); upstream.destroy(); });
  }
});
server.maxConnections = 128;
server.on('error', error => { console.error(`Egress bridge: ${error.message}`); process.exitCode = 1; });
server.listen(0, '127.0.0.1', () => {
  const proxy = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(process.argv[2], process.argv.slice(3), {
    stdio: 'inherit', env: { ...process.env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, ALL_PROXY: proxy, all_proxy: proxy, NO_PROXY: '', no_proxy: '' },
  });
  const stopTerm = () => child.kill('SIGTERM');
  const stopInt = () => child.kill('SIGINT');
  process.on('SIGTERM', stopTerm); process.on('SIGINT', stopInt);
  const finish = code => {
    process.removeListener('SIGTERM', stopTerm); process.removeListener('SIGINT', stopInt);
    for (const socket of clients) socket.destroy();
    server.close(); process.exitCode = code;
  };
  child.once('error', error => { console.error(`Isolated client: ${error.message}`); finish(1); });
  child.once('exit', (code, signal) => finish(code ?? (signal === 'SIGINT' ? 130 : 143)));
});
