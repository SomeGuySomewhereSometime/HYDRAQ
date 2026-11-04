import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,open,symlink,link,rm} from 'node:fs/promises';
import {implementationPlan,stageManifest,sealStage} from '../lib/hydra-stages.mjs';
import {canWrite,newWorkflow} from '../lib/hydra-workflow.mjs';
import visualWorker from '../lib/hydra-visual-worker.cjs';
import {externalConsent,publicCatalog,ExternalMcp} from '../lib/hydra-external-mcp.mjs';
import {Hydraq} from '../lib/hydraq.mjs';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {externalToolResult} from '../lib/claudex-tools.mjs';
import {createWorkspace} from '../lib/hydra-workspace.mjs';

const catalog=[{id:'claude:blender',name:'blender',source:'claude',signature:'same',config:{command:'not-executed',env:{PRIVATE:'secret'}}}];
test('a passagem externa entrega resultados estruturados e imagens, incluindo erros, sem os omitir',()=>{
 const image={type:'image',mimeType:'image/png',data:'example'},r=externalToolResult({call:{id:'one'},mcpResult:{structuredContent:{value:'café'},content:[image],isError:true}});assert.deepEqual(JSON.parse(r.content[0].text),{call:{id:'one'},outsideSandbox:true,structuredContent:{value:'café'}});assert.deepEqual(r.content[1],image);assert.equal(r.isError,true);const only=externalToolResult({call:{id:'two'},mcpResult:{structuredContent:{value:2}}});assert.equal(JSON.parse(only.content[0].text).structuredContent.value,2);
});
async function external(t,{scope='all',phase='implementing'}={}){
 const root=await mkdtemp('/tmp/hydra-external-unit-');t.after(()=>rm(root,{recursive:true,force:true}));
 const r={id:'task',cwd:root,status:'discussing',workflow:{authorized:true,approvedPlan:{},phase},externalMcp:externalConsent({enabled:true,servers:['claude:blender'],scope,confirmRisk:true},catalog,['codex','claude'],'codex')};
 const cx={hub:{},queue:Promise.resolve(),active:r=>r.status==='discussing',outputDirectory:()=>root,serial:async f=>f(),persist:async()=>{},kick:()=>{}};
 const gateway=new ExternalMcp(cx);gateway.catalogProvider=async()=>catalog;const calls=[];
 gateway.connections.set('task:claude:blender',{closed:false,rpc:async(method,args)=>{calls.push({method,args});return {content:[{type:'text',text:'result'}]};},close(){this.closed=true;}});
 t.after(()=>gateway.close());return {r,cx,gateway,calls,root};
}
const args=(messageId='one')=>({messageId,server:'claude:blender',tool:'execute_blender_code',arguments:{code:'example'}});
async function settled(gateway){await Promise.allSettled([...gateway.jobs.values()].map(j=>j.job));}

test('a distribuição só admite executores autorizados e congela instruções em etapas próprias',()=>{
 const r={author:'codex',writers:['codex','claude']},input={steps:[{role:'claude',instructions:'interface'},{role:'codex',instructions:'lógica'}],fixer:'codex'},plan=implementationPlan(r,input);
 assert.deepEqual(plan.steps.map(s=>s.role),['claude','codex']);assert.notEqual(plan.steps[0].id,plan.steps[1].id);input.steps[0].instructions='alterado';assert.equal(plan.steps[0].instructions,'interface');
 for(const invalid of [{...input,fixer:'antigravity'},{...input,steps:[{role:'antigravity',instructions:'ampliar'}]},{...input,steps:[]}])assert.throws(()=>implementationPlan(r,invalid),/autorizad|Distribuição/);
 assert.equal(implementationPlan({author:'antigravity',writers:['claude']}).fixer,'claude');
});
test('a escrita pertence ao executor da etapa, incluindo correções, nunca aos outros autorizados',()=>{
 const r={author:'codex',roles:['codex','claude','antigravity'],writers:['codex','claude'],workflow:{...newWorkflow(),authorized:true,phase:'implementing',writer:'claude'}};
 assert.equal(canWrite(r,'claude'),true);assert.equal(canWrite(r,'codex'),false);assert.equal(canWrite(r,'antigravity'),false);
 r.workflow.phase='fixing';assert.equal(canWrite(r,'claude'),true);r.workflow.replan={};assert.equal(canWrite(r,'claude'),false);delete r.workflow.replan;r.workflow.phase='validating';assert.equal(canWrite(r,'claude'),false);
});
test('manifesto de etapa cobre dependências, ignorados, hard links e o destino textual de symlinks',async t=>{
 const root=await mkdtemp('/tmp/hydra-stage-manifest-');t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(root+'/node_modules');await writeFile(root+'/node_modules/a.js','one');await writeFile(root+'/.gitignore','ignored');await writeFile(root+'/ignored','one');await link(root+'/ignored',root+'/hard');await symlink('ignored',root+'/alias');
 const first=await stageManifest(root);assert.ok(first.entries['node_modules/a.js']);assert.match(first.entries.alias,/link:ignored$/);assert.equal(first.entries.hard,first.entries.ignored);
 await writeFile(root+'/node_modules/a.js','two');assert.notEqual(first.hash,(await stageManifest(root)).hash);await writeFile(root+'/node_modules/a.js','one');assert.equal(first.hash,(await stageManifest(root)).hash);
 await writeFile(root+'/ignored','two');assert.notEqual(first.hash,(await stageManifest(root)).hash);
});
test('uma etapa materializada resiste a um descritor antigo e não partilha dependências ou links para a etapa anterior',async t=>{
 const root=await mkdtemp('/tmp/hydra-stage-attack-');t.after(()=>rm(root,{recursive:true,force:true}));const source=root+'/project';await mkdir(source);await mkdir(source+'/node_modules');await writeFile(source+'/value','one');await writeFile(source+'/node_modules/dep','old');await writeFile(source+'/path.txt',source+'/value');await symlink(source+'/value',source+'/alias');
 const workspace=await createWorkspace({project:source,folder:root+'/workspace'});await writeFile(workspace.copy+'/path.txt',workspace.copy+'/value');await writeFile(workspace.copy+'/sibling.txt',source+'-other/value');const fd=await open(workspace.copy+'/value','r+');t.after(()=>fd.close());const next=await sealStage(workspace);await fd.write('LATE',0,'utf8');await writeFile(workspace.copy+'/node_modules/dep','LATE');
 assert.equal(await readFile(next.copy+'/value','utf8'),'one');assert.equal(await readFile(next.copy+'/alias','utf8'),'one');assert.equal(await readFile(next.copy+'/node_modules/dep','utf8'),'old');assert.equal(await readFile(next.copy+'/path.txt','utf8'),next.copy+'/value');
 assert.equal(await readFile(next.copy+'/sibling.txt','utf8'),source+'-other/value');
});
test('guiões visuais validam ações e limites antes de lançar o browser',()=>{
 const valid=visualWorker.normalizeVisual({durationMs:1000,actions:[{type:'keyUp',key:'d',atMs:500},{type:'keyDown',key:'d',atMs:0}],checks:[{name:'moveu',expression:'samples.some(s=>s.state.x>0)'}]});assert.equal(valid.actions[0].type,'keyDown');assert.equal(valid.frameCount,8);
 for(const script of [{page:'../secret'},{page:'/etc/passwd'},{frameCount:33},{durationMs:10001},{actions:[{type:'script'}]},{actions:[{type:'keyDown',key:'d',atMs:2000}]},{checks:[{name:'empty',expression:''}]}])assert.throws(()=>visualWorker.normalizeVisual(script));
});
test('consentimento externo é explícito, limitado aos participantes e não revela credenciais',()=>{
 assert.equal(externalConsent(undefined,catalog,['codex','claude'],'codex'),null);assert.equal(externalConsent({enabled:false},catalog,['codex','claude'],'codex'),null);
 const body={enabled:true,servers:['claude:blender'],scope:'principal',confirmRisk:true};const consent=externalConsent(body,catalog,['codex','claude'],'codex');assert.deepEqual(consent.roles,['codex']);assert.ok(!JSON.stringify(consent).includes('secret'));assert.ok(!JSON.stringify(publicCatalog(catalog)).includes('secret'));
 for(const bad of [{...body,confirmRisk:false},{...body,servers:['unknown']},{...body,servers:['claude:blender','claude:blender']},{...body,scope:'model-choice'}])assert.throws(()=>externalConsent(bad,catalog,['codex','claude'],'codex'));
});
test('um participante sem autorização não lista nem executa ferramentas externas',async t=>{
 const {gateway,r,calls}=await external(t,{scope:'principal'});await assert.rejects(gateway.list(r,'claude','claude:blender'),/não autorizado/);assert.throws(()=>gateway.start(r,'claude',args()),/autorizada/);assert.equal(calls.length,0);assert.equal(r.externalCalls,undefined);
});
test('planeamento, conclusão e pedidos só de leitura não executam MCP externos',async t=>{
 const {gateway,r,calls}=await external(t);for(const phase of ['planning','finalizing']){r.workflow.phase=phase;assert.throws(()=>gateway.start(r,'codex',args()),/plano aprovado/);}r.workflow.phase='implementing';r.workflow.authorized=false;assert.throws(()=>gateway.start(r,'codex',args()));r.workflow.authorized=true;r.workflow.approvedPlan=null;assert.throws(()=>gateway.start(r,'codex',args()));assert.equal(calls.length,0);
});
test('chamadas externas são idempotentes, entregues só ao autor e exigem leitura antes de outra ação',async t=>{
 const {gateway,r,calls}=await external(t);const one=gateway.start(r,'codex',args());assert.equal(gateway.start(r,'codex',args()).id,one.id);assert.throws(()=>gateway.start(r,'codex',{...args(),tool:'changed'}),/reutilizado/);assert.throws(()=>gateway.start(r,'codex',args('two')),/anterior/);await settled(gateway);assert.equal(one.status,'completed');assert.equal(calls.length,1);await assert.rejects(gateway.status(r,'claude',one.id),/não encontrada/);
 assert.throws(()=>gateway.start(r,'codex',args('two')),/anterior/);const read=await gateway.status(r,'codex',one.id);assert.equal(read.mcpResult.content[0].text,'result');assert.ok(one.deliveredAt);gateway.start(r,'codex',args('two'));await settled(gateway);assert.equal(calls.length,2);
});
test('configuração alterada e servidores não escolhidos nunca recebem tools/call',async t=>{
 const {gateway,r,calls}=await external(t);assert.throws(()=>gateway.start(r,'codex',{...args(),server:'unknown'}),/não autorizado/);gateway.catalogProvider=async()=>[{...catalog[0],signature:'changed'}];const call=gateway.start(r,'codex',args());await settled(gateway);assert.equal(call.status,'failed');assert.equal(call.dispatched,undefined);assert.equal(calls.length,0);
});
test('uma pausa durante a abertura de uma ligação impede o envio da ação',async t=>{
 const {gateway,r,calls}=await external(t);let release,entered;const ready=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);const original=gateway.connection.bind(gateway);gateway.connection=async(...args)=>{const c=await original(...args);entered();await hold;return c;};const call=gateway.start(r,'codex',args());await ready;r.status='paused';gateway.cancel(r);release();await settled(gateway);assert.equal(call.status,'interrupted');assert.equal(call.dispatched,undefined);assert.equal(calls.length,0);
});
test('uma pausa após envio declara efeitos incertos, conserva o identificador e nunca repete a ação',async t=>{
 const {gateway,r}=await external(t);let release,entered;const ready=new Promise(resolve=>entered=resolve);gateway.connections.get('task:claude:blender').rpc=()=>{entered();return new Promise(resolve=>release=resolve);};const call=gateway.start(r,'codex',args());await ready;r.status='paused';gateway.cancel(r);release({content:[{type:'text',text:'late'}]});await settled(gateway);assert.equal(call.status,'uncertain');assert.equal(call.resultSaved,undefined);r.status='discussing';assert.equal(gateway.start(r,'codex',args()).id,call.id);assert.equal(gateway.jobs.size,0);
});
test('revisão entregue não autoriza novas ações externas',async t=>{
 const {gateway,r,calls}=await external(t,{phase:'validating'});r.workflow.reviews={codex:{decision:'approve'}};assert.throws(()=>gateway.start(r,'codex',args()),/já foi entregue/);assert.equal(calls.length,0);
});

test('aprovação nativa automática só abrange o servidor Hydra do turno com consentimento externo',()=>{
 const client=new EventEmitter(),responses=[],rejections=[];client.respond=(id,value)=>responses.push({id,value});client.reject=(id,value)=>rejections.push({id,value});const h=new Hydraq({dataDir:'/tmp/not-written',defaultCwd:'/tmp',client});h.changed=()=>{};
 const turn={id:'turn',internal:'claudex',hydraWrite:false,hydraExternalConsent:true,hydraMcpServer:'hydraq_task'};h.conversations=[{id:'conversation',threadId:'thread',turns:[turn],messages:[],status:'running'}];const params={threadId:'thread',turnId:'turn',serverName:'hydraq_task',_meta:{codex_approval_kind:'mcp_tool_call'}};
 client.emit('request',{id:1,method:'mcpServer/elicitation/request',params});assert.deepEqual(responses,[{id:1,value:{action:'accept',content:{}}}]);assert.equal(h.approvals.size,0);
 for(const altered of [{...params,serverName:'other'},{...params,turnId:'old'},{...params,_meta:{codex_approval_kind:'auth'}}])client.emit('request',{id:String(h.approvals.size+2),method:'mcpServer/elicitation/request',params:altered});assert.equal(h.approvals.size,3);assert.equal(responses.length,1);
 turn.hydraExternalConsent=false;client.emit('request',{id:5,method:'mcpServer/elicitation/request',params});assert.equal(h.approvals.size,4);client.emit('request',{id:6,method:'item/commandExecution/requestApproval',params});assert.equal(rejections.length,1);assert.equal(responses.length,1);
});

test('transporte stdio real conserva Unicode dividido entre blocos e a entrega MCP',async t=>{
 const {gateway,r}=await external(t);gateway.connections.clear();const script=`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;const result=q.method==='initialize'?{protocolVersion:'2024-11-05'}:q.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'café 🐍'}]};const bytes=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');const at=bytes.indexOf(Buffer.from('é'))+1;if(at>0){process.stdout.write(bytes.subarray(0,at));setTimeout(()=>process.stdout.write(bytes.subarray(at)),10)}else process.stdout.write(bytes);});`;
 gateway.catalogProvider=async()=>[{...catalog[0],config:{command:process.execPath,args:['-e',script]}}];const listed=await gateway.list(r,'codex','claude:blender');assert.equal(listed.tools[0].name,'echo');const call=gateway.start(r,'codex',{...args(),tool:'echo'});await settled(gateway);assert.equal(call.status,'completed',call.error);assert.equal((await gateway.status(r,'codex',call.id)).mcpResult.content[0].text,'café 🐍');
});
test('transporte HTTP real suporta sessão, cabeçalhos e eventos SSE com várias linhas',async t=>{
 const {gateway,r}=await external(t);gateway.connections.clear();const requests=[];const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const q=JSON.parse(body);requests.push({method:q.method,token:req.headers['x-test-token'],session:req.headers['mcp-session-id']});if(q.id===undefined){res.writeHead(204);res.end();return;}const result=q.method==='initialize'?{protocolVersion:'2024-11-05'}:q.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'HTTP café'}]};res.writeHead(200,{'Content-Type':'text/event-stream','mcp-session-id':'test-session'});const lines=JSON.stringify({jsonrpc:'2.0',id:q.id,result},null,2).split('\n');res.end(lines.map(line=>'data: '+line).join('\r\n')+'\r\n\r\n');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await gateway.close();await new Promise(resolve=>server.close(resolve));});
 gateway.catalogProvider=async()=>[{...catalog[0],config:{url:'http://127.0.0.1:'+server.address().port,headers:{'x-test-token':'test-only'}}}];await gateway.list(r,'codex','claude:blender');const call=gateway.start(r,'codex',args());await settled(gateway);assert.equal(call.status,'completed',call.error);assert.equal((await gateway.status(r,'codex',call.id)).mcpResult.content[0].text,'HTTP café');assert.ok(requests.every(q=>q.token==='test-only'));assert.ok(requests.filter(q=>q.method!=='initialize').every(q=>q.session==='test-session'));
});
