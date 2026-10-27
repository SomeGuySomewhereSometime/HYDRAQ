import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,mkdir,access} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {Providers} from '../lib/providers.mjs';
import {Antigravity} from '../lib/antigravity.mjs';
import {unseenTurns} from '../lib/handoff.mjs';
import {GUARD_HOOK} from '../lib/antigravity-guard.mjs';
import {OpinionClient} from './fixtures/opinion-client.mjs';
import {createHttpServer} from '../lib/http.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait=async f=>{const end=Date.now()+6000;while(!f()){if(Date.now()>end)throw Error('Timeout');await new Promise(r=>setTimeout(r,15));}};
const exists=file=>access(file).then(()=>true,()=>false);
async function setup(t){
 const dir=await mkdtemp('/tmp/hydraq-cx-inplace-');const clients=Object.fromEntries(['codex','claude','antigravity'].map(role=>{const c=new OpinionClient(role,dir+'/'+role,{behavior:'hold'});c.capabilities={steer:false};return [role,c];}));
 const hub=new Providers({dataDir:dir+'/hub',defaultCwd:dir,clients,git:async()=>[]});await hub.load();
 const server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeStreams();await new Promise(r=>server.close(r));await hub.close();await rm(dir,{recursive:true,force:true});});
 const cx=hub.claudex,token=(r,role)=>[...cx.leases].find(([,l])=>l.taskId===r.id&&l.role===role)?.[0],call=(r,role,name,args={})=>cx.tool(token(r,role),name,args);
 // A normal conversation with one finished request.
 const normal=async(provider,answer)=>{const chat=await hub.create({provider,cwd:dir,model:'test',effort:'low',sandbox:'workspace-write'});const c=clients[provider].conversation(chat.id);await hub.send(c.id,'Pedido normal '+provider,'n-'+randomUUID());await wait(()=>c.status==='running');clients[provider].finish(c,answer);return c;};
 const choices={codex:{model:'test',effort:'low'},claude:{model:'test',effort:'high'},antigravity:{model:'test',effort:'low'}};
 const begin=async(c,extra={})=>{const result=await cx.create({text:'Analisa em conjunto.',requestId:randomUUID(),conversationId:c.id,members:Object.fromEntries(extra.roles.map(role=>[role,choices[role]])),...extra});const r=cx.record(result.task.id);await wait(()=>r.roles.every(role=>r.members[role].turns&&cx.native(r,role).status==='running'));return r;};
 return {dir,hub,clients,cx,call,normal,begin};
}
// Both participants reach the same text and approve it, then end their turns.
async function agree(ctx,r){
 const {call}=ctx;for(const role of r.roles)await call(r,role,'initial_position',{text:'Posição '+role});
 for(const role of r.roles){const v=await call(r,role,'read_dialogue');await call(r,role,'ready_to_conclude',{revision:v.revision,reviewedThrough:v.reviewedThrough});}
 const v=await call(r,r.author,'read_dialogue'),proposed=await call(r,r.author,'propose_final',{text:'RESULTADO-COMUM',revision:v.revision,reviewedThrough:v.reviewedThrough});
 for(const role of r.roles){const view=await call(r,role,'read_dialogue');await call(r,role,'review_final',{candidateId:proposed.candidate.id,hash:proposed.candidate.hash,revision:view.revision,reviewedThrough:view.reviewedThrough,decision:'approve'});}
 for(const role of r.roles)ctx.clients[role].finish(ctx.cx.native(r,role),'Terminei.');
}

test('Hydra na conversa usa as sessões do Dual e devolve-as no fim, com as definições anteriores e uma nota',async t=>{
 const ctx=await setup(t),{hub,clients,cx}=ctx,codex=await ctx.normal('codex','RESPOSTA-NORMAL');
 const {dual}=await hub.startDual(codex.id,{provider:'claude',model:'test',effort:'low'});const claude=clients.claude.conversation(dual.members.b.conversationId);
 const before=hub.conversations().length,refreshes=[];clients.codex.refreshClaudeXTransport=async id=>{refreshes.push(id);};
 const r=await ctx.begin(codex,{roles:['codex','claude']});
 assert.deepEqual(refreshes,[codex.id],'a sessão já carregada do Codex recebe o servidor da tarefa numa ligação nova');
 assert.equal(r.inPlace,true);assert.equal(r.groupId,codex.id);assert.equal(r.members.codex.conversationId,codex.id);assert.equal(r.members.claude.conversationId,claude.id);
 assert.equal(hub.conversations().length,before,'nenhuma conversa nova');assert.equal(codex.claudexTask,r.id);assert.equal(claude.claudexTask,r.id);assert.equal(hub.dual.activeFor(codex.id).active,true);
 assert.deepEqual(r.members.codex.restore,{model:'test',effort:'low',sandbox:'workspace-write'});
 assert.equal(clients.codex.logs.at(-1).settings.inPlace,true);
 await assert.rejects(hub.send(codex.id,'Pedido direto','direct'),/ClaudeX/);
 codex.sandbox='read-only';claude.sandbox='plan';
 await agree(ctx,r);
 await wait(()=>r.status==='completed'&&r.released);
 for(const c of [codex,claude]){assert.equal(c.claudexTask,undefined);assert.equal(c.hydraReturn.taskId,r.id);}
 assert.equal(codex.sandbox,'workspace-write','acesso anterior reposto');assert.equal(cx.leases.size,0);
 assert.deepEqual(refreshes,[codex.id,codex.id],'ao devolver, o Codex larga o servidor da tarefa');
 const publication=codex.turns.find(turn=>turn.source==='claudex-publication');assert.equal(publication.finalAnswer,'RESULTADO-COMUM');
 assert.ok(!unseenTurns(claude,hub.hydraGroup(claude.id).members).some(entry=>entry.turn===publication),'o outro participante não volta a receber o texto que aprovou');
 await hub.sendDual(dual.id,{requestId:'after',text:'E agora?'});await wait(()=>codex.status==='running'&&claude.status==='running');
 for(const c of [codex,claude]){assert.match(clients[c.provider].logs.at(-1).text,/\[HYDRAQ\] A tarefa ClaudeX desta conversa terminou \(resposta comum publicada\)/);assert.equal(c.hydraReturn,undefined);}
 await assert.rejects(cx.resume(r.id,{}),/devolveu a conversa/);
});

test('um cliente que o grupo não tem entra com o histórico, e o agy recebe a rota do servidor fixo',async t=>{
 const ctx=await setup(t),{hub,clients,cx}=ctx,codex=await ctx.normal('codex','RESPOSTA-ANTERIOR');
 const r=await ctx.begin(codex,{roles:['codex','antigravity']});
 const agy=cx.native(r,'antigravity');assert.equal(agy.group,codex.id);assert.equal(r.members.antigravity.restore,undefined);
 const first=clients.antigravity.logs[0];assert.match(first.text,/RESPOSTA-ANTERIOR/,'o novo participante recebe a conversa anterior');assert.doesNotMatch(clients.codex.logs.at(-1).text,/RESPOSTA-ANTERIOR/,'o Codex já a tem na sessão');
 assert.equal(first.settings.contextMcp.name,'hydraq');assert.match(first.settings.contextMcp.route.token,/^[a-f0-9]{64}$/);assert.ok(first.settings.contextMcp.names.includes('read_dialogue'));
 assert.equal(first.settings.sandbox,'plan');
 clients.antigravity.finish(agy,'Primeira ronda.');
 await ctx.call(r,'codex','initial_position',{text:'Posição codex'});await ctx.call(r,'codex','send_to_peer',{messageId:'m1',type:'discovery',text:'Algo novo.'});
 await wait(()=>clients.antigravity.logs.length>1);
 assert.doesNotMatch(clients.antigravity.logs.at(-1).text,/RESPOSTA-ANTERIOR/,'contexto entregue uma vez');
 await cx.stop(r.id);await wait(()=>r.released);assert.equal(agy.claudexTask,undefined);assert.equal(codex.claudexTask,undefined);
});

test('parar devolve a conversa; com um pedido em curso o Hydra não começa',async t=>{
 const ctx=await setup(t),{hub,clients,cx}=ctx,codex=await ctx.normal('codex','Feito.');
 await hub.send(codex.id,'Outro pedido','busy');await wait(()=>codex.status==='running');
 await assert.rejects(ctx.begin(codex,{roles:['codex','claude']}),/Aguarda que o Codex termine/);
 clients.codex.finish(codex,'Pronto.');
 const r=await ctx.begin(codex,{roles:['codex','claude']}),claude=cx.native(r,'claude');
 assert.equal(claude.group,codex.id);
 await cx.stop(r.id);await wait(()=>r.released);
 assert.equal(r.status,'interrupted');assert.equal(codex.claudexTask,undefined);assert.equal(codex.hydraReturn.outcome,'interrupted');
 await hub.send(codex.id,'Continua normal','back');await wait(()=>codex.status==='running');
 assert.match(clients.codex.logs.at(-1).text,/terminou \(parada pelo utilizador\)/);
});

test('o servidor fixo do agy encontra a tarefa pela conversa e recusa fora dela',async t=>{
 const dir=await mkdtemp('/tmp/hydraq-route-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const token=randomBytes(32).toString('hex'),received=[];
 const api=createServer((req,res)=>{let body='';req.on('data',d=>body+=d).on('end',()=>{received.push({token:req.headers['x-hydraq-claudex-token'],body:JSON.parse(body)});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true}));});});
 await new Promise(r=>api.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>api.close(r)));
 await writeFile(path.join(dir,'conv-1234.json'),JSON.stringify({url:`http://127.0.0.1:${api.address().port}/api/claudex/tools`,token,tools:[]}),{mode:0o600});
 const child=spawn(process.execPath,[path.join(root,'lib/claudex-mcp-server.mjs'),'--route',dir],{stdio:['pipe','pipe','inherit']});t.after(()=>child.kill());
 const answers=new Map();createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);answers.set(m.id,m);});
 const rpc=async(id,method,params)=>{child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');await wait(()=>answers.has(id));return answers.get(id);};
 assert.ok((await rpc(1,'initialize',{})).result.serverInfo);
 assert.ok((await rpc(2,'tools/list',{})).result.tools.some(tool=>tool.name==='read_dialogue'));
 const ok=await rpc(3,'tools/call',{name:'read_dialogue',arguments:{},_meta:{'antigravity.google/root_conversation_id':'conv-1234'}});
 assert.equal(ok.result.isError,false);assert.equal(received[0].token,token);assert.equal(received[0].body.name,'read_dialogue');
 const outside=await rpc(4,'tools/call',{name:'read_dialogue',arguments:{},_meta:{'antigravity.google/root_conversation_id':'conv-9999'}});
 assert.equal(outside.result.isError,true);assert.match(outside.result.content[0].text,/não está numa tarefa Hydra/);
 const none=await rpc(5,'tools/call',{name:'read_dialogue',arguments:{}});assert.equal(none.result.isError,true);assert.equal(received.length,1);
});

test('ronda Hydra no agy: servidor registado, rota e regra só durante o pedido, MCP só da tarefa',async t=>{
 const dir=await mkdtemp('/tmp/hydraq-agy-route-');
 const config=path.join(dir,'agy-config'),hooksFile=path.join(config,'hooks.json'),mcpFile=path.join(config,'mcp_config.json'),guardDirectory=path.join(dir,'guard'),routeDirectory=path.join(dir,'route');
 await mkdir(config,{recursive:true});await writeFile(mcpFile,'');
 const client=new Antigravity({dataDir:path.join(dir,'state'),defaultCwd:dir,settingsFile:path.join(dir,'settings.json'),executable:process.execPath,prefixArgs:[path.join(root,'test/fixtures/fake-agy.mjs')],env:{...process.env,FAKE_AGY_HOOKS:hooksFile},hooksFile,guardDirectory,mcpFile,routeDirectory});
 t.after(async()=>{await client.close();await rm(dir,{recursive:true,force:true});});
 await client.load();await client.connect();
 const c=await client.create({cwd:dir,model:'gemini-4-argon',effort:'low',sandbox:'plan'});
 const lease={url:'http://127.0.0.1:1/api/claudex/tools',token:randomBytes(32).toString('hex'),tools:[]};
 const settings={internal:'claudex',sandbox:'plan',contextMcp:{name:'hydraq',names:['read_dialogue','send_to_peer'],route:lease}};
 await client.send(c.id,'guard-mcp-hold','h1',settings);await wait(()=>c.status==='running'&&c.threadId);
 assert.deepEqual(JSON.parse(await readFile(path.join(routeDirectory,c.threadId+'.json'),'utf8')),lease,'rota durante o pedido');
 const server=JSON.parse(await readFile(mcpFile,'utf8')).mcpServers[GUARD_HOOK];assert.deepEqual(server.args.slice(1),['--route',routeDirectory]);assert.match(server.args[0],/claudex-mcp-server\.mjs$/);
 assert.equal(c.claudexHome,undefined,'sem ambiente privado');
 await client.interrupt(c.id);await wait(()=>!client.session);
 assert.equal(await exists(path.join(routeDirectory,c.threadId+'.json')),false,'rota retirada no fim');
 await client.send(c.id,'guard-mcp','h2',settings);await wait(()=>c.turns.length===2&&c.status==='completed');
 assert.equal(c.messages.at(-1).text,'call_mcp_tool:ok call_mcp_tool:recusada call_mcp_tool:recusada write_file:recusada');
 await assert.rejects(client.send(c.id,'olá','h3',{...settings,sandbox:'workspace-write'}),/proteção só de leitura e do servidor MCP/);
});

test('tarefa Hydra numa conversa nova: agy normal pela rota; pausar a meio retira rota e regra, e retomar segue na mesma conversa com outra credencial',async t=>{
 const dir=await mkdtemp('/tmp/hydraq-cx-agy-new-');
 const config=path.join(dir,'agy-config'),hooksFile=path.join(config,'hooks.json'),mcpFile=path.join(config,'mcp_config.json'),guardDirectory=path.join(dir,'guard'),routeDirectory=path.join(dir,'route');
 await mkdir(config,{recursive:true});
 const agy=new Antigravity({dataDir:path.join(dir,'antigravity'),defaultCwd:dir,settingsFile:path.join(dir,'settings.json'),executable:process.execPath,prefixArgs:[path.join(root,'test/fixtures/fake-agy.mjs')],env:{...process.env,FAKE_AGY_HOOKS:hooksFile,FAKE_AGY_HOLD:'1'},hooksFile,guardDirectory,mcpFile,routeDirectory});
 const clients={codex:new OpinionClient('codex',dir+'/codex',{behavior:'hold'}),claude:new OpinionClient('claude',dir+'/claude',{behavior:'hold'}),antigravity:agy};clients.codex.capabilities=clients.claude.capabilities={steer:false};
 const hub=new Providers({dataDir:dir+'/hub',defaultCwd:dir,clients,git:async()=>[]});await hub.load();await agy.connect();
 const server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeStreams();await new Promise(r=>server.close(r));await hub.close();await rm(dir,{recursive:true,force:true});});
 const cx=hub.claudex,token=r=>[...cx.leases].find(([,l])=>l.taskId===r.id&&l.role==='antigravity')?.[0];
 const created=await cx.create({text:'Analisa em conjunto.',requestId:randomUUID(),cwd:dir,roles:['codex','antigravity'],members:{codex:{model:'test',effort:'low'},antigravity:{model:'gemini-4-argon',effort:'low'}}});
 const r=cx.record(created.task.id),c=cx.native(r,'antigravity');
 await wait(()=>c.status==='running'&&agy.session?.route);
 const routeFile=path.join(routeDirectory,c.threadId+'.json'),guardFile=path.join(guardDirectory,c.threadId+'.json'),thread=c.threadId,first=token(r);
 assert.equal(r.inPlace,undefined);assert.equal(c.claudexHome,undefined,'sem ambiente privado');
 assert.equal(agy.session.child.spawnfile,process.execPath,'o agy arranca diretamente, sem bwrap');
 const route=JSON.parse(await readFile(routeFile,'utf8'));assert.equal(route.url,cx.url);assert.equal(route.token,first,'rota com a credencial desta ronda');assert.ok(route.tools.some(tool=>tool.name==='send_to_peer'));
 const policy=JSON.parse(await readFile(guardFile,'utf8'));assert.ok(policy.mcp[GUARD_HOOK].includes('read_dialogue'));assert.deepEqual(Object.keys(policy.mcp),[GUARD_HOOK],'só as ferramentas da tarefa');
 assert.equal(JSON.parse(await readFile(mcpFile,'utf8')).mcpServers[GUARD_HOOK].args.at(-1),routeDirectory);
 await cx.tool(first,'initial_position',{text:'Posição do agy.'});assert.equal((await cx.tool(first,'read_dialogue',{})).self.role,'antigravity');
 // Pausing interrupts the running turn: route and rule go, the old credential stops answering and nothing is resent.
 await cx.pause(r.id);await wait(()=>r.status==='paused'&&!r.pause?.draining&&!r.pause?.interruptionPending&&!cx.pauseDrains.has(r.id)&&!cx.jobs.has(r.id)&&![...cx.dispatchOwners.values()].includes(r.id)&&!cx.preparing.get(r.id)?.size&&!r.pendingAnswers&&!agy.session);
 assert.equal(await exists(routeFile),false,'rota retirada');assert.equal(await exists(guardFile),false,'regra retirada');
 await assert.rejects(cx.tool(first,'read_dialogue',{}),/expirada/);assert.equal(c.turns.length,1,'nada foi reenviado');assert.equal(c.status,'interrupted');
 await cx.resume(r.id);await wait(()=>c.turns.length===2&&c.status==='running'&&agy.session?.route);
 assert.equal(c.threadId,thread,'mesma conversa do agy');assert.ok(agy.session.child.spawnargs.includes('--conversation'));
 const renewed=JSON.parse(await readFile(routeFile,'utf8'));assert.notEqual(renewed.token,first);assert.equal(renewed.token,token(r));
 assert.equal((await cx.tool(renewed.token,'read_dialogue',{})).self.role,'antigravity');
});

test('conversas do ambiente privado antigo do agy não continuam',async t=>{
 const dir=await mkdtemp('/tmp/hydraq-agy-old-');
 const client=new Antigravity({dataDir:path.join(dir,'state'),defaultCwd:dir,settingsFile:path.join(dir,'settings.json'),executable:process.execPath,prefixArgs:[path.join(root,'test/fixtures/fake-agy.mjs')]});
 t.after(async()=>{await client.close();await rm(dir,{recursive:true,force:true});});await client.load();await client.connect();
 const c=await client.create({cwd:dir,model:'gemini-4-argon',effort:'low',sandbox:'plan'});c.claudexHome=path.join(dir,'claudex',c.id,'home');c.threadId='old-private-1';
 for(const sandbox of ['plan','workspace-write'])await assert.rejects(client.send(c.id,'olá','old-'+sandbox,{sandbox}),/ambiente privado antigo do Hydra, que foi retirado/);
 assert.equal(c.turns.length,0);assert.ok(!client.session,'nenhum processo agy');
});
