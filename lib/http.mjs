import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { MAX_IMAGE_BYTES } from './attachments.mjs';
import { CLAUDEX_REQUEST_BYTES } from './claudex-tools.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const files = new Set(['index.html', 'app.js', 'composer.js', 'elicitation.js', 'attachments.js', 'projects.js', 'drafts.js', 'project-memory.js', 'collaboration.js', 'work-locks.js', 'layout.js', 'model-picker.js', 'opinions.js', 'dual.js', 'claudex.js', 'native-sessions.js', 'claude-sessions.js', 'style.css', 'icon.svg']);

async function readBody(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('É necessário enviar JSON.'), { status: 415 });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 650_000) throw Object.assign(new Error('Pedido demasiado grande.'), { status: 413 });
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(body || '{}'); } catch { throw new Error('JSON inválido.'); }
}

async function readImage(request) {
  const chunks=[];let size=0;
  for await(const chunk of request){size+=chunk.length;if(size>MAX_IMAGE_BYTES)throw Object.assign(new Error('Cada imagem deve ter até 5 MB.'),{status:413});chunks.push(chunk);}
  return Buffer.concat(chunks);
}

export function createHttpServer({ hydraq, publicDir }) {
  const token = randomBytes(32).toString('hex');
  const clients = new Set();
  const json = (response, value, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  };
  const authenticated = supplied => {
    const buffer = Buffer.from(supplied || '');
    return buffer.length === token.length && timingSafeEqual(buffer, Buffer.from(token));
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const address = server.address();
    const allowedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
    if (!allowedHosts.has(request.headers.host)) return json(response, { error: 'Host não autorizado.' }, 403);
    if (request.headers.origin && ![...allowedHosts].some(host => request.headers.origin === `http://${host}`)) return json(response, { error: 'Origem não autorizada.' }, 403);
    const url = new URL(request.url, `http://${request.headers.host}`);
    try {
      if (request.method === 'GET' && url.pathname === '/health') return json(response, { app: 'HYDRAQ', version: '0.1.0', pid: process.pid });
      // The session key goes only to a request that asks for it with HYDRAQ's own header, as the page does. Tools that
      // just read an address (a model's URL fetcher, say) cannot add one, so they cannot act as the page.
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        if (request.headers['x-hydraq-bootstrap'] !== '1') return json(response, { error: 'Pedido de sessão sem o cabeçalho da HYDRAQ.' }, 403);
        await hydraq.refreshProjects?.(); return json(response, { token, state: hydraq.snapshot() });
      }
      if(request.method==='POST'&&url.pathname==='/api/context/query'){const body=await readBody(request);if(JSON.stringify(body).length>30000)throw Object.assign(new Error('Consulta demasiado grande.'),{status:413});return json(response,await hydraq.contextMcp.query(request.headers['x-hydraq-context-token'],body.name,body.args));}
      if(request.method==='POST'&&url.pathname==='/api/claudex/tools'){const body=await readBody(request);if(Buffer.byteLength(JSON.stringify(body),'utf8')>CLAUDEX_REQUEST_BYTES)throw Object.assign(Error('Mensagem ClaudeX demasiado grande.'),{status:413});return json(response,await hydraq.claudex.tool(request.headers['x-hydraq-claudex-token'],body.name,body.args));}
      if(request.method==='POST'&&url.pathname==='/api/collaboration/tools'){
        const body=await readBody(request);if(JSON.stringify(body).length>24000)throw Object.assign(new Error('Delegação demasiado grande.'),{status:413});
        return json(response,await hydraq.collaboration.tool(request.headers['x-hydraq-collaboration-token'],body.name,body.args));
      }
      if (url.pathname.startsWith('/api/')) {
        if (!authenticated(request.headers['x-hydraq-token'] || (url.pathname === '/api/events' && url.searchParams.get('token')))) return json(response, { error: 'Sessão local inválida. Atualiza a página.' }, 403);
        if(request.method==='GET'&&url.pathname==='/api/diagnostics')return json(response,hydraq.context.records.diagnostics());
        if (request.method === 'GET' && url.pathname === '/api/state') { await hydraq.refreshProjects?.(); return json(response, hydraq.snapshot()); }
        const opinionHistory=/^\/api\/conversations\/([^/]+)\/opinion-history$/.exec(url.pathname);
        if(request.method==='GET'&&opinionHistory)return json(response,await hydraq.opinions.page(opinionHistory[1],url.searchParams.get('cursor')||''));
        const claudex=/^\/api\/claudex\/([a-f0-9-]{36})(?:\/(update|stop|pause|resume))?$/.exec(url.pathname);
        if(request.method==='GET'&&claudex&&!claudex[2])return json(response,hydraq.claudex.detail(claudex[1]));
        const collaboration=/^\/api\/collaborations\/([a-f0-9-]{36})(?:\/(send|interrupt|acknowledge|respond))?$/.exec(url.pathname);
        if(request.method==='GET'&&collaboration&&!collaboration[2])return json(response,hydraq.collaboration.detail(collaboration[1]));
        const memoryRead=/^\/api\/projects\/([a-f0-9-]{36})\/memory$/.exec(url.pathname);
        if(request.method==='GET'&&memoryRead)return json(response,await hydraq.projectMemory(memoryRead[1]));
        const memoryHistory=/^\/api\/projects\/([a-f0-9-]{36})\/(memory-versions|memory-proposals)$/.exec(url.pathname);
        if(request.method==='GET'&&memoryHistory){const cursor=Number(url.searchParams.get('cursor')||0);return json(response,await (memoryHistory[2]==='memory-versions'?hydraq.projectMemoryVersions(memoryHistory[1],cursor):hydraq.projectMemoryProposals(memoryHistory[1],cursor)));}
        const imageRoute = /^\/api\/attachments\/([^/]+)\/([a-f0-9-]{36})$/.exec(url.pathname);
        if(request.method==='GET' && imageRoute){
          const image=await hydraq.attachments.get(decodeURIComponent(imageRoute[1]),imageRoute[2]);
          response.setHeader('Content-Type',image.mimeType);response.setHeader('Content-Length',image.bytes.length);return response.end(image.bytes);
        }
        if (request.method === 'GET' && url.pathname === '/api/events') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          response.write(`event: state\ndata: ${JSON.stringify(hydraq.snapshot())}\n\n`);
          clients.add(response);
          const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 20_000);
          heartbeat.unref();
          request.on('close', () => { clients.delete(response); clearInterval(heartbeat); });
          return;
        }
        if (request.method !== 'POST') return json(response, { error: 'Método não suportado.' }, 405);
        const upload = /^\/api\/conversations\/([^/]+)\/attachments$/.exec(url.pathname);
        if(upload)return json(response,await hydraq.uploadAttachment(upload[1],await readImage(request),url.searchParams.get('name'),request.headers['content-type']),201);
        const body = await readBody(request);
        if(url.pathname==='/api/claudex')return json(response,await hydraq.claudex.create(body),201);
        if(claudex&&claudex[2])return json(response,await hydraq.claudex[claudex[2]](claudex[1],claudex[2]==='pause'?{reason:body.reason}:body));
        if (url.pathname === '/api/native/list') return json(response, await hydraq.nativeSessions.list(body));
        if (url.pathname === '/api/native/import') return json(response, await hydraq.nativeSessions.import(body));
        const nativeRoute = /^\/api\/conversations\/([^/]+)\/native-(open|release)$/.exec(url.pathname);
        if (nativeRoute) return json(response, await (nativeRoute[2] === 'open' ? hydraq.nativeSessions.open(nativeRoute[1]) : hydraq.nativeSessions.release(nativeRoute[1])));
        if (url.pathname === '/api/claude/sessions') return json(response, await hydraq.claudeTerminal.list(body));
        if (url.pathname === '/api/claude/import') return json(response, await hydraq.claudeTerminal.import(body));
        const claudeRoute = /^\/api\/conversations\/([^/]+)\/claude-(open|release)$/.exec(url.pathname);
        if (claudeRoute) return json(response, await (claudeRoute[2] === 'open' ? hydraq.claudeTerminal.open(claudeRoute[1]) : hydraq.claudeTerminal.release(claudeRoute[1], body)));
        const openCodeRoute = /^\/api\/conversations\/([^/]+)\/opencode-(open|release|sync)$/.exec(url.pathname);
        if(openCodeRoute)return json(response,await (openCodeRoute[2]==='open'?hydraq.openCodeTerminal.open(openCodeRoute[1]):openCodeRoute[2]==='release'?hydraq.openCodeTerminal.release(openCodeRoute[1]):hydraq.clients.opencode.sync(hydraq.clients.opencode.conversation(openCodeRoute[1])).then(()=>({synced:true}))));
        const agyRoute=/^\/api\/conversations\/([^/]+)\/antigravity-(open|release)$/.exec(url.pathname);
        if(agyRoute)return json(response,await (agyRoute[2]==='open'?hydraq.antigravityTerminal.open(agyRoute[1],{confirm:body.confirm}):hydraq.antigravityTerminal.release(agyRoute[1],body)));
        const dualStart=/^\/api\/conversations\/([^/]+)\/dual$/.exec(url.pathname);
        if(dualStart)return json(response,await hydraq.startDual(dualStart[1],body));
        const dualRoute=/^\/api\/dual\/([a-f0-9-]{36})(?:\/(send|retry|replace|interrupt|end|synthesis|synthesis-settings))?$/.exec(url.pathname);
        if(dualRoute){const [,id,action]=dualRoute;return json(response,await (action==='send'?hydraq.sendDual(id,body):action==='retry'?hydraq.retryDual(id,body):action==='replace'?hydraq.replaceDualMember(id,body):action==='interrupt'?hydraq.interruptDual(id):action==='end'?hydraq.endDual(id):action==='synthesis'?hydraq.synthesizeDual(id,body):action==='synthesis-settings'?hydraq.setDualSynthesis(id,body):hydraq.updateDual(id,body)));}
        const nativeControl = /^\/api\/conversations\/([^/]+)\/(send|steer|context-refresh|opinions|opinion-incorporate|handoff-recovery)$/.exec(url.pathname);
        if (nativeControl) hydraq.nativeSessions?.assertControl(nativeControl[1]);
        const reviewPolicy=/^\/api\/conversations\/([^/]+)\/review-policy$/.exec(url.pathname);
        if(reviewPolicy)return json(response,await hydraq.automaticReviews.policy(reviewPolicy[1],body.config));
        const reviewCancel=/^\/api\/automatic-reviews\/([a-f0-9-]{36})\/cancel$/.exec(url.pathname);
        if(reviewCancel)return json(response,await hydraq.automaticReviews.cancel(reviewCancel[1]));
        const opinions=/^\/api\/conversations\/([^/]+)\/(opinions|opinion-incorporate)$/.exec(url.pathname);
        if(opinions)return json(response,await (opinions[2]==='opinions'?hydraq.opinions.create(opinions[1],body):hydraq.opinions.incorporate(opinions[1],body)));
        const opinionStop=/^\/api\/opinions\/([a-f0-9-]{36})\/(stop|respond)$/.exec(url.pathname);
        if(opinionStop)return json(response,await (opinionStop[2]==='stop'?hydraq.opinions.stop(opinionStop[1]):hydraq.opinions.respond(opinionStop[1],body.id,body)));
        if(url.pathname==='/api/collaboration/recover')return json(response,await hydraq.collaboration.recover());
        if(url.pathname==='/api/collaborations')return json(response,await hydraq.collaboration.create(body),201);
        if(collaboration&&collaboration[2]){
          const [_,id,action]=collaboration;
          return json(response,await (action==='send'?hydraq.collaboration.send(id,body):action==='interrupt'?hydraq.collaboration.interrupt(id):action==='acknowledge'?hydraq.collaboration.acknowledge(id):hydraq.collaboration.respond(id,body)));
        }
        const projectContext=/^\/api\/projects\/([a-f0-9-]{36})\/(memory|context-query|import-preview|memory-proposal|context-preview)$/.exec(url.pathname);
        if(projectContext){const [_,id,action]=projectContext;return json(response,await (action==='memory'?hydraq.saveProjectMemory(id,body):action==='context-query'?hydraq.projectConversations(id,body):action==='import-preview'?hydraq.previewImport(id,body):action==='context-preview'?hydraq.previewProjectContext(id,body):hydraq.proposeMemory(id,body)));}
        const refreshContext=/^\/api\/conversations\/([^/]+)\/context-refresh$/.exec(url.pathname);
        if(refreshContext)return json(response,await hydraq.refreshContext(refreshContext[1]));
        if (url.pathname === '/api/projects') return json(response, await hydraq.createProject(body), 201);
        if (url.pathname === '/api/groups/organize') return json(response, await hydraq.organizeGroups(body));
        const projectMatch = /^\/api\/projects\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (projectMatch) return json(response, await hydraq.updateProject(projectMatch[1], body));
        if (url.pathname === '/api/opencode/models') return json(response,await hydraq.refreshOpenCode(body));
        if (url.pathname === '/api/connect') return json(response, await hydraq.connect(body.provider));
        if (url.pathname === '/api/conversations') return json(response, await hydraq.create(body), 201);
        const match = /^\/api\/conversations\/([^/]+)\/(send|interrupt|steer|acknowledge-uncertainty|handoff-recovery)$/.exec(url.pathname);
        if (match) {
          if (match[2] === 'handoff-recovery') return json(response, await hydraq.reviewHandoff(match[1], body));
          if (match[2] === 'acknowledge-uncertainty') return json(response, await hydraq.acknowledgeUncertainty(match[1],body));
          if (match[2] === 'send') return json(response, await hydraq.send(match[1], body.text, body.requestId, { model: body.model, effort: body.effort, provider: body.provider, handoffMode: body.handoffMode, sandbox: body.sandbox, context: body.context, fast: body.fast, attachments:body.attachments,importId:body.importId,autoReview:body.autoReview }));
          if (match[2] === 'steer') {
            if(body.cancelId)return json(response,await hydraq.cancelFollowup(match[1],body.cancelId));
            if (['model', 'effort', 'cwd', 'sandbox', 'context', 'fast', 'attachments', 'importId'].some(key => key in body)) throw new Error('Uma orientação não pode mudar modelo, raciocínio, projeto ou acesso, nem anexar imagens durante o turno.');
            return json(response, await hydraq.steer(match[1], body.text, body.requestId, body.expectedTurnId, body.mode));
          }
          return json(response, await hydraq.interrupt(match[1]));
        }
        if (url.pathname === '/api/respond') return json(response, await hydraq.respond(body.id, body));
        return json(response, { error: 'Operação desconhecida.' }, 404);
      }
      if (request.method !== 'GET') return json(response, { error: 'Método não suportado.' }, 405);
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!files.has(file)) return json(response, { error: 'Página não encontrada.' }, 404);
      const contents = await readFile(file==='work-locks.js'?new URL('./work-locks.mjs',import.meta.url):path.join(publicDir, file));
      response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      response.end(contents);
    } catch (error) {
      if (!response.headersSent) json(response, { error: error.message, ...(['HANDOFF_CONTEXT_TOO_LARGE','WORK_RESERVED','REVIEW_UNAVAILABLE','CLAUDE_CONFIRM','TERMINAL_CONFIRM'].includes(error.code) ? { code: error.code,...(error.conflict?{conflict:error.conflict}:{}),...(error.confirm?{confirm:error.confirm}:{}),...(error.beforeSend?{beforeSend:true}:{}) } : {}) }, error.status || 400);
      else response.end();
    }
  });
  const update = state => {
    const event = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const response of clients) {
      if (response.writableLength > 2_000_000) { response.end(); clients.delete(response); }
      else response.write(event);
    }
  };
  server.on('listening',()=>{
    hydraq.contextMcp?.endpoint(`http://127.0.0.1:${server.address().port}/api/context/query`);
    if(hydraq.contextMcp?.restoreTerminals)hydraq.contextMcp.restoring=hydraq.contextMcp.restoreTerminals().catch(error=>{hydraq.contextMcpError=`Não foi possível recuperar a memória do terminal: ${error.message}`;hydraq.emit('state',hydraq.snapshot());});
  });
  server.on('listening',()=>hydraq.claudex?.endpoint(`http://127.0.0.1:${server.address().port}/api/claudex/tools`));
  server.on('listening',()=>hydraq.collaboration?.endpoint(`http://127.0.0.1:${server.address().port}/api/collaboration/tools`));
  hydraq.on('state', update);
  server.on('close', () => hydraq.off('state', update));
  server.closeStreams = () => { for (const response of clients) response.end(); clients.clear(); };
  return server;
}
