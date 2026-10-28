import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir,rename,stat} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {Providers} from '../lib/providers.mjs';import {createHttpServer} from '../lib/http.mjs';import {CollaborationClient,TestSupervisor} from './fixtures/collaboration-client.mjs';
import {ProcessSupervisor} from '../lib/process-supervisor.mjs';
const wait=async f=>{const end=Date.now()+6000;while(!f()){if(Date.now()>end)throw Error('Estado não chegou');await new Promise(r=>setTimeout(r,10));}};
async function setup(t,existing){
 const dir=existing||await mkdtemp(path.join(os.tmpdir(),'hydraq-col-')),dataDir=dir+'/data';
 const normal={codex:new CollaborationClient('normal',dataDir),cursor:new CollaborationClient('executor',dataDir+'/cursor'),claude:new CollaborationClient('reviewer',dataDir+'/claude')},clients={principal:new CollaborationClient('principal',dataDir+'/collaboration/principal'),executor:new CollaborationClient('executor',dataDir+'/collaboration/executor'),reviewer:new CollaborationClient('reviewer',dataDir+'/collaboration/reviewer')},supervisor=new TestSupervisor();
 const hub=new Providers({dataDir,defaultCwd:dir,clients:normal,collaborationClients:clients,collaborationSupervisor:supervisor});clients.principal.engine=hub.collaboration;await hub.load();
 const server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,bootstrap=await(await fetch(base+'/api/bootstrap',{headers:{'X-HYDRAQ-Bootstrap':'1'}})).json();
 const api=async(route,body,token=bootstrap.token)=>{const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'x-hydraq-token':token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json()};};
 let closed=false;const close=async()=>{if(closed)return;closed=true;server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));await hub.close();};
 t.after(async()=>{await close();if(!existing)await rm(dir,{recursive:true,force:true});});
 const create=async extra=>hub.collaboration.create({cwd:dir,principal:{model:'gpt-test',effort:'medium'},executor:{model:'grok-4.7',effort:'low',context:'500k',fast:false},...extra});
 const send=async(s,text='COL_DELEGATE',id=randomUUID())=>{await hub.collaboration.send(s.id,{text,requestId:id});return id;};
 return{dir,dataDir,hub,clients,normal,supervisor,server,api,base,create,send,close};
}

test('fila espera pelo fim do principal, executa e entrega resultado uma vez na mesma sessão',async t=>{
 const {hub,clients,create,send}=await setup(t),s=await create();await send(s,'COL_GATE');await wait(()=>hub.collaboration.session(s.id).jobs.length===1&&clients.principal.duplicate);
 assert.equal(clients.principal.conversations[0].status,'running');assert.equal(clients.executor.conversations.length,0);assert.equal(clients.principal.duplicate.duplicate,true);
 await clients.principal.finish(clients.principal.conversations[0],'Pronto para executor');await wait(()=>hub.collaboration.session(s.id).status==='completed');
 const d=hub.collaboration.detail(s.id);assert.equal(d.jobs.length,1);assert.equal(d.jobs[0].status,'completed');assert.equal(d.jobs[0].resultDelivery,'confirmed');assert.match(d.messages.at(-1).text,/Avaliação: EXECUTOR-RESULT/);
 assert.equal(clients.executor.conversations[0].turns.length,1);assert.equal(clients.principal.conversations[0].turns.length,2);assert.equal(hub.snapshot().conversations.length,0);
 await assert.rejects(hub.collaboration.tool(clients.principal.lastToken,'delegate_to_executor',{requestKey:'late',instructions:'Não executar'}),/inválida/);
});

test('pedido e criação idempotentes; pergunta direta não chama executor',async t=>{
 const {hub,clients,create,send}=await setup(t),key=randomUUID(),s=await create({requestId:key}),again=await create({requestId:key});assert.equal(s.id,again.id);
 const requestId=await send(s,'COL_DIRECT');await wait(()=>hub.collaboration.session(s.id).status==='completed');
 const d=await hub.collaboration.send(s.id,{text:'COL_DIRECT',requestId});assert.equal(d.duplicate,true);assert.equal(clients.principal.conversations[0].turns.length,1);assert.equal(clients.executor.conversations.length,0);
 await assert.rejects(hub.collaboration.send(s.id,{text:'outro',requestId}),/outro pedido/);
});

test('principal pode pedir correção delimitada sem trocar de sessão; limite bloqueia quarta delegação',async t=>{
 const {hub,clients,create,send}=await setup(t),s=await create();await send(s,'COL_LOOP');await wait(()=>hub.collaboration.session(s.id).status==='completed');
 assert.equal(hub.collaboration.session(s.id).jobs.length,2);assert.equal(clients.principal.conversations[0].turns.length,3);assert.equal(clients.executor.conversations[0].turns.length,2);
 const other=await create();await send(other,'COL_BUDGET');await wait(()=>hub.collaboration.session(other.id).status==='completed');assert.equal(hub.collaboration.session(other.id).jobs.length,3);assert.match(clients.principal.budgetError,/três/);
});

test('ocupação mútua entre conversas e colaboração; arquivo ativo bloqueado',async t=>{
 const {hub,normal,clients,create,send,dir}=await setup(t),p=await hub.createProject({name:'Projeto',root:dir,revision:0}),s=await create({projectId:p.id});
 const c=await hub.create({cwd:dir,provider:'codex',model:'gpt-test',effort:'low'});normal.codex.conversation(c.id).status='running';await assert.rejects(send(s),/tarefa em curso/);normal.codex.conversation(c.id).status='idle';
 await send(s,'COL_PARENT_HOLD');await wait(()=>clients.principal.conversations[0]?.status==='running');
 await assert.rejects(hub.send(c.id,'Não enviar','normal-blocked'),e=>e.code==='WORK_RESERVED');assert.equal(normal.codex.conversations[0].turns.length,0);
 await assert.rejects(hub.updateProject(p.id,{revision:hub.projects.data.revision,archived:true}),/colaboração/);
 await hub.collaboration.interrupt(s.id);assert.ok(['interrupted','uncertain'].includes(hub.collaboration.session(s.id).status));
});

test('cancelamento conserva parcial, encerra supervisão e nunca entrega sucesso ao principal',async t=>{
 const {hub,clients,supervisor,create,send}=await setup(t),s=await create();await send(s,'COL_WORKER_HOLD');await wait(()=>clients.executor.conversations[0]?.messages.some(m=>m.text==='PARCIAL-REAL-DO-TESTE'));
 await hub.collaboration.interrupt(s.id);const d=hub.collaboration.detail(s.id);assert.equal(d.status,'interrupted');assert.equal(d.jobs[0].partial,'PARCIAL-REAL-DO-TESTE');assert.equal(d.jobs[0].status,'interrupted');assert.ok(supervisor.stops.includes(d.jobs[0].unit));assert.equal(clients.principal.conversations[0].turns.length,1);
});

test('perda nativa fica incerta e bloqueia novo pedido até revisão explícita',async t=>{
 const {hub,clients,create,send}=await setup(t),s=await create();await send(s,'COL_WORKER_LOST');await wait(()=>hub.collaboration.session(s.id).status==='uncertain');
 assert.equal(hub.collaboration.detail(s.id).jobs[0].partial,'PARCIAL-INCERTO');await assert.rejects(send(s,'COL_DIRECT'),/incerto/);await hub.collaboration.acknowledge(s.id);await send(s,'COL_DIRECT');await wait(()=>hub.collaboration.session(s.id).status==='completed');assert.equal(clients.executor.conversations[0].turns.length,1);
});

test('reinício conserva jobs, parcial e IDs sem inferência nem reenvio',async t=>{
 const first=await setup(t),s=await first.create();await first.send(s,'COL_WORKER_HOLD');await wait(()=>first.clients.executor.conversations[0]?.messages.some(m=>m.text==='PARCIAL-REAL-DO-TESTE'));const ids={p:first.clients.principal.conversations[0].threadId,e:first.clients.executor.conversations[0].threadId};await first.close();
 const next=await setup(t,first.dir),d=next.hub.collaboration.detail(s.id);assert.equal(d.status,'uncertain');assert.equal(next.clients.principal.conversations[0].threadId,ids.p);assert.equal(next.clients.executor.conversations[0].threadId,ids.e);assert.equal(next.clients.executor.conversations[0].turns.length,1);assert.equal(d.jobs[0].partial,'PARCIAL-REAL-DO-TESTE');await next.close();
});

test('API limita tokens, sessões, modelos e projeto; memória fica no projeto autorizado',async t=>{
 const {hub,clients,create,send,api,base,dir}=await setup(t),p=await hub.createProject({name:'A',root:dir,revision:0});await mkdir(dir+'/B');const q=await hub.createProject({name:'B',root:dir+'/B',revision:1});await hub.saveProjectMemory(p.id,{revision:0,text:'MEMORIA-A'});await hub.saveProjectMemory(q.id,{revision:0,text:'MEMORIA-B'});
 const s=await create({projectId:p.id});assert.equal((await api(`/api/collaborations/${s.id}`,undefined,'wrong')).status,403);
 assert.equal((await fetch(base+'/api/collaboration/tools',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'delegate_to_executor',args:{}})})).status,403);
 await send(s,'COL_GATE');await wait(()=>clients.principal.lastToken);const token=clients.principal.lastToken;
 const memory=await hub.collaboration.tool(token,'get_project_memory',{});assert.equal(memory.text,'MEMORIA-A');
 await assert.rejects(hub.collaboration.tool(token,'get_project_memory',{projectId:q.id}),/autorizados/);
 await assert.rejects(hub.collaboration.tool(token,'get_delegation_result',{jobId:randomUUID()}),/fora/);
 await assert.rejects(hub.collaboration.tool(token,'delegate_to_executor',{requestKey:'foreign',instructions:'x',model:'outro'}),/autorizado/);
 await hub.collaboration.interrupt(s.id);
});

test('supervisão indisponível recusa antes de criar inferência; pasta desaparecida bloqueia',async t=>{
 const {hub,clients,supervisor,create,send,dir}=await setup(t);supervisor.availableValue=false;await assert.rejects(create(),/indisponível/);assert.equal(clients.principal.conversations.length,0);supervisor.availableValue=true;
 await mkdir(dir+'/repo');const s=await create({cwd:dir+'/repo'});await rename(dir+'/repo',dir+'/moved');await assert.rejects(send(s),/ENOENT/);assert.equal(clients.principal.conversations.length,0);
});

test('arquivo inválido é preservado e não quebra as conversas normais',async t=>{
 const first=await setup(t);await first.close();const file=first.dataDir+'/collaboration/state.json';await writeFile(file,'{"version":1,"conversations":{}}');const next=await setup(t,first.dir);assert.match(next.hub.collaboration.error,/preservado/);assert.deepEqual(next.hub.snapshot().collaboration.sessions,[]);assert.equal(next.hub.snapshot().providers.codex.connection,'connected');await next.close();assert.equal(await readFile(file,'utf8'),'{"version":1,"conversations":{}}');
});

test('histórico e credenciais de colaboração são privados',async t=>{
 const {hub,create,send,dataDir}=await setup(t),s=await create();await send(s,'COL_GATE');await wait(()=>hub.collaboration.session(s.id).jobs.length);
 assert.equal((await stat(dataDir+'/collaboration/state.json')).mode&0o777,0o600);assert.equal((await stat(dataDir+'/collaboration/'+s.id+'.lease.json')).mode&0o777,0o600);await hub.collaboration.interrupt(s.id);
 await assert.rejects(readFile(dataDir+'/collaboration/'+s.id+'.lease.json'),'ENOENT');
});

test('falha de persistência inicial não deixa um ciclo executável em memória',async t=>{
 const {hub,clients,create,send,dataDir}=await setup(t),s=await create(),file=dataDir+'/collaboration/state.json',original=await readFile(file,'utf8');
 await writeFile(file,original+' ');await assert.rejects(send(s),/mudou no disco/);await new Promise(r=>setTimeout(r,40));assert.equal(hub.collaboration.session(s.id).status,'idle');assert.equal(clients.principal.conversations.length,0);assert.equal(hub.collaboration.busy,false);await writeFile(file,original);
});

test('falha de limpeza bloqueia inferência até recuperação explícita e conserva a incerteza',async t=>{
 const {hub,supervisor,create,send}=await setup(t),s=await create();supervisor.stopError=true;await send(s,'COL_WORKER_LOST');await wait(()=>hub.collaboration.unsafe);
 assert.equal(hub.collaboration.busy,true);assert.equal(hub.collaboration.session(s.id).status,'uncertain');supervisor.stopError=false;await hub.collaboration.recover();assert.equal(hub.collaboration.busy,false);assert.equal(hub.collaboration.error,null);await assert.rejects(send(s,'COL_DIRECT'),/incerto/);
});

test('trabalho continua sem prazo mesmo com deadlines antigos; Parar preserva factos e parcial',async t=>{
 const {hub,clients,create,send}=await setup(t),s=await create();await send(s,'COL_WORKER_HOLD');await wait(()=>clients.executor.conversations[0]?.messages.some(m=>m.text==='PARCIAL-REAL-DO-TESTE'));
 const session=hub.collaboration.session(s.id),job=session.jobs[0],cycle=session.cycles[0],c=clients.executor.conversations[0];assert.equal(job.deadline,undefined);assert.equal(cycle.deadline,undefined);
 cycle.deadline=job.deadline=Date.now()-24*60*60*1000;await hub.collaboration.serial(()=>hub.collaboration.advance());assert.equal(session.status,'executor');assert.equal(clients.principal.conversations[0].turns.length,1);
 c.items.push({id:'edit',turnId:c.turns[0].id,type:'fileChange',status:'completed',changes:[{path:'/project/game.js'}]});await hub.collaboration.interrupt(s.id);
 const d=hub.collaboration.detail(s.id);assert.equal(d.status,'interrupted');assert.equal(d.jobs[0].partial,'PARCIAL-REAL-DO-TESTE');assert.equal(d.jobs[0].delivery,'sending');assert.deepEqual(d.jobs[0].facts.files,['/project/game.js']);
 await send(s,'COL_PARENT_HOLD');await wait(()=>clients.principal.conversations[0].turns.length===2);assert.match(clients.principal.lastPrompt,/game\.js/);assert.match(clients.principal.lastPrompt,/ficheiros atuais/);assert.equal(clients.executor.conversations[0].turns.length,1);
});

test('supervisor aceita apenas scopes exclusivos e vigia o dono sem corte temporal',async()=>{
 const supervisor=new ProcessSupervisor();await assert.rejects(supervisor.stop('outro-servico.scope'),/inválido/);assert.throws(()=>supervisor.wrap('agent',[],'outro.scope'),/inválida/);
 const unit='hydraq-col-worker-'+randomUUID()+'.scope',wrapped=supervisor.wrap('agent',['--sandbox','enabled','acp'],unit);assert.equal(wrapped.executable,'/usr/bin/systemd-run');assert.ok(wrapped.args.includes('--unit='+unit));assert.ok(wrapped.args.some(a=>a.endsWith('/supervised-process.mjs')));assert.ok(!wrapped.args.some(a=>a.includes('RuntimeMaxSec')));
});

test('autorização é visível e só a decisão da sessão certa desbloqueia o executor',async t=>{
 const {hub,create,send,api}=await setup(t),s=await create(),other=await create();await send(s,'COL_APPROVAL');await wait(()=>hub.collaboration.detail(s.id).approvals.length===1);const request=hub.collaboration.detail(s.id).approvals[0];assert.equal(request.role,'executor');assert.equal(hub.collaboration.session(s.id).jobs[0].status,'running');
 assert.equal((await api(`/api/collaborations/${other.id}/respond`,{id:request.id,optionId:'allow'})).status,400);assert.equal((await api(`/api/collaborations/${s.id}/respond`,{id:request.id,optionId:'allow'})).status,200);await wait(()=>hub.collaboration.session(s.id).status==='completed');assert.match(hub.collaboration.detail(s.id).messages.at(-1).text,/autorização confirmada/);
});

test('autorização não expira e aparece no catálogo; parar conserva a causa da espera',async t=>{
 const {hub,clients,create,send}=await setup(t),s=await create();await send(s,'COL_APPROVAL');await wait(()=>hub.collaboration.detail(s.id).approvals.length===1);
 const session=hub.collaboration.session(s.id);session.cycles[0].deadline=session.jobs[0].deadline=Date.now()-86400000;
 await hub.collaboration.serial(()=>hub.collaboration.advance());assert.equal(hub.collaboration.snapshot().sessions[0].pendingDecisions,1);assert.equal(clients.executor.conversations[0].status,'waiting');assert.equal(session.status,'executor');
 await hub.collaboration.interrupt(s.id);const d=hub.collaboration.detail(s.id);assert.equal(d.approvals.length,0);assert.equal(d.jobs[0].interruption.waiting.role,'executor');assert.equal(d.jobs[0].error,'Interrompido pelo utilizador.');assert.equal(clients.principal.conversations[0].turns.length,1);
});

const reviewer={provider:'claude',model:'opus',effort:'medium'};
test('revisor só arranca após executor, entrega parecer uma vez e preserva IDs do principal',async t=>{
 const {hub,clients,create,send}=await setup(t),s=await create({reviewer});await send(s);await wait(()=>hub.collaboration.session(s.id).status==='completed');const d=hub.collaboration.detail(s.id);
 assert.equal(d.reviews.length,1);assert.equal(d.reviews[0].resultDelivery,'confirmed');assert.equal(d.jobs[0].resultDelivery,'confirmed');assert.equal(d.reviews[0].cleanup,'confirmed');assert.ok(Date.parse(d.reviews[0].startedAt)>=Date.parse(d.jobs[0].completedAt));assert.match(d.messages.at(-1).text,/PARECER-INDEPENDENTE/);assert.equal(clients.principal.conversations.length,1);assert.equal(clients.principal.conversations[0].turns.length,2);assert.equal(clients.reviewer.conversations[0].sandbox,'plan');assert.equal(hub.snapshot().conversations.length,0);assert.equal(d.cycles[0].metrics.principalUsage.inputTokens,20);assert.equal(d.cycles[0].metrics.principalUsage.measuredTurns,2);
 const other=await create();await send(other,'COL_DIRECT');await wait(()=>hub.collaboration.session(other.id).status==='completed');assert.equal(clients.reviewer.conversations.length,1);
});
test('correção depois do parecer recebe nova revisão independente e respeita limite',async t=>{
 const {hub,clients,create,send}=await setup(t),s=await create({reviewer});await send(s,'COL_LOOP');await wait(()=>hub.collaboration.session(s.id).status==='completed');const d=hub.collaboration.detail(s.id);assert.equal(d.jobs.length,2);assert.equal(d.reviews.length,2);assert.equal(new Set(d.reviews.map(r=>r.conversationId)).size,2);assert.equal(clients.principal.conversations[0].turns.length,3);
 assert.ok(d.reviews.every(r=>r.resultDelivery==='confirmed'));assert.ok(d.reviews.every(r=>r.cleanup==='confirmed'));
});
test('parar revisão conserva parcial e bloqueia entrega automática de avaliação',async t=>{
 const {hub,clients,create,send}=await setup(t),s=await create({reviewer});await send(s,'COL_REVIEW_HOLD');await wait(()=>clients.reviewer.conversations[0]?.messages.some(m=>m.text==='PARECER-PARCIAL'));
 await hub.collaboration.interrupt(s.id);const d=hub.collaboration.detail(s.id);assert.equal(d.status,'interrupted');assert.equal(d.reviews[0].partial,'PARECER-PARCIAL');assert.equal(d.reviews[0].cleanup,'confirmed');assert.equal(d.jobs[0].status,'completed');assert.equal(clients.principal.conversations[0].turns.length,1);
});
test('falha ou perda do revisor não é aprovação nem reenviada',async t=>{
 const {hub,clients,create,send}=await setup(t),s=await create({reviewer});await send(s,'COL_REVIEW_FAIL');await wait(()=>hub.collaboration.session(s.id).status==='completed');assert.equal(hub.collaboration.detail(s.id).jobs[0].status,'completed');assert.equal(hub.collaboration.detail(s.id).reviews[0].status,'failed');assert.equal(clients.principal.conversations[0].turns.length,2);
 const other=await create({reviewer});await send(other,'COL_REVIEW_LOST');await wait(()=>hub.collaboration.session(other.id).status==='uncertain');await assert.rejects(send(other,'COL_DIRECT'),/incerto/);assert.equal(hub.collaboration.detail(other.id).reviews[0].partial,'PARECER-INCERTO');
});
test('reinício durante revisão conserva parecer parcial e não repete os três clientes',async t=>{
 const first=await setup(t),s=await first.create({reviewer});await first.send(s,'COL_REVIEW_HOLD');await wait(()=>first.clients.reviewer.conversations[0]?.messages.some(m=>m.text==='PARECER-PARCIAL'));await first.close();
 const next=await setup(t,first.dir),d=next.hub.collaboration.detail(s.id);assert.equal(d.status,'uncertain');assert.equal(d.reviews[0].partial,'PARECER-PARCIAL');assert.equal(d.reviews[0].cleanup,'confirmed');assert.equal(next.clients.reviewer.conversations.length,1);assert.equal(next.clients.reviewer.conversations[0].turns.length,1);assert.equal(next.clients.principal.conversations[0].turns.length,1);await next.close();
});

test('parecer não pode ser consultado por outra colaboração e modelo inválido falha antes da inferência',async t=>{
 const {hub,clients,create,send}=await setup(t);await assert.rejects(create({reviewer:{provider:'claude',model:'inexistente',effort:'medium'}}),/revisão/);assert.equal(clients.principal.conversations.length,0);
 const a=await create({reviewer});await send(a);await wait(()=>hub.collaboration.session(a.id).status==='completed');const id=hub.collaboration.detail(a.id).reviews[0].id;
 const b=await create();await send(b,'COL_GATE');await wait(()=>hub.collaboration.session(b.id).jobs.length===1);await assert.rejects(hub.collaboration.tool(clients.principal.lastToken,'get_review_result',{reviewId:id}),/fora/);await hub.collaboration.interrupt(b.id);
});

test('falha antes de criar turno do Grok nunca reutiliza o sucesso anterior',async t=>{
 const {hub,clients,create,send}=await setup(t),s=await create();await send(s);await wait(()=>hub.collaboration.session(s.id).status==='completed');
 clients.executor.send=async()=>{throw Error('Preparação recusada antes do turno');};
 await send(s,'Novo trabalho');await wait(()=>hub.collaboration.session(s.id).status==='completed');
 const j=hub.collaboration.detail(s.id).jobs.at(-1);assert.equal(j.status,'failed');assert.equal(j.result,undefined);assert.match(j.error,/Preparação recusada/);assert.equal(j.resultDelivery,'confirmed');
});

test('limite de turnos conserva resultados pendentes e não declara conclusão',async t=>{
 const {hub,clients,create,send}=await setup(t),s=await create();await send(s,'COL_GATE');await wait(()=>clients.principal.duplicate);
 hub.collaboration.session(s.id).cycles[0].maxPrincipalTurns=1;await clients.principal.finish(clients.principal.conversations[0],'Deleguei');
 await wait(()=>hub.collaboration.session(s.id).status==='limited');const d=hub.collaboration.detail(s.id);assert.equal(d.jobs[0].status,'completed');assert.equal(d.jobs[0].resultDelivery,'pending');assert.match(d.error,/por avaliar/);
});

test('memória do principal é citada, não repete e regressa após compactação inclusive no reporting',async t=>{
 const {dir,hub,clients,create,send}=await setup(t),p=await hub.createProject({name:'A',root:dir,revision:0}),s=await create({projectId:p.id});
 await hub.saveProjectMemory(p.id,{revision:0,text:'Decisão <texto> "citado"'});await send(s,'COL_DIRECT');await wait(()=>hub.collaboration.session(s.id).status==='completed');
 const c=clients.principal.conversations[0];assert.match(c.messages[0].projectContext,/<hydraq_project_context>/);assert.match(c.messages[0].projectContext,/\\u003ctexto/);assert.equal(c.turns[0].projectDelivery.epoch,0);
 await send(s,'COL_WORKER_HOLD');await wait(()=>clients.executor.conversations[0]?.messages.some(m=>m.text==='PARCIAL-REAL-DO-TESTE'));assert.equal(c.messages.findLast(m=>m.role==='user').projectContext,undefined);
 c.contextEpoch=1;await clients.executor.finish(clients.executor.conversations[0],'Fim');await wait(()=>hub.collaboration.session(s.id).status==='completed');
 const last=c.messages.findLast(m=>m.role==='user');assert.match(last.projectContext,/Memória curada/);assert.equal(c.turns.at(-1).projectDelivery.epoch,1);
 await send(s,'COL_DIRECT');await wait(()=>hub.collaboration.session(s.id).status==='completed');assert.equal(c.messages.findLast(m=>m.role==='user').projectContext,undefined);
});

test('entrega falhada ao principal não cobre memória nova nem perde resultado para continuação explícita',async t=>{
 const {dir,hub,clients,create,send}=await setup(t),p=await hub.createProject({name:'A',root:dir,revision:0}),s=await create({projectId:p.id});
 await hub.saveProjectMemory(p.id,{revision:0,text:'Antiga'});await send(s,'COL_WORKER_HOLD');await wait(()=>clients.executor.conversations[0]?.messages.some(m=>m.text==='PARCIAL-REAL-DO-TESTE'));
 await hub.saveProjectMemory(p.id,{revision:1,text:'NOVA-NAO-ENTREGUE'});const original=clients.principal.send.bind(clients.principal);clients.principal.send=async(...args)=>{if(args[3]?.internal==='collaboration-result')throw Error('Entrega falhou');return original(...args);};
 await clients.executor.finish(clients.executor.conversations[0],'TRABALHO-CONSERVADO');await wait(()=>hub.collaboration.session(s.id).status==='uncertain');
 clients.principal.send=original;await hub.collaboration.acknowledge(s.id);await send(s,'COL_DIRECT');await wait(()=>hub.collaboration.session(s.id).status==='completed');
 const c=clients.principal.conversations[0];assert.match(c.messages.findLast(m=>m.role==='user').projectContext,/NOVA-NAO-ENTREGUE/);assert.match(clients.principal.lastPrompt,/TRABALHO-CONSERVADO/);assert.equal(clients.executor.conversations[0].turns.length,1);
});

test('falha tratada dentro da fila: confirmar logo a seguir espera pelo fim da paragem e não grava ao mesmo tempo',async t=>{
 const {hub,clients,create,send}=await setup(t),s=await create();
 await send(s,'COL_WORKER_HOLD');await wait(()=>clients.executor.conversations[0]?.messages.some(m=>m.text==='PARCIAL-REAL-DO-TESTE'));
 const original=clients.principal.send.bind(clients.principal);clients.principal.send=async(...args)=>{if(args[3]?.internal==='collaboration-result')throw Error('Entrega falhou');return original(...args);};
 // Stopping the clients takes a while, as real processes do; «uncertain» is visible before it ends. Before the
 // fix, the late stop closed the principal in the middle of the next request.
 const close=clients.principal.close.bind(clients.principal);clients.principal.close=async()=>{await new Promise(r=>setTimeout(r,200));return close();};
 await clients.executor.finish(clients.executor.conversations[0],'TRABALHO-CONSERVADO');await wait(()=>hub.collaboration.session(s.id).status==='uncertain');
 clients.principal.send=original;await hub.collaboration.acknowledge(s.id);
 assert.ok(!hub.collaboration.error,hub.collaboration.error);assert.equal(hub.collaboration.session(s.id).status,'interrupted');
 // The next request is still running when the old stop would have ended: it must keep running.
 const next=await send(s,'COL_PARENT_HOLD'),principal=()=>clients.principal.conversations.find(c=>c.turns.some(t=>t.requestId===hub.collaboration.session(s.id).cycles.at(-1)?.nativeRequestId));
 await wait(()=>principal()?.status==='running');await new Promise(r=>setTimeout(r,350));
 assert.equal(principal().status,'running');assert.ok(!hub.collaboration.error,hub.collaboration.error);assert.ok(next);
 await clients.principal.finish(principal(),'Resposta direta');await wait(()=>hub.collaboration.session(s.id).status==='completed');
});

test('índice comum usa só estado da colaboração, exclui a própria origem e permite importar para conversa',async t=>{
 const {dir,hub,clients,normal,create,send}=await setup(t),p=await hub.createProject({name:'A',root:dir,revision:0}),s=await create({projectId:p.id});await send(s);await wait(()=>hub.collaboration.session(s.id).status==='completed');
 const c=await hub.create({projectId:p.id,revision:hub.projects.data.revision,provider:'codex',model:'gpt-test',effort:'low'});
 clients.executor.conversations[0].messages.push({role:'assistant',requestId:'private',text:'SEGREDO-DO-HISTORICO-PRIVADO'});
 const list=await hub.context.query(p.id,c.id,'list_project_conversations',{});assert.equal(list.entries[0].kind,'collaboration');assert.equal(list.entries[0].groupId,'col:'+s.id);
 const read=await hub.context.query(p.id,c.id,'read_conversation_excerpt',{groupId:'col:'+s.id,requestId:hub.collaboration.session(s.id).cycles[0].requestId});assert.match(read.text,/O executor afirmou/);assert.doesNotMatch(read.text,/SEGREDO-DO-HISTORICO/);
 assert.equal((await hub.context.query(p.id,'col:'+s.id,'list_project_conversations',{})).entries.length,0);
 const preview=await hub.previewImport(p.id,{sourceGroupId:'col:'+s.id,requestIds:[read.requestId],targetGroupId:c.id});const prepared=await hub.context.prepare(normal.codex.conversation(c.id),{importId:preview.previewId});assert.match(prepared.imported.text,/EXECUTOR-RESULT/);
 const noProject=await create();await send(noProject,'COL_DIRECT');await wait(()=>hub.collaboration.session(noProject.id).status==='completed');assert.ok(!hub.context.entries(p.id).some(e=>e.groupId==='col:'+noProject.id));
 await hub.updateProject(p.id,{revision:hub.projects.data.revision,archived:true});await assert.rejects(hub.context.query(p.id,'col:'+s.id,'list_project_conversations',{}),/arquivado/);await assert.rejects(hub.previewImport(p.id,{sourceGroupId:'col:'+s.id,requestIds:[read.requestId]}),/arquivado/);
});

test('espera por autorização reserva a pasta mas permite conversa independente e conserva ambos os pedidos',async t=>{
 const {dir,hub,clients,normal,create,send}=await setup(t);await mkdir(dir+'/A');await mkdir(dir+'/B');
 const s=await create({cwd:dir+'/A'});await send(s,'COL_APPROVAL');await wait(()=>clients.executor.approvals.size===1);
 const c=await hub.create({cwd:dir+'/B',provider:'codex',model:'gpt-test',effort:'low'});await hub.send(c.id,'Independente','parallel');await wait(()=>normal.codex.conversation(c.id).status==='completed');assert.equal(hub.collaboration.session(s.id).status,'executor');
 const overlap=await hub.create({cwd:dir+'/A',provider:'codex',model:'gpt-test',effort:'low'});await assert.rejects(hub.send(overlap.id,'Conflito','blocked'),e=>e.code==='WORK_RESERVED');
 await hub.collaboration.respond(s.id,{id:'executor:'+clients.executor.approvals.keys().next().value,optionId:'allow'});await wait(()=>hub.collaboration.session(s.id).status==='completed');assert.equal(normal.codex.conversation(c.id).turns.length,1);
});

test('bloqueio do catálogo reconhece dono com PID reutilizado',async t=>{
 const first=await setup(t),s=await first.create();await first.close();await writeFile(first.dataDir+'/collaboration/owner.json',JSON.stringify({pid:process.pid,instance:'stale',identity:{pid:process.pid,start:'0',boot:'old'}}));
 const next=await setup(t,first.dir);assert.equal(next.hub.collaboration.error,undefined);assert.equal(next.hub.collaboration.sessions[0].id,s.id);await next.close();
});

test('revisor recusado antes do turno entrega falha conhecida ao principal sem aprovar trabalho',async t=>{
 const {hub,clients,create,send}=await setup(t);clients.reviewer.send=async()=>{throw Error('Revisor sem ligação antes do turno');};const s=await create({reviewer});await send(s);await wait(()=>hub.collaboration.session(s.id).status==='completed');const d=hub.collaboration.detail(s.id);assert.equal(d.jobs[0].resultDelivery,'confirmed');assert.equal(d.reviews[0].status,'failed');assert.equal(d.reviews[0].resultDelivery,'confirmed');assert.match(clients.principal.lastPrompt,/Revisor sem ligação/);
});

test('proposta de memória mostra reserva e permite cliente diferente em pasta independente',async t=>{
 const {dir,hub,normal}=await setup(t);await mkdir(dir+'/A');await mkdir(dir+'/B');const p=await hub.createProject({name:'A',root:dir+'/A',revision:0});
 const c=await hub.create({projectId:p.id,revision:hub.projects.data.revision,provider:'codex',model:'gpt-test',effort:'low'});await hub.send(c.id,'Fonte da proposta','proposal-source');await wait(()=>normal.codex.conversation(c.id).status==='completed');
 let release,calls=0;hub.inspect=async()=>{if(++calls===1)await new Promise(r=>release=r);return{complete:true,files:{},warnings:[]};};const proposal=await hub.proposeMemory(p.id,{conversationId:c.id,revision:0});assert.equal(proposal.accepted,true);await wait(()=>Boolean(release));
 assert.ok(hub.snapshot().workLocks.some(l=>l.reason==='Proposta de memória em curso'));
 const same=await hub.create({cwd:dir+'/A',provider:'cursor',model:'grok-4.7',effort:'low',context:'500k',fast:false});await assert.rejects(hub.send(same.id,'Conflito','proposal-blocked'),e=>e.code==='WORK_RESERVED');
 const other=await hub.create({cwd:dir+'/B',provider:'cursor',model:'grok-4.7',effort:'low',context:'500k',fast:false});await hub.send(other.id,'Trabalho independente','proposal-parallel');await wait(()=>normal.cursor.conversation(other.id).status==='completed');
 release();await Promise.all([...hub.proposalTasks]);assert.equal(hub.reservations.size,0);assert.equal((await hub.projectMemoryProposals(p.id)).records[0].status,'ready');
});

test('API de colaboração inclui progresso público do executor e revisão no chat sem criar turnos adicionais',async t=>{
 const {hub,clients,create,send}=await setup(t),s=await create({reviewer});await send(s);await wait(()=>hub.collaboration.session(s.id).status==='completed');
 const d=hub.collaboration.detail(s.id),messages=d.timeline.filter(m=>m.kind==='message');
 assert.ok(messages.some(m=>m.role==='executor'&&m.text.includes('EXECUTOR-RESULT')));assert.ok(messages.some(m=>m.role==='reviewer'&&m.text.includes('PARECER-INDEPENDENTE')));
 assert.equal(messages.at(-1).role,'principal');assert.equal(clients.principal.conversations[0].turns.length,2);assert.equal(clients.executor.conversations[0].turns.length,1);assert.equal(clients.reviewer.conversations[0].turns.length,1);
 const hold=await create();await send(hold,'COL_WORKER_HOLD');await wait(()=>hub.collaboration.detail(hold.id).timeline.some(m=>m.role==='executor'&&m.text==='PARCIAL-REAL-DO-TESTE'));
 assert.equal(hub.collaboration.detail(hold.id).jobs[0].result,undefined);await hub.collaboration.interrupt(hold.id);
 assert.ok(hub.collaboration.detail(hold.id).timeline.some(m=>m.role==='executor'&&m.text==='PARCIAL-REAL-DO-TESTE'));
});
