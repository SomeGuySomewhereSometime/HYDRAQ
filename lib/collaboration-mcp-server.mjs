import { createInterface } from 'node:readline';
import { open, constants } from 'node:fs/promises';

async function lease() {
  const file = process.env.HYDRAQ_COLLABORATION_LEASE;
  if (!file) throw Error('Sem sessão de colaboração.');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 30000 || (stat.mode & 0o077)) throw Error('Credencial de colaboração inválida.');
    value = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
  const url = new URL(value.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/api/collaboration/tools' || url.username || url.password || !/^[a-f0-9]{64}$/.test(value.token) || !Array.isArray(value.tools)) throw Error('Destino de colaboração inválido.');
  return value;
}
const write = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let inFlight = 0;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  let q;
  try { if (line.length > 24000) throw Error(); q = JSON.parse(line); }
  catch { write({ id: null, error: { code: -32700, message: 'Pedido MCP inválido.' } }); return; }
  if (q.id === undefined) return;
  try {
    let result;
    if (q.method === 'initialize') { await lease(); result = { protocolVersion: q.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hydraq-collaboration', version: '1.0.0' } }; }
    else if (q.method === 'tools/list') result = { tools: (await lease()).tools };
    else if (q.method === 'ping') result = {};
    else if (q.method === 'tools/call') {
      if (inFlight >= 4) throw Error('Demasiados pedidos de colaboração.');
      inFlight++;
      try {
        const { url, token } = await lease();
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hydraq-collaboration-token': token }, body: JSON.stringify({ name: q.params?.name, args: q.params?.arguments || {} }), signal: AbortSignal.timeout(15000) });
        const data = await response.json(), { image, ...text } = data;
        result = { content: [{ type: 'text', text: JSON.stringify(text) }, ...(image ? [{ type: 'image', mimeType: image.mimeType, data: image.data }] : [])], isError: !response.ok };
      } finally { inFlight--; }
    } else { write({ id: q.id, error: { code: -32601, message: 'Método MCP desconhecido.' } }); return; }
    write({ id: q.id, result });
  } catch (e) {
    write({ id: q.id, ...(q.method === 'tools/call' ? { result: { content: [{ type: 'text', text: e.message }], isError: true } } : { error: { code: -32602, message: e.message } }) });
  }
});
