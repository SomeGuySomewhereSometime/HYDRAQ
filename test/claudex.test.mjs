import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {Providers} from '../lib/providers.mjs';
import {ClaudeX} from '../lib/claudex.mjs';
import {OpinionClient} from './fixtures/opinion-client.mjs';
import {createHttpServer} from '../lib/http.mjs';
const wait=async f=>{const end=Date.now()+6000;while(!f()){if(Date.now()>end)throw Error('Timeout');await new Promise(r=>setTimeout(r,15));}};
async function setup(t){
 const root=await mkdtemp('/tmp/hydraq-cx-test-');const clients=Object.fromEntries(['codex','claude','antigravity'].map(role=>{const c=new OpinionClient(role,root+'/'+role,{behavior:'hold'});c.capabilities={steer:role!=='antigravity'};c.notices=[];c.steer=async(...args)=>{c.notices.push(args);return {accepted:true};};return [role,c];}));
 const hub=new Providers({dataDir:root+'/hub',defaultCwd:root,clients,git:async()=>[]});await hub.load();
 const server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeStreams();await new Promise(r=>server.close(r));await hub.close();await rm(root,{recursive:true,force:true});});
 const cx=hub.claudex,body={workflow:1,text:'Compara soluções e planeia.',requestId:randomUUID(),cwd:root,members:{codex:{model:'test',effort:'low'},claude:{model:'test',effort:'high'}}};
 const start=async(extra={})=>{const result=await cx.create({...body,...extra});const r=cx.record(result.task.id);await wait(()=>(r.roles||['codex','claude']).every(role=>r.members[role].turns&&cx.native(r,role).status==='running'));return r;};
 const token=(r,role)=>[...cx.leases].find(([,l])=>l.taskId===r.id&&l.role===role)?.[0];
 const call=(r,role,name,args={})=>cx.tool(token(r,role),name,args);
 return {root,hub,clients,cx,body,start,call,token,url:'http://127.0.0.1:'+server.address().port};
}
const drained=async(ctx,r)=>{try{await wait(()=>!r.pause?.draining&&!ctx.cx.pauseDrains.has(r.id)&&!ctx.cx.jobs.has(r.id));}catch(e){e.message+=JSON.stringify({pause:r.pause,error:ctx.cx.error,jobs:[...ctx.cx.jobs],drains:[...ctx.cx.pauseDrains.keys()],dispatches:r.dispatches,status:r.status});throw e;}};
async function prepared(ctx,r){for(const role of r.roles||['codex','claude'])await ctx.call(r,role,'initial_position',{text:'Posição '+role});for(const role of r.roles||['codex','claude']){const v=await ctx.call(r,role,'read_dialogue');await ctx.call(r,role,'ready_to_conclude',v);}const v=await ctx.call(r,r.author,'read_dialogue');return (await ctx.call(r,r.author,'propose_final',{...v,text:'Plano exato comum.\n\n1. Verificar pressupostos.'})).candidate;}
async function approve(ctx,r,role,c){const v=await ctx.call(r,role,'read_dialogue');return ctx.call(r,role,'review_final',{candidateId:c.id,hash:c.hash,revision:v.revision,reviewedThrough:v.reviewedThrough,decision:'approve'});}
test('ClaudeX sem projeto inicia dois clientes normais em paralelo; caixa MCP independente, avisos durante o trabalho',async t=>{
 const ctx=await setup(t),{cx,start,clients,call,hub}=ctx,r=await start();
 assert.equal(r.projectId,null);assert.equal(r.groupId,cx.native(r,'claude').group);assert.equal(hub.dual.records.length,0);
 assert.equal(clients.codex.logs[0].settings.sandbox,'read-only');assert.equal(clients.claude.logs[0].settings.sandbox,'plan');assert.equal(clients.claude.logs[0].settings.planOnly,true);
 for(const role of ['codex','claude'])assert.ok(clients[role].logs[0].settings.contextMcp.names.includes('send_to_peer'));
 await call(r,'codex','initial_position',{text:'CODEX-INDEPENDENTE'});
 const before=await call(r,'claude','read_dialogue');assert.match(before.nextAction,/independente/);assert.equal(before.request[0].text,ctx.body.text);assert.doesNotMatch(JSON.stringify(before),/CODEX-INDEPENDENTE/);assert.equal(r.read.claude,undefined);assert.equal(before.reviewedThrough,undefined);
 await call(r,'codex','initial_position',{text:'CODEX-INDEPENDENTE'});await call(r,'claude','initial_position',{text:'CLAUDE-INDEPENDENTE'});
 await call(r,'codex','send_to_peer',{messageId:'msg1',type:'discovery',text:'Restrição: tem de funcionar offline.'});
 await wait(()=>clients.claude.notices.length>0);
 assert.equal(cx.native(r,'codex').status,'running');assert.equal(cx.native(r,'claude').status,'running');
 assert.ok(clients.claude.notices.at(-1).at(-1).kind==='peer-notice');
 const view=await call(r,'claude','read_dialogue');assert.match(view.messages.at(-1).text,/offline/);assert.equal(view.messages.at(-1).from,'codex');
 assert.doesNotMatch(clients.claude.logs[0].text,/CODEX-INDEPENDENTE/);
 await assert.rejects(hub.send(cx.native(r,'claude').id,'Escreve','external',{sandbox:'workspace-write'}),/ClaudeX/);
 assert.throws(()=>hub.assertTerminal(cx.native(r,'codex').id),/ClaudeX/);
});
test('aprovação dos dois publica uma só versão, apenas depois de ambos terminarem',async t=>{
 const ctx=await setup(t),r=await ctx.start(),c=await prepared(ctx,r);
 await approve(ctx,r,'codex',c);await approve(ctx,r,'claude',c);
 await new Promise(r=>setTimeout(r,70));assert.equal(r.result,undefined);
 for(const role of ['codex','claude'])ctx.clients[role].finish(ctx.cx.native(r,role),'Terminei.');
 await wait(()=>r.status==='completed');assert.equal(r.result.text,c.text);assert.equal(r.result.hash,c.hash);assert.equal(r.result.agreed,true);assert.deepEqual(Object.keys(r.result.approvals).sort(),['claude','codex']);
 assert.equal(ctx.cx.leases.size,0);assert.equal(ctx.clients.codex.logs.length,1);assert.equal(ctx.clients.claude.logs.length,1);
});
test('uma objeção tardia e um requisito novo invalidam o acordo mesmo com texto igual',async t=>{
 const ctx=await setup(t),r=await ctx.start(),c=await prepared(ctx,r);await approve(ctx,r,'codex',c);await approve(ctx,r,'claude',c);
 await ctx.call(r,'claude','send_to_peer',{messageId:'late',type:'objection',text:'A solução não funciona offline.'});assert.deepEqual(r.approvals,{});assert.equal(r.candidateId,null);assert.equal(r.candidates[0].text,c.text);
 await assert.rejects(approve(ctx,r,'codex',c),/desatualizada/);
 const before=r.revision;await ctx.cx.update(r.id,{requestId:'user-change',text:'Tem de funcionar sem rede.'});assert.equal(r.revision,before+1);
 const again=await ctx.cx.update(r.id,{requestId:'user-change',text:'Tem de funcionar sem rede.'});assert.equal(again.revision,r.revision);
});
test('perguntas simultâneas não bloqueiam o envio; identidades e IDs são verificados',async t=>{
 const ctx=await setup(t),r=await ctx.start();for(const role of ['codex','claude'])await ctx.call(r,role,'initial_position',{text:role});
 const qs=await Promise.all(['codex','claude'].map(role=>ctx.call(r,role,'send_to_peer',{messageId:'q-'+role,type:'question',text:'Qual o pressuposto?'})));
 const v=await ctx.call(r,'codex','read_dialogue');await assert.rejects(ctx.call(r,'codex','ready_to_conclude',v),/perguntas/);
 await ctx.call(r,'claude','send_to_peer',{messageId:'a',type:'answer',text:'Offline.',replyTo:qs[0].seq});
 await ctx.call(r,'codex','resolve_question',{seq:qs[1].seq,reason:'Adiada explicitamente para o utilizador.'});
 const count=r.messages.length;const duplicate=await ctx.call(r,'claude','send_to_peer',{messageId:'a',type:'answer',text:'Offline.',replyTo:qs[0].seq});assert.equal(duplicate.duplicate,true);assert.equal(r.messages.length,count);
 await assert.rejects(ctx.call(r,'claude','send_to_peer',{messageId:'a',type:'answer',text:'Outro texto',replyTo:qs[0].seq}),/reutilizado/);
 await assert.rejects(ctx.cx.tool('forged','read_dialogue'),/inválida/);
});
test('Parar revoga ferramentas, interrompe ambos e mensagens antigas nunca acordam a tarefa',async t=>{
 const ctx=await setup(t),r=await ctx.start(),old=ctx.token(r,'codex');await ctx.cx.stop(r.id);assert.equal(r.status,'interrupted');
 await assert.rejects(ctx.cx.tool(old,'initial_position',{text:'atrasada'}),/expirada/);ctx.cx.kick();await new Promise(r=>setTimeout(r,80));assert.equal(ctx.clients.codex.logs.length,1);assert.equal(ctx.clients.claude.logs.length,1);
 assert.equal(ctx.hub.workScopes().some(s=>s.kind==='claudex'),false);
});
test('reinício conserva estado incerto e não repete pedidos nativos',async t=>{
 const ctx=await setup(t),r=await ctx.start();const file=ctx.cx.directory+'/state.json';await readFile(file,'utf8');clearInterval(ctx.cx.timer);clearTimeout(ctx.cx.scheduled);ctx.cx.loaded=false;
 await rm(ctx.cx.directory+'/owner.json');ctx.cx.ownsLock=false;
 const second=new ClaudeX({hub:ctx.hub,directory:ctx.cx.directory,prepare:ctx.cx.prepare});await second.load();assert.equal(second.record(r.id).status,'paused');assert.equal(second.leases.size,0);assert.deepEqual(second.record(r.id).approvals,{});await new Promise(r=>setTimeout(r,80));assert.equal(ctx.clients.codex.logs.length,1);await second.close();
 // Original coordinator has deliberately lost ownership, so do not overwrite the recovered state on close.
 r.status='paused';ctx.cx.raw=await readFile(file,'utf8');
});
test('HTTP exige identidade da tarefa e não aceita chamadas da UI como mensagens do colega',async t=>{
 const ctx=await setup(t),r=await ctx.start();const bad=await fetch(ctx.url+'/api/claudex/tools',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'initial_position',args:{text:'forjada'}})});assert.equal(bad.status,403);
 const response=await fetch(ctx.url+'/api/claudex/tools',{method:'POST',headers:{'content-type':'application/json','x-hydraq-claudex-token':ctx.token(r,'claude')},body:JSON.stringify({name:'initial_position',args:{text:'Posição Claude',from:'codex'}})});assert.equal(response.status,200);assert.equal(r.messages.at(-1).from,'claude');
});
test('falta de prontidão por si só não repete turnos; nova mensagem acorda apenas uma vez',async t=>{
 const ctx=await setup(t),r=await ctx.start();
 for(const role of ['codex','claude'])await ctx.call(r,role,'initial_position',{text:role});
 await ctx.call(r,'codex','read_dialogue');ctx.clients.codex.finish(ctx.cx.native(r,'codex'),'Ainda a investigar.');
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(ctx.clients.codex.logs.length,1);assert.equal(r.status,'discussing');
 const message={messageId:'evidence-once',type:'discovery',text:'Uma descoberta útil e nova.'};await ctx.call(r,'claude','send_to_peer',message);
 await wait(()=>ctx.clients.codex.logs.length===2);assert.equal(ctx.cx.native(r,'claude').status,'running');
 await ctx.call(r,'codex','read_dialogue');ctx.clients.codex.finish(ctx.cx.native(r,'codex'),'Descoberta tratada.');
 const revision=r.evidenceRevision;await ctx.call(r,'claude','send_to_peer',message);ctx.cx.kick();
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(ctx.clients.codex.logs.length,2);assert.equal(r.evidenceRevision,revision);
});

test('a preparação dos dois acaba antes do primeiro envio e Parar impede envios tardios',async t=>{
 const ctx=await setup(t),original=ctx.cx.prepare;let release,started=false;ctx.cx.prepare=async(c,...args)=>{if(c.provider==='claude'){started=true;await new Promise(r=>release=r);}return original(c,...args);};
 const result=await ctx.cx.create(ctx.body),r=ctx.cx.record(result.task.id);await wait(()=>started);assert.equal(ctx.clients.codex.logs.length,0);assert.equal(ctx.clients.claude.logs.length,0);
 const paused=ctx.cx.pause(r.id);release();await paused;await new Promise(r=>setTimeout(r,100));assert.equal(ctx.clients.codex.logs.length,0);assert.equal(ctx.clients.claude.logs.length,0);assert.equal(r.status,'paused');
});
test('síntese opcional nunca recebe o selo de aprovação dos dois; resultado fica disponível para contexto',async t=>{
 const ctx=await setup(t),r=await ctx.start({consensus:false}),c=await prepared(ctx,r);
 for(const role of ['codex','claude'])ctx.clients[role].finish(ctx.cx.native(r,role),'Fim');await wait(()=>r.status==='completed');assert.equal(r.result.agreed,false);
 const transcript=ctx.cx.native(r,'codex');assert.equal(transcript.messages.filter(m=>m.source==='claudex-publication'&&m.role==='assistant').length,1);assert.equal(transcript.messages.at(-1).text,c.text);assert.equal(transcript.turns.at(-1).delivery,'local');
});
test('falha de um cliente nunca publica consenso nem repete automaticamente o envio',async t=>{
 const ctx=await setup(t);ctx.clients.claude.behavior='pre-fail';const {task}=await ctx.cx.create(ctx.body),r=ctx.cx.record(task.id);await wait(()=>r.status==='paused');await wait(()=>ctx.cx.native(r,'codex').status==='interrupted');assert.equal(r.result,undefined);assert.equal(ctx.clients.codex.logs.length,1);assert.equal(ctx.clients.claude.logs.length,0);
});
test('continuação explícita usa novas sessões e transporta contexto sem herdar aprovações',async t=>{
 const ctx=await setup(t),r=await ctx.start();await ctx.call(r,'codex','initial_position',{text:'Preservar este progresso.'});await ctx.cx.stop(r.id);await drained(ctx,r);
 const second=await ctx.start({requestId:randomUUID(),resumeFrom:r.id,text:'Retoma e conclui.'});assert.notEqual(r.members.codex.conversationId,second.members.codex.conversationId);assert.deepEqual(second.approvals,{});assert.match(second.messages.find(m=>m.type==='checkpoint').text,/Preservar este progresso/);
});

test('ClaudeX associado a projeto mantém memória de leitura e impede reorganização enquanto ativo',async t=>{
 const ctx=await setup(t);const project=await ctx.hub.createProject({name:'Projeto ClaudeX',root:ctx.root,revision:ctx.hub.projects.data.revision});
 const r=await ctx.start({projectId:project.id,projectRevision:ctx.hub.projects.data.revision});assert.equal(r.projectId,project.id);
 for(const role of ['codex','claude'])assert.ok(ctx.clients[role].logs[0].settings.contextMcp.names.includes('get_project_memory'));
 const memory=await ctx.call(r,'claude','get_project_memory');assert.ok(memory);
 await assert.rejects(ctx.hub.organizeGroups({groups:[r.groupId],archived:true,revision:ctx.hub.projects.data.revision}),/ClaudeX/);
});
test('resposta humana a uma pergunta nativa é partilhada e invalida aprovações',async t=>{
 const ctx=await setup(t),r=await ctx.start(),candidate=await prepared(ctx,r);await approve(ctx,r,'codex',candidate);await approve(ctx,r,'claude',candidate);
 const c=ctx.cx.native(r,'claude');ctx.clients.claude.approvals.set('question',{id:'question',method:'claude/askUserQuestion',conversationId:c.id,params:{questions:[{question:'Qual o formato?',header:'Formato',options:[{label:'JSON'}]}]}});
 await ctx.hub.respond('claude:question',{decision:'accept',answers:{Formato:'JSON'}});assert.equal(r.revision,1);assert.equal(r.messages.at(-1).type,'answer');assert.deepEqual(r.approvals,{});assert.equal(r.pendingAnswers,0);assert.match(r.messages.at(-1).text,/JSON/);assert.equal(r.result,undefined);
});


test('erro de gravação não impede interromper os dois clientes nem fechar os processos',async t=>{
 const ctx=await setup(t),r=await ctx.start();const closed=[];
 for(const role of ['codex','claude']){const original=ctx.clients[role].close.bind(ctx.clients[role]);ctx.clients[role].close=async()=>{closed.push(role);return original();};}
 ctx.cx.error='Falha de disco simulada';await assert.rejects(ctx.hub.close(),/guardar/);
 assert.equal(ctx.cx.native(r,'codex').status,'interrupted');assert.equal(ctx.cx.native(r,'claude').status,'interrupted');assert.equal(ctx.cx.leases.size,0);assert.deepEqual(closed.sort(),['claude','codex']);assert.equal(r.status,'uncertain');
});
test('continuação demasiado grande é recusada antes de criar sessões e conserva o progresso',async t=>{
 const ctx=await setup(t),r=await ctx.start();await ctx.cx.stop(r.id);r.messages.push({seq:99,from:'coordinator',type:'checkpoint',text:'x'.repeat(200001)});
 const count=ctx.clients.codex.snapshot().conversations.length;
 await assert.rejects(ctx.cx.create({...ctx.body,requestId:randomUUID(),resumeFrom:r.id}),/200 KB/);
 assert.equal(ctx.clients.codex.snapshot().conversations.length,count);assert.equal(r.messages.at(-1).text.length,200001);
});


test('Codex ClaudeX desativa MCP e apps herdados só na sua sessão',async t=>{
 const {Hydraq}=await import('../lib/hydraq.mjs');const root=await mkdtemp('/tmp/hydraq-cx-config-');t.after(()=>rm(root,{recursive:true,force:true}));
 const client=new Hydraq({dataDir:root,defaultCwd:root});client.connection='connected';client.account={type:'chatgpt'};client.persist=async()=>{};
 const conversation={id:'local',cwd:root,model:'test',sandbox:'read-only'};client.conversations=[conversation];const calls=[];
 client.client.call=async(method,params)=>{calls.push({method,params});return method==='config/read'?{config:{mcp_servers:{'external.with.dot':{command:'test',tool_timeout_sec:null}},apps:{external:{enabled:true}}}}:{thread:{id:'native'}};};
 const settings={internal:'claudex',contextMcp:{name:'hydraq_cx_test_codex',file:'/tmp/test-cx-lease',command:'node',args:[],env:{},names:['read_dialogue']}};
 await client.ensureThread('local',settings);const config=calls.find(c=>c.method==='thread/start').params.config;
 assert.equal(config.mcp_servers['external.with.dot'].enabled,false);assert.equal(config.apps.external.enabled,false);assert.equal('tool_timeout_sec' in config.mcp_servers['external.with.dot'],false);assert.equal(config['features.apps'],false);assert.equal(config['features.plugins'],false);assert.equal(config['features.hooks'],false);assert.equal(config['features.browser_use'],false);assert.ok(config.mcp_servers.hydraq_cx_test_codex.enabled_tools.includes('read_dialogue'));
 client.loaded.clear();calls.length=0;await client.ensureThread('local',{});assert.equal(calls.some(c=>c.method==='config/read'),false);assert.equal(calls[0].params.config['features.apps'],undefined);
});


test('documento de 100 mil caracteres atravessa MCP e HTTP sem cortes e mantém o acordo exato',{timeout:20000},async t=>{
 const ctx=await setup(t),r=await ctx.start();
 for(const role of ['codex','claude'])await ctx.call(r,role,'initial_position',{text:role});
 for(const role of ['codex','claude'])await ctx.call(r,role,'ready_to_conclude',await ctx.call(r,role,'read_dialogue'));
 const view=await ctx.call(r,'codex','read_dialogue');
 await assert.rejects(ctx.call(r,'codex','propose_final',{...view,text:'a'.repeat(100001)}),/Resposta final inválido/);
 // Worst-case JSON expansion plus non-ASCII: wire size is roughly 600 KB.
 const text='Á'+'\u0001'.repeat(99998)+'Z';
 const lease=ctx.cx.leases.get(ctx.token(r,'codex'));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../lib/claudex-mcp-server.mjs',import.meta.url))],{env:{...process.env,HYDRAQ_CLAUDEX_LEASE:lease.config.file},stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:child.stdout});t.after(()=>{lines.close();child.kill();});
 const reply=await new Promise((resolve,reject)=>{
  child.once('error',reject);child.stdin.once('error',reject);child.once('exit',code=>reject(Error('MCP terminou antes da resposta: '+code)));
  lines.once('line',line=>{try{resolve(JSON.parse(line));}catch(error){reject(error);}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'propose_final',arguments:{text,revision:view.revision,reviewedThrough:view.reviewedThrough}}})+'\n');
 });
 assert.equal(reply.error,undefined);assert.equal(reply.result.isError,false);
 const candidate=JSON.parse(reply.result.content[0].text).candidate;assert.equal(candidate.text,text);
 for(const role of ['codex','claude'])await approve(ctx,r,role,candidate);
 for(const role of ['codex','claude'])ctx.clients[role].finish(ctx.cx.native(r,role),'Fim');
 await wait(()=>r.status==='completed');await ctx.cx.queue;assert.equal(r.result.text,text);assert.equal(r.result.hash,candidate.hash);
 const persisted=JSON.parse(await readFile(ctx.cx.directory+'/state.json','utf8'));assert.equal(persisted.conversations[0].result.text,text);
 const oversized=await fetch(ctx.url+'/api/claudex/tools',{method:'POST',headers:{'content-type':'application/json','x-hydraq-claudex-token':'invalid'},body:JSON.stringify({name:'read_dialogue',args:{padding:'a'.repeat(640001)}})});assert.equal(oversized.status,413);
});

test('pausa e retoma conservam tarefa, posições, conversas e sessões nativas, mas revogam a credencial antiga',async t=>{
 const ctx=await setup(t),r=await ctx.start();await ctx.call(r,'codex','initial_position',{text:'Preservar a análise já feita.'});
 const ids=Object.fromEntries(['codex','claude'].map(role=>[role,[r.members[role].conversationId,ctx.cx.native(r,role).threadId]])),old=ctx.token(r,'codex');
 await ctx.cx.pause(r.id);await drained(ctx,r);assert.equal(r.status,'paused');assert.equal(ctx.cx.leases.size,0);assert.equal(ctx.hub.workScopes().some(s=>s.kind==='claudex'),false);
 await assert.rejects(ctx.cx.tool(old,'initial_position',{text:'atrasada'}),/expirada|inválida/);
 await ctx.cx.resume(r.id,{text:'Preservar o progresso e verificar a hipótese.',requestId:'resume-once'});
 await wait(()=>ctx.clients.codex.logs.length===2&&ctx.clients.claude.logs.length===2);
 assert.equal(ctx.cx.records.length,1);assert.equal(r.positions.codex,'Preservar a análise já feita.');assert.equal(r.revision,2);
 for(const role of ['codex','claude'])assert.deepEqual([r.members[role].conversationId,ctx.cx.native(r,role).threadId],ids[role]);
 const immutable=structuredClone({messages:r.messages,positions:r.positions,approvals:r.approvals,revision:r.revision,calls:r.calls});
 await assert.rejects(ctx.cx.tool(old,'send_to_peer',{messageId:'revoked-write',type:'discovery',text:'Não pode entrar no diálogo.'}),/expirada|inválida/);
 assert.deepEqual({messages:r.messages,positions:r.positions,approvals:r.approvals,revision:r.revision,calls:r.calls},immutable);assert.notEqual(ctx.token(r,'codex'),old);
 await ctx.cx.resume(r.id,{text:'Preservar o progresso e verificar a hipótese.',requestId:'resume-once'});
 assert.equal(r.revision,2);assert.equal(r.messages.filter(m=>m.messageId==='resume-once').length,1);
});

test('guards predefinidos são 30 turnos e 60 minutos; zero desativa; entradas inválidas não criam sessões',async t=>{
 const ctx=await setup(t),r=await ctx.start();assert.deepEqual(r.guards,{turns:30,minutes:60});await ctx.cx.pause(r.id);await drained(ctx,r);
 const count=ctx.clients.codex.conversations.length;
 for(const guards of [{turns:-1},{minutes:-1},{turns:1.5},{minutes:'60'}])await assert.rejects(ctx.cx.create({...ctx.body,requestId:randomUUID(),guards}),/inválid|inteiro|guard|limite/i);
 assert.equal(ctx.clients.codex.conversations.length,count);
 const zero=await ctx.start({requestId:randomUUID(),guards:{turns:0,minutes:0}});assert.deepEqual(zero.guards,{turns:0,minutes:0});
});

test('guard de turnos pausa sem falso resultado; retoma explícita abre novo orçamento nas mesmas sessões',async t=>{
 const ctx=await setup(t),r=await ctx.start({guards:{turns:1,minutes:0}});
 for(const role of ['codex','claude'])await ctx.call(r,role,'initial_position',{text:role});await ctx.call(r,'codex','read_dialogue');
 ctx.clients.codex.finish(ctx.cx.native(r,'codex'),'Trabalho parcial.');await ctx.call(r,'claude','send_to_peer',{messageId:'guard-wake',type:'discovery',text:'É preciso rever este ponto.'});
 await wait(()=>r.status==='paused');assert.equal(r.result,undefined);assert.equal(ctx.clients.codex.logs.length,1);assert.match(JSON.stringify(r.pause),/turn|limite/i);
 await drained(ctx,r);await ctx.cx.resume(r.id,{guards:{turns:2,minutes:0}});await wait(()=>ctx.clients.codex.logs.length===2);assert.equal(r.members.codex.turns,2);assert.equal(r.guards.turns,2);
});

test('pausa persistida sobrevive a reinício sem novos envios e conserva mensagens e sessões',async t=>{
 const ctx=await setup(t),r=await ctx.start();await ctx.call(r,'codex','initial_position',{text:'Estado durável antes da pausa.'});await ctx.cx.pause(r.id);await drained(ctx,r);
 const file=ctx.cx.directory+'/state.json';clearInterval(ctx.cx.timer);clearTimeout(ctx.cx.scheduled);ctx.cx.loaded=false;await rm(ctx.cx.directory+'/owner.json');ctx.cx.ownsLock=false;
 const second=new ClaudeX({hub:ctx.hub,directory:ctx.cx.directory,prepare:ctx.cx.prepare});await second.load();
 const saved=second.record(r.id);assert.equal(saved.status,'paused');assert.equal(saved.positions.codex,r.positions.codex);assert.deepEqual(saved.members,r.members);assert.equal(second.leases.size,0);
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(ctx.clients.codex.logs.length,1);assert.equal(ctx.clients.claude.logs.length,1);await second.close();ctx.cx.raw=await readFile(file,'utf8');
});

test('retoma verifica conflitos de recursos e mantém a tarefa pausada quando outra tarefa ocupa os clientes',async t=>{
 const ctx=await setup(t),first=await ctx.start();await ctx.cx.pause(first.id);await drained(ctx,first);const second=await ctx.start({requestId:randomUUID()});
 await assert.rejects(ctx.cx.resume(first.id),/reserv|curso|ocupad|ClaudeX/i);assert.equal(first.status,'paused');assert.equal(ctx.clients.codex.logs.length,2);
 await ctx.cx.pause(second.id);await drained(ctx,second);await ctx.cx.resume(first.id);await wait(()=>ctx.clients.codex.logs.length===3);assert.equal(ctx.cx.records.length,2);
});

test('pausa drena um envio já iniciado e uma retoma concorrente não o sobrepõe',async t=>{
 const ctx=await setup(t),send=ctx.clients.codex.send.bind(ctx.clients.codex);let release,entered=false;
 ctx.clients.codex.send=async(...args)=>{entered=true;await new Promise(resolve=>release=resolve);return send(...args);};
 const created=await ctx.cx.create(ctx.body),r=ctx.cx.record(created.task.id);await wait(()=>entered);t.after(()=>release?.());
 const paused=ctx.cx.pause(r.id);await wait(()=>r.status==='paused');const resumed=ctx.cx.resume(r.id).then(()=>null,error=>error);
 release();await paused;await drained(ctx,r);const error=await resumed;assert.ok(error);assert.equal(r.status,'paused');assert.equal(ctx.cx.native(r,'codex').status,'interrupted');assert.equal(ctx.cx.leases.size,0);
});

async function divergence(ctx,r){
 for(const role of ['codex','claude'])await ctx.call(r,role,'initial_position',{text:role==='codex'?'Prefiro SQLite para transações.':'Prefiro JSON pela portabilidade.'});
 await ctx.call(r,'claude','declare_impasse',{...await ctx.call(r,'claude','read_dialogue'),text:'As prioridades de transações e portabilidade continuam incompatíveis.'});
 for(const role of ['codex','claude'])await ctx.call(r,role,'ready_to_conclude',await ctx.call(r,role,'read_dialogue'));
 return (await ctx.call(r,'codex','propose_final',{...await ctx.call(r,'codex','read_dialogue'),outcome:'divergences',text:'Codex prefere SQLite por transações; Claude prefere JSON pela portabilidade. Há acordo sobre estes factos, sem escolha comum.'})).candidate;
}
test('impasse produz documento de divergências apenas com aprovação exata dos dois',async t=>{
 const ctx=await setup(t),r=await ctx.start(),c=await divergence(ctx,r);assert.equal(c.outcome,'divergences');
 await approve(ctx,r,'codex',c);assert.equal(r.result,undefined);await approve(ctx,r,'claude',c);
 for(const role of ['codex','claude'])ctx.clients[role].finish(ctx.cx.native(r,role),'Fim');await wait(()=>r.status==='completed');
 assert.equal(r.result.outcome,'divergences');assert.equal(r.result.text,c.text);assert.deepEqual(Object.keys(r.result.approvals).sort(),['claude','codex']);
});
test('recusa da descrição das divergências termina sem acordo e preserva as posições atribuídas',async t=>{
 const ctx=await setup(t),r=await ctx.start(),c=await divergence(ctx,r);await approve(ctx,r,'codex',c);
 await ctx.call(r,'claude','review_final',{...await ctx.call(r,'claude','read_dialogue'),candidateId:c.id,hash:c.hash,decision:'disagree',reason:'A descrição não representa a minha prioridade.'});
 await wait(()=>!ctx.cx.active(r));assert.equal(r.status,'no-agreement');assert.equal(Boolean(r.result?.agreed),false);assert.equal(r.positions.codex,'Prefiro SQLite para transações.');assert.equal(r.positions.claude,'Prefiro JSON pela portabilidade.');assert.ok(r.messages.some(m=>m.from==='claude'&&m.text.includes('não representa')));
});

test('HTTP oferece pausa e retoma da mesma tarefa com guardas revistos',async t=>{
 const ctx=await setup(t),r=await ctx.start();
 const {token}=await fetch(ctx.url+'/api/bootstrap',{headers:{'X-HYDRAQ-Bootstrap':'1'}}).then(response=>response.json());
 const post=async(action,body={})=>fetch(ctx.url+'/api/claudex/'+r.id+'/'+action,{method:'POST',headers:{'content-type':'application/json','x-hydraq-token':token},body:JSON.stringify(body)});
 assert.equal((await post('pause')).status,200);assert.equal(r.status,'paused');await drained(ctx,r);
 assert.equal((await post('resume',{guards:{turns:0,minutes:0},requestId:'http-resume',text:'Continuar com a mesma análise.'})).status,200);
 await wait(()=>ctx.clients.codex.logs.length===2);assert.deepEqual(r.guards,{turns:0,minutes:0});assert.equal(r.revision,2);
});

test('guard de tempo conta apenas atividade e pausa conserva rascunhos sem publicação',async t=>{
 const ctx=await setup(t),r=await ctx.start({guards:{turns:0,minutes:1}});r.activeSince=new Date(Date.now()-61000).toISOString();
 await assert.rejects(ctx.call(r,'codex','initial_position',{text:'Texto depois do prazo.'}),/tempo|minutos/i);
 await wait(()=>r.status==='paused'&&ctx.cx.native(r,'codex').status==='interrupted');assert.equal(r.result,undefined);
 const elapsed=ctx.cx.activeMs(r);await new Promise(resolve=>setTimeout(resolve,70));assert.equal(ctx.cx.activeMs(r),elapsed);
 await wait(()=>!r.pause?.draining&&!ctx.cx.jobs.has(r.id));await ctx.cx.resume(r.id,{guards:{turns:0,minutes:0}});await wait(()=>ctx.clients.codex.logs.length===2);assert.equal(r.activeMs,elapsed);
});

test('prontidão e aprovação repetidas não criam progresso nem anulam a versão',async t=>{
 const ctx=await setup(t),r=await ctx.start(),c=await prepared(ctx,r),version=r.protocolVersion;
 const view=await ctx.call(r,'codex','read_dialogue');const ready=await ctx.call(r,'codex','ready_to_conclude',view);assert.equal(ready.duplicate,true);assert.equal(r.protocolVersion,version);
 await approve(ctx,r,'codex',c);const afterApproval=r.protocolVersion,first=structuredClone(r.approvals.codex);await approve(ctx,r,'codex',c);assert.equal(r.protocolVersion,afterApproval);assert.deepEqual(r.approvals.codex,first);assert.equal(r.candidateId,c.id);
});

test('contadores antigos de mensagens, chamadas, atualizações e candidatas não terminam investigação útil',async t=>{
 const ctx=await setup(t),r=await ctx.start({guards:{turns:0,minutes:0}});
 for(const role of ['codex','claude'])await ctx.call(r,role,'initial_position',{text:role});
 for(let i=0;i<35;i++)await ctx.call(r,i%2?'claude':'codex','send_to_peer',{messageId:'useful-'+i,type:'discovery',text:'Evidência distinta número '+i});
 for(let i=0;i<9;i++)await ctx.cx.update(r.id,{requestId:'revision-'+i,text:'Requisito adicional número '+i});
 for(let i=0;i<165;i++)await ctx.call(r,'codex','read_dialogue');
 let candidate;
 for(let i=0;i<5;i++){
  for(const role of ['codex','claude'])await ctx.call(r,role,'ready_to_conclude',await ctx.call(r,role,'read_dialogue'));
  candidate=(await ctx.call(r,'codex','propose_final',{...await ctx.call(r,'codex','read_dialogue'),text:'Plano revisto '+i})).candidate;
  if(i<4)await ctx.call(r,'claude','review_final',{...await ctx.call(r,'claude','read_dialogue'),candidateId:candidate.id,hash:candidate.hash,decision:'changes',reason:'Falta justificar a prova número '+i});
 }
 assert.equal(r.candidates.length,5);assert.equal(r.revision,10);assert.ok(r.calls>160);assert.ok(ctx.cx.active(r));
 for(const role of ['codex','claude']){await approve(ctx,r,role,candidate);ctx.clients[role].finish(ctx.cx.native(r,role),'Fim');}await wait(()=>r.status==='completed');assert.equal(r.result.text,'Plano revisto 4');
});

test('pausar e terminar durante preparação pendente drena a geração atual e liberta reservas',async t=>{
 const ctx=await setup(t),prepare=ctx.cx.prepare;let release,entered=false;
 ctx.cx.prepare=async(...args)=>{entered=true;await new Promise(resolve=>release=resolve);return prepare(...args);};
 // Hold only one preparation; both native sends must remain blocked until this gate clears.
 let calls=0;ctx.cx.prepare=async(...args)=>{if(++calls===1){entered=true;await new Promise(resolve=>release=resolve);}return prepare(...args);};
 const created=await ctx.cx.create(ctx.body),r=ctx.cx.record(created.task.id);await wait(()=>entered);t.after(()=>release?.());
 await ctx.cx.pause(r.id);assert.equal(r.pause.draining,true);await ctx.cx.stop(r.id);assert.equal(r.status,'interrupted');release();
 await wait(()=>!r.pause.draining&&!ctx.cx.pauseDrains.has(r.id)&&!ctx.cx.jobs.has(r.id));
 assert.equal(ctx.clients.codex.logs.length,0);assert.equal(ctx.clients.claude.logs.length,0);assert.equal(ctx.hub.workScopes().some(scope=>scope.kind==='claudex'),false);
 assert.equal([...ctx.hub.reservations.values()].some(scope=>scope.kind==='claudex'),false);
});

test('reinício de pausa gravada ainda a drenar não conserva uma espera impossível pelo processo anterior',async t=>{
 const ctx=await setup(t),r=await ctx.start();await ctx.cx.pause(r.id);await wait(()=>!ctx.cx.pauseDrains.has(r.id));
 r.pause.draining=true;await ctx.cx.persist();clearInterval(ctx.cx.timer);clearTimeout(ctx.cx.scheduled);ctx.cx.loaded=false;await rm(ctx.cx.directory+'/owner.json');ctx.cx.ownsLock=false;
 const second=new ClaudeX({hub:ctx.hub,directory:ctx.cx.directory,prepare:ctx.cx.prepare});await second.load();
 const saved=second.record(r.id);assert.equal(saved.status,'paused');assert.equal(saved.pause.draining,false);assert.equal(second.leases.size,0);assert.equal(ctx.clients.codex.logs.length,1);
 await second.close();ctx.cx.raw=await readFile(ctx.cx.directory+'/state.json','utf8');
});


test('Codex renova o transporte ocioso e retoma a mesma thread com a nova credencial MCP',async t=>{
 const {Hydraq}=await import('../lib/hydraq.mjs'),root=await mkdtemp('/tmp/hydraq-cx-transport-');t.after(()=>rm(root,{recursive:true,force:true}));
 const calls=[],rpc=new EventEmitter();rpc.stop=async()=>calls.push({method:'stop'});rpc.start=async()=>calls.push({method:'start'});
 rpc.call=async(method,params)=>{calls.push({method,params});if(method==='account/read')return {account:{type:'chatgpt'}};if(method==='experimentalFeature/list')return {data:[],nextCursor:null};if(method==='model/list')return {data:[{model:'test',displayName:'Teste',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}],nextCursor:null};if(method==='config/read')return {config:{}};if(method==='thread/resume')return {thread:{id:params.threadId}};throw Error('RPC inesperado: '+method);};
 const client=new Hydraq({dataDir:root,defaultCwd:root,modelMetadataPath:root+'/absent.json',client:rpc});client.changed=()=>{};client.persist=async()=>{};client.connection='connected';client.account={type:'chatgpt'};
 const conversation={id:'cx',threadId:'native-preserved',cwd:root,model:'test',sandbox:'read-only',status:'interrupted',messages:[{text:'Histórico preservado.'}],turns:[]};client.conversations=[conversation];client.loaded.add('cx');client.loaded.add('other-idle');
 const before=structuredClone(conversation);await client.refreshClaudeXTransport('cx');
 assert.deepEqual(calls.slice(0,2).map(x=>x.method),['stop','start']);assert.equal(client.loaded.size,0);assert.equal(client.connection,'connected');assert.deepEqual(conversation,before);assert.equal(calls.some(x=>x.method.startsWith('thread/')||x.method.startsWith('turn/')),false);
 await client.ensureThread('cx',{internal:'claudex',contextMcp:{name:'fresh_cx',file:root+'/new-lease',command:'node',args:[],env:{HYDRAQ_CLAUDEX_LEASE:root+'/new-lease'},names:['read_dialogue']}});
 const resume=calls.find(x=>x.method==='thread/resume');assert.equal(resume.params.threadId,'native-preserved');assert.equal(resume.params.config.mcp_servers.fresh_cx.env.HYDRAQ_CLAUDEX_LEASE,root+'/new-lease');assert.equal(calls.some(x=>x.method==='thread/start'||x.method==='turn/start'),false);assert.equal(client.loaded.has('cx'),true);assert.deepEqual(conversation,before);
});

test('Codex recusa renovar transporte com atividade, entrega incerta ou aprovação pendente',async t=>{
 const {Hydraq}=await import('../lib/hydraq.mjs'),root=await mkdtemp('/tmp/hydraq-cx-transport-guard-');t.after(()=>rm(root,{recursive:true,force:true}));
 const rpc=new EventEmitter();let stops=0;rpc.stop=async()=>stops++;const client=new Hydraq({dataDir:root,defaultCwd:root,client:rpc});
 const conversation={id:'cx',threadId:'native',status:'interrupted'},other={id:'other',threadId:'other-native',status:'idle'};client.conversations=[conversation,other];client.loaded.add('cx');
 for(const status of ['starting','running','waiting','uncertain']){other.status=status;await assert.rejects(client.refreshClaudeXTransport('cx'),/Aguarda/);assert.equal(stops,0);assert.equal(client.loaded.has('cx'),true);}other.status='idle';
 client.submitting=true;await assert.rejects(client.refreshClaudeXTransport('cx'),/Aguarda/);client.submitting=false;
 client.approvals.set('approval',{conversationId:'other'});await assert.rejects(client.refreshClaudeXTransport('cx'),/Aguarda/);client.approvals.clear();assert.equal(stops,0);
 client.loaded.clear();await client.refreshClaudeXTransport('cx');assert.equal(stops,0);client.loaded.add('cx');conversation.threadId=null;await client.refreshClaudeXTransport('cx');assert.equal(stops,0);
});

test('retoma valida todos os terminais nativos antes de renovar o transporte Codex',async t=>{
 const ctx=await setup(t),r=await ctx.start();await ctx.cx.pause(r.id);await drained(ctx,r);let refreshed=0;ctx.clients.codex.refreshClaudeXTransport=async()=>refreshed++;
 ctx.hub.nativeSessions.sessions.set('other-terminal',{id:'other-terminal',group:'unrelated'});t.after(()=>ctx.hub.nativeSessions.sessions.clear());
 await assert.rejects(ctx.cx.resume(r.id),/terminais Codex|terminal/);assert.equal(refreshed,0);assert.equal(r.status,'paused');assert.equal(ctx.cx.leases.size,0);assert.equal(ctx.hub.reservations.size,0);
 ctx.hub.nativeSessions.sessions.clear();await ctx.cx.resume(r.id);await wait(()=>ctx.clients.codex.logs.length===2&&ctx.clients.claude.logs.length===2);assert.equal(refreshed,1);
});

test('HTTP pausa filtra estado e categoria injetados e preserva só o motivo público',async t=>{
 const ctx=await setup(t),r=await ctx.start(),guards=structuredClone(r.guards),{token}=await fetch(ctx.url+'/api/bootstrap',{headers:{'X-HYDRAQ-Bootstrap':'1'}}).then(x=>x.json());
 const response=await fetch(ctx.url+'/api/claudex/'+r.id+'/pause',{method:'POST',headers:{'content-type':'application/json','x-hydraq-token':token},body:JSON.stringify({reason:'Pausa explícita via HTTP.',status:'completed',kind:'guard',guards:{turns:0,minutes:0},result:{agreed:true}})});
 assert.equal(response.status,200);await drained(ctx,r);assert.equal(r.status,'paused');assert.equal(r.pause.kind,'user');assert.equal(r.pause.reason,'Pausa explícita via HTTP.');assert.deepEqual(r.guards,guards);assert.equal(r.result,undefined);assert.equal(ctx.cx.leases.size,0);
});


test('falha de interrupção fica visível, conserva reserva e permite nova tentativa',async t=>{
 const ctx=await setup(t),r=await ctx.start(),original=ctx.clients.codex.interrupt.bind(ctx.clients.codex);
 ctx.clients.codex.interrupt=async()=>{throw Error('Falha de transporte simulada');};
 await ctx.cx.pause(r.id);await drained(ctx,r);
 assert.equal(r.pause.interruptionPending,true);assert.match(r.error,/Interrupção por confirmar/);assert.match(r.pause.interruptErrors.codex,/transporte/);
 assert.ok(ctx.cx.scopes().some(s=>s.id===r.id));await assert.rejects(ctx.cx.resume(r.id),/reserv|curso|ativo|incert/i);
 ctx.clients.codex.interrupt=original;await ctx.cx.pause(r.id);await drained(ctx,r);
 assert.equal(r.pause.interruptionPending,false);assert.equal(ctx.cx.native(r,'codex').status,'interrupted');assert.equal(ctx.cx.scopes().length,0);
});
test('interrupção assíncrona só é confirmada depois do estado nativo terminar',async t=>{
 const ctx=await setup(t),r=await ctx.start();let calls=0;ctx.clients.codex.interrupt=async()=>{calls++;return {requested:true};};
 await ctx.cx.pause(r.id);await drained(ctx,r);assert.equal(r.pause.interruptionPending,true);const before=calls;
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(calls,before);
 ctx.clients.codex.finish(ctx.cx.native(r,'codex'),'Interrompido');ctx.cx.kick();await wait(()=>!r.pause.interruptionPending);assert.equal(ctx.cx.scopes().length,0);
});

test('atividade usa apenas ferramentas pendentes do turno atual e leitura guarda hora sem invalidar acordo',async t=>{
 const ctx=await setup(t),r=await ctx.start(),candidate=await prepared(ctx,r);await approve(ctx,r,'codex',candidate);
 const protocol=r.protocolVersion,evidence=r.evidenceRevision,approvals=structuredClone(r.approvals);
 await ctx.call(r,'claude','read_dialogue');const at=r.read.claude.at;
 assert.ok(Number.isFinite(Date.parse(at)));assert.equal(r.read.claude.seq,r.seq);
 assert.equal(r.protocolVersion,protocol);assert.equal(r.evidenceRevision,evidence);assert.deepEqual(r.approvals,approvals);
 const saved=JSON.parse(await readFile(ctx.cx.directory+'/state.json','utf8'));assert.equal(saved.conversations[0].read.claude.at,at);
 for(const role of ['codex','claude']){
  const c=ctx.cx.native(r,role);c.items=[
   {type:'mcpToolCall',tool:'Read',turnId:c.turnId,status:'inProgress',at},
   {type:'commandExecution',turnId:c.turnId,status:'inProgress',command:'private command',at},
   {type:'mcpToolCall',tool:'old',turnId:'old-turn',status:'inProgress'},
   {type:'mcpToolCall',tool:'done',turnId:c.turnId,status:'completed'},
   {type:'reasoning',turnId:c.turnId,status:'inProgress'}];
  // In words for the page; the other participant never receives it (it is not in the dialogue).
  assert.deepEqual(ctx.cx.detail(r.id).participants[role].activity,[{name:'A ler',tool:'Read',at},{name:'A correr private command',tool:'Terminal',at}]);
  assert.doesNotMatch(JSON.stringify(r.messages),/private command/);
  c.items[0].status='completed';assert.equal(ctx.cx.detail(r.id).participants[role].activity.length,1);
  c.status='completed';assert.deepEqual(ctx.cx.detail(r.id).participants[role].activity,[]);
 }
});

for(const pair of [['codex','claude'],['codex','antigravity'],['antigravity','claude']]){
 test('par '+pair.join(' + ')+' coordena caixa, pausa, retoma e aprova sem falso acordo',async t=>{
  const ctx=await setup(t),members=Object.fromEntries(pair.map(role=>[role,{model:'test',effort:'low'}]));
  const r=await ctx.start({roles:pair,members,author:pair[1]});
  assert.deepEqual(ctx.cx.snapshot().records[0].roles,pair);assert.equal(ctx.cx.snapshot().protocolVersion,4);
  assert.deepEqual(Object.keys(ctx.cx.detail(r.id).participants),pair);
  assert.deepEqual(ctx.cx.scopes()[0].resources,pair.map(k=>'normal:'+k));
  for(const role of pair){assert.ok(ctx.clients[role].logs[0].settings.contextMcp.names.includes('read_dialogue'));assert.match(ctx.cx.prompt(r,role),new RegExp('o colega é '+pair.find(k=>k!==role)));}
  const c=await prepared(ctx,r);await approve(ctx,r,pair[0],c);assert.equal(r.result,undefined);
  await ctx.cx.pause(r.id);await drained(ctx,r);assert.equal(r.approvals[pair[0]].candidateId,c.id);
  let refreshed=0;ctx.clients.codex.refreshClaudeXTransport=async()=>refreshed++;
  await ctx.cx.resume(r.id);assert.equal(refreshed,pair.includes('codex')?1:0);
  await wait(()=>pair.every(role=>ctx.cx.native(r,role).status==='running'));
  await approve(ctx,r,pair[1],c);
  for(const role of pair)ctx.clients[role].finish(ctx.cx.native(r,role),'Terminei.');
  await wait(()=>r.status==='completed');assert.equal(r.result.agreed,true);assert.deepEqual(Object.keys(r.result.approvals).sort(),[...pair].sort());
  if(pair.includes('antigravity'))assert.equal(ctx.clients.antigravity.notices.length,0);
 });
 test('par '+pair.join(' + ')+' publica síntese atribuída sem selo de acordo',async t=>{
  const ctx=await setup(t),r=await ctx.start({roles:pair,members:Object.fromEntries(pair.map(role=>[role,{model:'test',effort:'low'}])),author:pair[1],consensus:false});
  const c=await prepared(ctx,r);for(const role of pair)ctx.clients[role].finish(ctx.cx.native(r,role),'Fim');
  await wait(()=>r.status==='completed');assert.equal(r.result.agreed,false);assert.equal(r.result.text,c.text);assert.deepEqual(r.approvals,{});
 });
}
test('validação de pares recusa repetidos, desconhecidos, autores externos e membros extra',async t=>{
 const ctx=await setup(t);
 for(const extra of [{roles:['codex','codex']},{roles:['codex','cursor']},{roles:['claude']},{author:'antigravity'},{members:{...ctx.body.members,antigravity:{model:'test',effort:'low'}}}])await assert.rejects(ctx.cx.create({...ctx.body,...extra}),/distintos|autor|Participantes/);
 assert.equal(ctx.cx.records.length,0);
});
test('tarefas antigas sem roles continuam o par Codex e Claude após carregar',async t=>{
 const ctx=await setup(t),r=await ctx.start();await ctx.cx.pause(r.id);await drained(ctx,r);delete r.roles;await ctx.cx.persist();
 clearInterval(ctx.cx.timer);clearTimeout(ctx.cx.scheduled);ctx.cx.loaded=false;await rm(ctx.cx.directory+'/owner.json');ctx.cx.ownsLock=false;
 const second=new ClaudeX({hub:ctx.hub,directory:ctx.cx.directory,prepare:ctx.cx.prepare});await second.load();assert.equal(second.error,undefined);assert.deepEqual(second.snapshot().records[0].roles,['codex','claude']);await second.close();ctx.cx.raw=await readFile(ctx.cx.directory+'/state.json','utf8');
});

for(const pair of [['antigravity','claude'],['claude','codex']])test('projeto associado ao grupo comum com primeiro membro '+pair[0]+' e colega '+pair[1],async t=>{
 const ctx=await setup(t),project=await ctx.hub.createProject({name:'Memória ClaudeX',root:ctx.root,revision:ctx.hub.projects.data.revision});
 const r=await ctx.start({roles:pair,members:Object.fromEntries(pair.map(role=>[role,{model:'test',effort:'low'}])),projectId:project.id,projectRevision:ctx.hub.projects.data.revision});
 assert.equal(ctx.hub.projects.group(r.groupId).projectId,project.id);
 for(const role of pair){
  const c=ctx.cx.native(r,role);assert.equal(c.group,r.groupId);assert.equal(ctx.hub.projects.group(c.group).projectId,project.id);
  assert.ok(ctx.hub.contextMcp.sessions.has(c.id));assert.ok(ctx.clients[role].logs[0].settings.contextMcp.names.includes('get_project_memory'));
  assert.ok(await ctx.call(r,role,'get_project_memory'));
 }
 await ctx.cx.pause(r.id);await drained(ctx,r);await ctx.cx.resume(r.id);assert.equal(r.status,'discussing');
});


test('MCP do agy pela rota da conversa: credencial desta tarefa e deste participante; pausa revoga e retoma dá outra',async t=>{
 const ctx=await setup(t),agy=ctx.clients.antigravity,r=await ctx.start({roles:['codex','antigravity'],members:{codex:{model:'test',effort:'low'},antigravity:{model:'test',effort:'low'}}});
 const token=ctx.token(r,'antigravity'),config=ctx.cx.leases.get(token).config,route=agy.logs[0].settings.contextMcp.route;
 // No private socket or lease file: the adapter hands this route to agy's fixed hydraq server for each turn.
 assert.equal(config.name,'hydraq');assert.equal(config.socketPath,undefined);await assert.rejects(readFile(config.file),{code:'ENOENT'});
 assert.equal(route.url,ctx.url+'/api/claudex/tools');assert.equal(route.token,token);assert.ok(route.tools.some(tool=>tool.name==='read_dialogue'));
 const send=(credential=token,body={name:'read_dialogue',args:{}})=>fetch(ctx.url+'/api/claudex/tools',{method:'POST',headers:{'content-type':'application/json','x-hydraq-claudex-token':credential},body:JSON.stringify(body)}).then(async res=>({status:res.status,body:await res.json()}));
 assert.equal((await send('0'.repeat(64))).status,403);
 assert.equal((await send(token,{name:'read_dialogue',args:{padding:'x'.repeat(640001)}})).status,413);
 for(const role of ['codex','antigravity'])await ctx.call(r,role,'initial_position',{text:'Posição de '+role+'.'});
 assert.equal((await send()).body.self.role,'antigravity');assert.equal((await send(ctx.token(r,'codex'))).body.self.role,'codex','cada credencial age só como o seu participante');
 // The fixed server finds the task by agy's conversation id.
 const routes=await mkdtemp('/tmp/hydraq-cx-route-');t.after(()=>rm(routes,{recursive:true,force:true}));
 await writeFile(routes+'/conv-agy-1.json',JSON.stringify(route),{mode:0o600});
 const child=spawn(process.execPath,[fileURLToPath(new URL('../lib/claudex-mcp-server.mjs',import.meta.url)),'--route',routes],{stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:child.stdout});t.after(()=>{lines.close();child.kill();});
 let id=0;const rpc=()=>new Promise((resolve,reject)=>{child.once('error',reject);lines.once('line',line=>resolve(JSON.parse(line)));child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name:'read_dialogue',arguments:{},_meta:{'antigravity.google/root_conversation_id':'conv-agy-1'}}})+'\n');});
 const reply=await rpc();assert.equal(reply.result.isError,false);assert.equal(JSON.parse(reply.result.content[0].text).self.role,'antigravity');
 await ctx.cx.pause(r.id);await drained(ctx,r);await Promise.allSettled([...ctx.cx.leaseCleanups]);
 assert.equal((await send()).status,403);await assert.rejects(ctx.cx.tool(token,'read_dialogue',{}),/expirada/);
 const stale=await rpc();assert.equal(stale.result.isError,true);assert.match(stale.result.content[0].text,/expirada/,'uma rota antiga deixa de valer');
 const sent=agy.logs.length;await ctx.cx.resume(r.id);await wait(()=>agy.logs.length>sent);
 const renewed=agy.logs.at(-1).settings.contextMcp.route;assert.notEqual(renewed.token,token);assert.equal(renewed.token,ctx.token(r,'antigravity'));
 assert.equal((await send(renewed.token)).body.self.role,'antigravity');assert.equal(agy.logs.at(-1).id,agy.logs[0].id,'mesma conversa do agy');
});

test('tarefa do ambiente privado antigo do agy fica arquivada: não retoma, liberta as conversas e o conteúdo segue numa tarefa nova',async t=>{
 const ctx=await setup(t),{cx,hub}=ctx,r=await ctx.start({roles:['codex','antigravity'],members:{codex:{model:'test',effort:'low'},antigravity:{model:'test',effort:'low'}}});
 await ctx.call(r,'codex','initial_position',{text:'POSICAO-ANTIGA'});
 await cx.pause(r.id);await drained(ctx,r);
 const old=cx.native(r,'antigravity'),codex=cx.native(r,'codex');assert.ok(cx.holds(codex.id),'antes, a pausa guarda as conversas');
 old.claudexHome='/old/private/home';
 assert.equal(cx.snapshot().records.find(x=>x.id===r.id).retired,true);assert.equal(cx.detail(r.id).retired,true);
 await assert.rejects(cx.resume(r.id),/arquivada.*Nova tarefa a partir deste progresso/s);assert.equal(r.status,'paused');
 assert.equal(cx.holds(codex.id),false,'as conversas ficam livres');assert.equal(hub.claudex.scopes().some(s=>s.id===r.id),false);
 const next=await cx.create({...ctx.body,requestId:randomUUID(),roles:['codex','antigravity'],members:{codex:{model:'test',effort:'low'},antigravity:{model:'test',effort:'low'}},resumeFrom:r.id});
 const n=cx.record(next.task.id);await wait(()=>n.roles.every(role=>n.members[role].turns));
 assert.notEqual(n.members.antigravity.conversationId,old.id,'sessão nova do agy');assert.equal(cx.native(n,'antigravity').claudexHome,undefined);assert.equal(cx.detail(n.id).retired,false);
 assert.match(n.messages.find(m=>m.type==='checkpoint').text,/POSICAO-ANTIGA/,'o progresso passa como contexto');
});
