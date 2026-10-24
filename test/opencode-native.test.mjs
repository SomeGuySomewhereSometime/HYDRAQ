import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {OpenCode} from '../lib/opencode.mjs';
import {OpenCodeRuntime} from '../lib/opencode-runtime.mjs';
import {reconcileOpenCode} from '../lib/opencode-history.mjs';
const fixture=fileURLToPath(new URL('./fixtures/fake-opencode-native.mjs',import.meta.url));
const wait=async fn=>{const deadline=Date.now()+8000;while(!fn()){if(Date.now()>deadline)throw Error('Timeout');await new Promise(r=>setTimeout(r,20));}};
async function setup(t){
 const root=await mkdtemp('/tmp/hydraq-opencode-native-test-');await mkdir(root+'/project');const clients=[];
 const make=async()=>{const runtime=new OpenCodeRuntime({directory:root+'/state/native',executable:process.execPath,args:[fixture],env:{...process.env,FAKE_OPENCODE_LOG:root+'/log'},manifest:false,minimumSettleMs:0,settleMs:1000});const client=new OpenCode({dataDir:root+'/state',defaultCwd:root+'/project',runtime});clients.push(client);await client.load();await client.connect();return client;};
 t.after(async()=>{for(const c of clients)await c.close();await rm(root,{recursive:true,force:true});});
 return {root,make,log:async()=> (await readFile(root+'/log','utf8')).trim().split('\n').map(JSON.parse)};
}
test('HTTP nativo executa, retoma o mesmo ID e conserva anotações sem duplicar',async t=>{
 const {root,make,log}=await setup(t);let client=await make();const c=await client.create({cwd:root+'/project',model:'opencode/test-free',effort:'low',sandbox:'plan'});
 await client.send(c.id,'contexto\n\nolá','one',{displayText:'olá',projectContext:{revision:7}});await wait(()=>c.status==='completed');
 assert.equal(c.messages[0].text,'olá');assert.equal(c.messages[0].projectContext.revision,7);assert.equal(c.turns[0].usage.inputTokens,12);assert.equal(c.turns[0].costUSD,0);
 await client.sync(c);await client.sync(c);assert.equal(c.messages.length,2);const sid=c.threadId;
 await client.close();client=await make();const restored=client.conversation(c.id);await client.send(c.id,'segundo','two');await wait(()=>restored.status==='completed'&&restored.turns.length===2);
 assert.equal(restored.threadId,sid);assert.equal(restored.messages.length,4);assert.equal((await log()).length,2);assert.equal(client.snapshot().transport,'http');
});
test('permissões habituais chegam a sessões novas e antigas e acompanham Planear no TUI sem novo prompt',async t=>{
 const {root,make,log}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await client.send(c.id,'primeiro','one');await wait(()=>c.status==='completed');
 const policy=async()=>JSON.parse(await readFile(root+'/state/native/sessions.json','utf8'))[c.threadId].permissions;
 const effect=(rules,action)=>rules.findLast(r=>r.resource==='*'&&(r.action===action||r.action==='*'))?.effect;
 assert.equal(effect(await policy(),'edit'),'allow');assert.equal(effect(await policy(),'shell'),'allow');assert.equal(effect(await policy(),'execute'),'allow');
 await client.runtime.api('/api/session/'+c.threadId,{method:'PATCH',body:{permissions:[{action:'*',resource:'*',effect:'ask'}]}});delete c.nativePermissionProfile;await client.sync(c);assert.equal(effect(await policy(),'edit'),'allow');
 await client.runtime.api('/api/session/'+c.threadId+'/agent',{method:'POST',body:{agent:'plan'}});await client.sync(c);assert.equal(effect(await policy(),'edit'),'deny');assert.equal(effect(await policy(),'shell'),'ask');assert.equal(effect(await policy(),'execute'),'allow');
 await client.runtime.api('/api/session/'+c.threadId+'/agent',{method:'POST',body:{agent:'build'}});await client.sync(c);assert.equal(effect(await policy(),'edit'),'allow');assert.equal((await log()).length,1);assert.equal(client.snapshot().permissionProfile,'routine');
});
test('recibo perdido recupera o resultado pelo ID e nunca reenvia o pedido',async t=>{
 const {root,make,log}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await assert.rejects(client.send(c.id,'lost','one'));assert.equal((await client.send(c.id,'lost','one')).duplicate,true);
 await wait(()=>c.status==='completed');assert.equal(c.turns[0].finalAnswer,'Recuperada');assert.equal((await log()).length,1);
});
test('credencial privada do servidor não passa para a resposta, snapshot ou histórico HYDRAQ',async t=>{
 const {root,make}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 const secret=(await client.runtime.terminalEnvironment()).OPENCODE_SERVER_PASSWORD;
 assert.equal(client.runtime.publicText('prefixo '+secret.slice(0,9),false),'prefixo ');
 await client.send(c.id,'password','one');await wait(()=>c.status==='completed');assert.equal(c.turns[0].finalAnswer,'[CHAVE OCULTA]');
 assert.ok(!JSON.stringify(client.snapshot()).includes(secret));await client.persist();assert.ok(!(await readFile(root+'/state/state.json','utf8')).includes(secret));
});
test('reiniciar com entrega incerta não repete o prompt nem inicia outro pedido',async t=>{
 const {root,make,log}=await setup(t);let client=await make();const c=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await assert.rejects(client.send(c.id,'lost-hang','uncertain'));await client.close();client=await make();const restored=client.conversation(c.id);
 assert.equal(restored.status,'uncertain');assert.equal((await client.send(c.id,'lost-hang','uncertain')).duplicate,true);await assert.rejects(client.send(c.id,'outro','next'),/incerto/);assert.equal((await log()).length,1);
 await client.interrupt(c.id);await wait(()=>restored.status==='interrupted');assert.equal((await log()).length,1);
});
test('falha de histórico conserva mensagens, é distinta de vazio e bloqueia novo envio',async t=>{
 const {root,make,log}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await client.send(c.id,'primeiro','one');await wait(()=>c.status==='completed');const before=JSON.stringify(c.messages);
 await writeFile(root+'/state/native/mode.json',JSON.stringify({historyError:true}));await assert.rejects(client.sync(c));assert.equal(c.nativeHistory.status,'unavailable');assert.equal(JSON.stringify(c.messages),before);
 await assert.rejects(client.send(c.id,'segundo','two'));assert.equal((await log()).length,1);
 await writeFile(root+'/state/native/mode.json',JSON.stringify({pageSize:1}));await client.sync(c);assert.equal(c.nativeHistory.status,'complete');assert.equal(c.nativeHistory.count,3);assert.equal(c.messages.length,2);
});
test('eventos perdidos recuperam perguntas e respostas iniciadas no terminal, incluindo todas as páginas',async t=>{
 const {root,make}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await client.send(c.id,'primeiro','one');await wait(()=>c.status==='completed');clearInterval(client.pollTimer);
 await writeFile(root+'/state/native/mode.json',JSON.stringify({pageSize:1}));await client.runtime.api('/test/disconnect');
 c.terminal={sessionId:c.threadId};await client.runtime.api('/api/session/'+c.threadId+'/prompt',{method:'POST',body:{id:'msg_terminal',text:'terminal',resume:true}});
 await wait(()=>c.turns.length===2&&c.status==='completed');assert.equal(c.messages.find(m=>m.nativeId==='msg_terminal').source,'terminal');assert.equal(c.messages.length,4);await client.sync(c);assert.equal(c.messages.length,4);
});
const quiet=client=>wait(()=>!client.eventTimer&&!client.eventFlush&&!client.syncing.size&&!client.settleTimers.size);
const eventFrame=id=>'data: '+JSON.stringify({type:'session.updated',data:{sessionID:id}})+'\r\n\r\n';
test('eventos fragmentados são agrupados por sessão e heartbeats não consultam históricos',async t=>{
 const {root,make}=await setup(t),client=await make();clearInterval(client.pollTimer);
 const a=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await client.send(a.id,'primeiro','one');await wait(()=>a.status==='completed');
 const b=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await client.send(b.id,'segundo','two');await wait(()=>b.status==='completed');await quiet(client);
 const reads=[],history=client.runtime.history.bind(client.runtime);client.runtime.history=async id=>{reads.push(id);return history(id);};
 const burst=eventFrame(a.threadId).repeat(100);
 await client.runtime.api('/test/events',{method:'POST',body:{frames:[burst.slice(0,11),burst.slice(11,29),burst.slice(29,-1),burst.slice(-1)]}});
 await wait(()=>reads.length>0);await quiet(client);assert.deepEqual(reads,[a.threadId]);
 await client.runtime.api('/test/events',{method:'POST',body:{frames:[': keepalive\n\ndata: {"type":"server.heartbeat","data":{}}\n\n'+eventFrame('ses_untracked')]}});
 await new Promise(r=>setTimeout(r,350));assert.deepEqual(reads,[a.threadId]);
 // An unfamiliar global event keeps the conservative recovery path, still as one batch.
 await client.runtime.api('/test/events',{method:'POST',body:{frames:['data: {"type":"changed"}\n\n'.repeat(20)]}});
 await wait(()=>reads.length===3);await quiet(client);assert.deepEqual(new Set(reads.slice(1)),new Set([a.threadId,b.threadId]));
});
test('um evento durante a consulta conserva uma leitura posterior mesmo com a sessão parada',async t=>{
 const {root,make}=await setup(t),client=await make();clearInterval(client.pollTimer);
 const c=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await client.send(c.id,'primeiro','one');await wait(()=>c.status==='completed');await quiet(client);
 const history=client.runtime.history.bind(client.runtime);let release,started,reads=0;
 const gate=new Promise(r=>{release=r;}),readingStarted=new Promise(r=>{started=r;});
 client.runtime.history=async id=>{const result=await history(id);if(++reads===1){started();await gate;}return result;};
 const reading=client.sync(c);
 try{
  await readingStarted;
  await client.runtime.api('/api/session/'+c.threadId+'/agent',{method:'POST',body:{agent:'plan'}});
  await client.runtime.api('/test/events',{method:'POST',body:{frames:[eventFrame(c.threadId)]}});
  await wait(()=>client.eventFlush);release();await reading;
  await wait(()=>c.sandbox==='plan');await quiet(client);assert.equal(reads,2);
 }finally{release();await reading;}
});
test('consulta periódica espaçada exclui arquivo da conversa e do projeto, mas recuperação explícita mantém-se',async t=>{
 const {Providers}=await import('../lib/providers.mjs');const {groupOf}=await import('../lib/handoff.mjs');
 const {root,make}=await setup(t),client=await make();clearInterval(client.pollTimer);
 const a=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await client.send(a.id,'primeiro','one');await wait(()=>a.status==='completed');
 const b=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await client.send(b.id,'segundo','two');await wait(()=>b.status==='completed');await quiet(client);
 const hub=new Providers({clients:{opencode:client},defaultCwd:root+'/project'});
 hub.projects.data.groups[groupOf(a)]={archived:false};hub.projects.data.groups[groupOf(b)]={projectId:'archived-project',archived:false};
 hub.projects.data.projects.push({id:'archived-project',name:'Arquivo',root:root+'/project',archived:true});
 const reads=[],history=client.runtime.history.bind(client.runtime);client.runtime.history=async id=>{reads.push(id);return history(id);};
 client.lastIdleSweep=Date.now()-6000;await client.sweep();assert.deepEqual(reads,[]);
 client.lastIdleSweep=Date.now()-60_001;await client.sweep();assert.deepEqual(reads,[a.threadId]);reads.length=0;
 hub.projects.data.groups[groupOf(a)].archived=true;
 client.lastIdleSweep=Date.now()-60_001;await client.sweep();assert.deepEqual(reads,[]);
 await client.runtime.api('/test/events',{method:'POST',body:{frames:[eventFrame(a.threadId)+eventFrame(b.threadId)]}});
 await new Promise(r=>setTimeout(r,350));await quiet(client);assert.deepEqual(reads,[]);
 await client.sync(b);assert.deepEqual(reads,[b.threadId]);reads.length=0;
 await client.sweep(true);assert.deepEqual(new Set(reads),new Set([a.threadId,b.threadId]));
});
test('erro repetido não agenda nova gravação e tentativas automáticas recuam sem bloquear recuperação manual',async t=>{
 const {root,make,log}=await setup(t),client=await make();clearInterval(client.pollTimer);
 const c=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await client.send(c.id,'primeiro','one');await wait(()=>c.status==='completed');await quiet(client);
 const originalMessages=JSON.stringify(c.messages);await writeFile(root+'/state/native/mode.json',JSON.stringify({historyError:true}));
 await assert.rejects(client.sync(c));const revision=client.historyRevision,attemptedAt=c.nativeHistory.attemptedAt;
 await assert.rejects(client.sync(c));assert.equal(client.historyRevision,revision);assert.equal(c.nativeHistory.attemptedAt,attemptedAt);
 const retry=client.syncRetry.get(c.id);assert.equal(retry.failures,2);assert.ok(retry.nextAt-Date.now()>9000);
 let reads=0;const history=client.runtime.history.bind(client.runtime);client.runtime.history=async id=>{reads++;return history(id);};
 await client.sweep();assert.equal(reads,0);
 retry.nextAt=Date.now()-1;await client.sweep();assert.equal(reads,1);assert.equal(client.syncRetry.get(c.id).failures,3);
 await client.sweep();assert.equal(reads,1);assert.equal(client.historyRevision,revision);
 await writeFile(root+'/state/native/mode.json','{}');await client.sync(c);
 assert.equal(c.nativeHistory.status,'complete');assert.equal(client.syncRetry.has(c.id),false);assert.equal(JSON.stringify(c.messages),originalMessages);assert.equal((await log()).length,1);
});
test('decisões nativas não aprovam ferramentas automaticamente e o cancelamento conserva parcial',async t=>{
 const {root,make}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await client.send(c.id,'permission','one');await wait(()=>c.status==='waiting');const approval=[...client.approvals.values()][0];assert.equal(approval.params.options[0].optionId,'once');await client.respond(approval.id,{optionId:'reject'});await wait(()=>c.status==='completed');
 await client.send(c.id,'wait','two');await wait(()=>c.messages.some(m=>m.text==='Parcial'));await client.interrupt(c.id);await wait(()=>c.status==='interrupted');assert.equal(c.messages.at(-1).text,'Parcial');
});
test('formulário nativo conserva a pergunta e valida a resposta antes de a enviar',async t=>{
 const {root,make}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await client.send(c.id,'question','one');await wait(()=>c.status==='waiting');let approval=[...client.approvals.values()][0];assert.equal(approval.method,'elicitation/create');
 await assert.rejects(client.respond(approval.id,{action:'accept',content:{}}),/falta/);await client.respond(approval.id,{action:'accept',content:{answer:'npm test'}});await wait(()=>c.status==='completed');assert.match(c.turns[0].finalAnswer,/npm test/);
});
test('fim nativo antecipado espera pela resposta projetada e por uma leitura estável',()=>{
 const c={cwd:'/tmp',status:'running',messages:[{id:'local',nativeInputId:'u',turnId:'t',role:'user',text:'one'}],items:[],turns:[{id:'t',nativeInputId:'u',status:'running',interactions:[]}]};
 const user={id:'u',type:'user',time:{created:1},text:'one'},idle={id:'i',type:'idle',time:{created:3},outcome:'succeeded'};
 reconcileOpenCode(c,[user,idle]);assert.equal(c.status,'running');assert.equal(c.nativeHistory.settling,true);
 const answer={id:'a',type:'assistant',time:{created:2,completed:2},content:[{type:'text',text:'Resposta final'}]};
 reconcileOpenCode(c,[user,answer,idle]);assert.equal(c.status,'running');c.nativePendingCompletion.observedAt-=300;
 reconcileOpenCode(c,[user,answer,idle]);assert.equal(c.status,'completed');assert.equal(c.turns[0].finalAnswer,'Resposta final');assert.equal(c.messages.length,2);
});
test('idle recebido antes da resposta final não liberta o pedido nem perde o texto tardio',async t=>{
 const {root,make}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await client.send(c.id,'lagged','one');await wait(()=>c.nativeHistory?.settling);await new Promise(r=>setTimeout(r,300));assert.equal(c.status,'running');
 await wait(()=>c.status==='completed');assert.equal(c.turns[0].finalAnswer,'Final tardio');assert.equal(c.messages.length,2);
});
test('reconciliação conserva referências e só regista alterações de ficheiros observadas nativamente',()=>{
 const turn={id:'t',nativeInputId:'u',status:'running',interactions:[]},user={id:'local',nativeInputId:'u',turnId:'t',role:'user',text:'one'};
 const c={cwd:'/tmp/project',status:'running',messages:[user],items:[],turns:[turn]};
 const native=[{id:'u',type:'user',time:{created:1},text:'one'},{id:'a',type:'assistant',time:{created:2,completed:3},content:[{type:'tool',id:'execute',name:'execute',time:{created:2},state:{status:'completed',input:{code:'write("unobserved.txt")'},content:[{type:'text',text:'erro'}],metadata:{error:true,toolCalls:[]}}}],snapshot:{files:['observed.mjs']}}];
 reconcileOpenCode(c,native);assert.equal(c.turns[0],turn);assert.equal(c.messages[0],user);assert.equal(c.items.find(i=>i.nativeId==='execute').status,'failed');
 assert.deepEqual(c.items.filter(i=>i.type==='fileChange').flatMap(i=>i.changes.map(p=>p.path)),['/tmp/project/observed.mjs']);
});
test('passagem OpenCode reserva o grupo, impede cliente alternativo e exige terminal fechado e histórico completo',async t=>{
 const {Providers}=await import('../lib/providers.mjs');const {processIdentity}=await import('../lib/process-owner.mjs');
 const {root,make}=await setup(t),client=await make(),hub=new Providers({clients:{opencode:client},git:async()=>null,inspect:async()=>({files:{},warnings:[],complete:true})});
 const c=await client.create({cwd:root+'/project',model:'opencode/test-free'});await client.send(c.id,'primeiro','one');await wait(()=>c.status==='completed');
 const result=await hub.openCodeTerminal.open(c.id,{launch:false});assert.ok(result.command.includes('opencode-terminal-launch'));assert.ok(!result.command.includes('PASSWORD'));
 assert.throws(()=>hub.nativeSessions.assertControl(c.id),/OpenCode original/);assert.ok(hub.workScopes().some(s=>s.kind==='terminal'));
 const config=JSON.parse(await readFile(c.terminal.file,'utf8'));assert.ok(config.env.OPENCODE_SERVER_PASSWORD);assert.ok(!JSON.stringify(hub.snapshot()).includes(config.env.OPENCODE_SERVER_PASSWORD));
 await writeFile(c.terminal.file+'.lock',JSON.stringify({pid:process.pid,identity:processIdentity()}));await assert.rejects(hub.openCodeTerminal.release(c.id),/Fecha primeiro/);
 await rm(c.terminal.file+'.lock');await writeFile(root+'/state/native/mode.json',JSON.stringify({historyError:true}));await assert.rejects(hub.openCodeTerminal.release(c.id));assert.ok(c.terminal);
 await writeFile(root+'/state/native/mode.json','{}');await hub.openCodeTerminal.release(c.id);assert.equal(c.terminal,undefined);assert.equal(await readFile(result.command.match(/'([^']+\.json)'$/)[1]).catch(()=>null),null);
});
test('paginação falhada ou cíclica nunca entrega um histórico parcial',async()=>{
 const runtime=new OpenCodeRuntime({directory:'/tmp/unused-native-test',executable:'unused'});let calls=0;
 runtime.api=async()=>{if(++calls===2)throw Error('offline');return {data:[{id:'msg_1',type:'user',time:{created:1},text:'one'}],cursor:{next:'page2'}};};
 await assert.rejects(runtime.history('ses_test'),/offline/);runtime.api=async()=>({data:[],cursor:{next:'loop'}});await assert.rejects(runtime.history('ses_test'),/repetido/);
});
test('projeção inválida é atómica e a migração ACP ambígua preserva o original',()=>{
 const c={cwd:'/tmp',status:'completed',messages:[],items:[],turns:[]};const before=JSON.stringify(c);
 assert.throws(()=>reconcileOpenCode(c,[{id:'a',type:'assistant',time:{created:1},content:[{type:'new-format'}]}]),/incompleto/);assert.equal(JSON.stringify(c),before);
 c.turns=[{id:'old',status:'completed'}];c.messages=[{id:'user',role:'user',turnId:'old',text:'igual'}];
 const message=id=>({id,type:'user',time:{created:1},text:'igual'});const legacy=JSON.stringify(c);assert.throws(()=>reconcileOpenCode(c,[message('a'),message('b')]),/ambiguidade/);assert.equal(JSON.stringify(c),legacy);
});
