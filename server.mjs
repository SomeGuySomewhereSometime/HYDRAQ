import './lib/env.mjs';
import { cursorCredentialVariables } from './lib/cursor-auth.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Providers } from './lib/providers.mjs';
import { createHttpServer } from './lib/http.mjs';

for (const key of cursorCredentialVariables) delete process.env[key];

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.HYDRAQ_PORT || 4318);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('HYDRAQ_PORT inválida.');
const hydraq = new Providers({ dataDir: path.resolve(process.env.HYDRAQ_DATA_DIR || path.join(root, '.hydraq')), defaultCwd: root });
await hydraq.load();
const server = createHttpServer({ hydraq, publicDir: path.join(root, 'public') });
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `A porta ${port} já está ocupada. Usa HYDRAQ_PORT para escolher outra.` : error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`HYDRAQ disponível em http://127.0.0.1:${server.address().port}`);
  hydraq.connectAll().then(results => results.forEach(result => {
    if (result.status === 'rejected') console.error(`${result.provider}: ${result.reason.message}`);
  }));
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.closeStreams();
  server.close();
  try { await hydraq.close(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
