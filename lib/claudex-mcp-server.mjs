import { request } from 'node:http';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { claudexTools, CLAUDEX_REQUEST_BYTES } from './claudex-tools.mjs';
import { contextTools } from './context-mcp.mjs';
import { open, constants } from 'node:fs/promises';

// With `--route <dir>` this is agy's fixed hydraq server, started in every agy session: each call finds its task by the
// conversation agy names in _meta. Without it, it serves one task lease given in HYDRAQ_CLAUDEX_LEASE.
const routeAt = process.argv.indexOf('--route'), routes = routeAt >= 0 ? process.argv[routeAt + 1] : null;
function leaseFile(meta) {
  if (!routes) return process.env.HYDRAQ_CLAUDEX_LEASE;
  const id = meta?.['antigravity.google/root_conversation_id'];
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(id)) throw Error('Esta conversa não está numa tarefa Hydra.');
  return path.join(routes, id + '.json');
}
async function lease(meta) {
  const file = leaseFile(meta);
  if (!file) throw Error('Sem sessão de ClaudeX.');
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { if (routes && e.code === 'ENOENT') throw Error('Esta conversa não está numa tarefa Hydra; estas ferramentas só respondem durante uma ronda Hydra.'); throw e; }
  let value;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 30000 || (stat.mode & 0o077)) throw Error('Credencial de ClaudeX inválida.');
    value = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
  const url = new URL(value.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/api/claudex/tools' || url.username || url.password || !/^[a-f0-9]{64}$/.test(value.token) || !Array.isArray(value.tools)) throw Error('Destino de ClaudeX inválido.');
  if(value.socketPath!==undefined&&(typeof value.socketPath!=='string'||!/^\/tmp\/hydraq-cx-[A-Za-z0-9]+\/mcp\.sock$/.test(value.socketPath)))throw Error('Socket de ClaudeX inválido.');
  return value;
}
const write = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let inFlight = 0;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  let q;
  try { if (Buffer.byteLength(line,'utf8') > CLAUDEX_REQUEST_BYTES) throw Error(); q = JSON.parse(line); }
  catch { write({ id: null, error: { code: -32700, message: 'Pedido MCP inválido.' } }); return; }
  if (q.id === undefined) return;
  try {
    let result;
    if (q.method === 'initialize') { if (!routes) await lease(); result = { protocolVersion: q.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hydraq-claudex', version: '1.0.0' } }; }
    else if (q.method === 'tools/list') result = { tools: routes ? [...claudexTools, ...contextTools] : (await lease()).tools };
    else if (q.method === 'ping') result = {};
    else if (q.method === 'tools/call') {
      if (inFlight >= 4) throw Error('Demasiados pedidos de ClaudeX.');
      inFlight++;
      try {
        const { url, token, socketPath } = await lease(q.params?._meta);
        const options = { method: 'POST', headers: { 'content-type': 'application/json', 'x-hydraq-claudex-token': token }, body: JSON.stringify({ name: q.params?.name, args: q.params?.arguments || {} }), signal: AbortSignal.timeout(15000) };
        const response = socketPath ? await new Promise((resolve,reject)=>{const req=request({socketPath,path:'/api/claudex/tools',method:options.method,headers:options.headers,signal:options.signal},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>resolve({ok:res.statusCode>=200&&res.statusCode<300,json:async()=>JSON.parse(Buffer.concat(chunks).toString('utf8'))}));});req.on('error',reject);req.end(options.body);}) : await fetch(url,options);
        const data = await response.json(), { image, ...text } = data;
        result = { content: [{ type: 'text', text: JSON.stringify(text) }, ...(image ? [{ type: 'image', mimeType: image.mimeType, data: image.data }] : [])], isError: !response.ok };
      } finally { inFlight--; }
    } else { write({ id: q.id, error: { code: -32601, message: 'Método MCP desconhecido.' } }); return; }
    write({ id: q.id, result });
  } catch (e) {
    write({ id: q.id, ...(q.method === 'tools/call' ? { result: { content: [{ type: 'text', text: e.message }], isError: true } } : { error: { code: -32602, message: e.message } }) });
  }
});
