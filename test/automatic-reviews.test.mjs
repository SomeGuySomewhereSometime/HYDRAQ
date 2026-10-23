import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {Providers} from '../lib/providers.mjs';
import {AutomaticReviews,reviewReason} from '../lib/automatic-reviews.mjs';
import {OpinionClient} from './fixtures/opinion-client.mjs';
import {createHttpServer} from '../lib/http.mjs';
const wait=async f=>{const end=Date.now()+7000;while(!f()){if(Date.now()>end)throw Error('Timeout');await new Promise(r=>setTimeout(r,10));}};
const config=(overrides={})=>({trigger:'all',scope:'request',returnToPrincipal:true,participant:{provider:'claude',model:'test',effort:'low'},focus:'Verifica os limites',...overrides});
const pending=r=>['waiting-main','preparing','reviewing','delivering','assessing'].includes(r?.status);
async function setup(t,{review='success',files=[],principal='success',decisions}={}){
 const root=await mkdtemp('/tmp/hydraq-auto-review-test-'),workers=[];
 const main=new OpinionClient('codex',root+'/codex',{behavior:principal});
 const finish=main.finish.bind(main);main.finish=(c,text)=>{const turn=c.turns.at(-1);turn.model=c.model;turn.effort=c.effort;turn.sandbox=c.sandbox;turn.facts={version:2,files,commands:[],declined:0};finish(c,text);};
 const clients={codex:main,claude:new OpinionClient('claude',root+'/claude'),antigravity:new OpinionClient('antigravity',root+'/agy'),cursor:new OpinionClient('cursor',root+'/cursor'),opencode:new OpinionClient('opencode',root+'/oc')};
 const hub=new Providers({dataDir:root+'/hub',defaultCwd:root,clients,opinionSupervisor:{available:async()=>({available:true}),stop:async()=>{}},opinionClientFactory:async({job,directory,cwd})=>{const client=new OpinionClient(job.provider,directory,{behavior:typeof review==='string'?review:review[job.provider]||'success'});if(decisions!==undefined){const value=typeof decisions==='function'?decisions(job):decisions[job.provider];client.answer=typeof value==='string'?value:value===undefined?'PARECER-'+job.provider:'PARECER-'+job.provider+'\n<hydraq_review_decision request="'+job.decisionToken+'">\n'+JSON.stringify({sendToPrincipal:value,reason:value?'Erro concreto encontrado':'Sem melhoria relevante para o principal'})+'\n</hydraq_review_decision>';}await client.load();workers.push(client);return{client,cwd,sandbox:job.provider==='codex'?'read-only':'plan'};},git:async()=>null});await hub.load();
 const c=await main.create({cwd:root,model:'test',effort:'high',sandbox:'workspace-write'});
 t.after(async()=>{await hub.close();await rm(root,{recursive:true,force:true});});return {root,hub,c,main,workers};
}
const send=(hub,c,id,review)=>hub.send(c.id,'Implementa ou analisa este objetivo',id,{model:'test',effort:'high',sandbox:c.sandbox,autoReview:review});

test('um pedido revisto volta uma vez ao principal, sem ciclo recursivo',async t=>{const{hub,c,main,workers}=await setup(t);await send(hub,c,'one',config());await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');assert.equal(main.logs.length,2);assert.equal(workers.length,1);assert.equal(hub.opinions.batches.length,1);assert.match(main.logs[1].text,/PARECER-claude/);assert.equal(c.model,'test');assert.equal(c.effort,'high');assert.equal(c.sandbox,'workspace-write');assert.equal(hub.automaticReviews.scopes().length,0);});
test('revisão de código inspeciona implementação e recebe ficheiros observados',async t=>{const{hub,c,workers}=await setup(t,{files:['src/game.js']});await send(hub,c,'code',config({trigger:'implementation',returnToPrincipal:false}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');assert.match(workers[0].logs[0].text,/implementação real no disco/);assert.match(workers[0].logs[0].text,/src\/game.js/);assert.equal(c.turns.length,1);});
test('só código dispensa pedido sem alterações observadas',async t=>{const{hub,c,workers}=await setup(t);await send(hub,c,'no-code',config({trigger:'implementation'}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='skipped');assert.equal(workers.length,0);assert.match(hub.automaticReviews.cycles[0].reason,/Não foram observadas/);});
test('só plano revê só leitura e mantém as permissões na avaliação',async t=>{const{hub,c,main,workers}=await setup(t);c.sandbox='read-only';await send(hub,c,'plan',config({trigger:'plan'}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');assert.match(workers[0].logs[0].text,/Critica o plano/);assert.equal(main.logs[1].settings.sandbox,'read-only');});
test('só plano não corre num pedido em execução/escrita',async t=>{const{hub,c,workers}=await setup(t);await send(hub,c,'execution',config({trigger:'plan'}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='skipped');assert.equal(workers.length,0);});
test('configuração de conversa persiste e pode ser desligada',async t=>{const{hub,c,main}=await setup(t);await hub.automaticReviews.policy(c.id,config({scope:'conversation'}));await hub.send(c.id,'Objetivo','persist');await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');const saved=JSON.parse(await readFile(hub.opinions.directory+'/state.json','utf8'));assert.equal(saved.automatic.policies[c.id].trigger,'all');await hub.automaticReviews.policy(c.id,null);await hub.send(c.id,'Outro objetivo','disabled');await wait(()=>c.status==='completed');assert.equal(hub.automaticReviews.cycles.length,1);assert.equal(main.logs.length,3);});
test('configuração só no pedido não ativa pedidos posteriores',async t=>{const{hub,c}=await setup(t);await send(hub,c,'once',config({returnToPrincipal:false}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');await hub.send(c.id,'Sem revisor','next');await wait(()=>c.status==='completed');assert.equal(hub.automaticReviews.cycles.length,1);assert.equal(hub.automaticReviews.policies[c.id],undefined);});
test('falha do revisor preserva o original e não equivale a aprovação',async t=>{const{hub,c,main}=await setup(t,{review:'pre-fail'});await send(hub,c,'failure',config());await wait(()=>hub.automaticReviews.cycles[0]?.status==='failed');assert.equal(main.logs.length,1);assert.match(hub.automaticReviews.cycles[0].error,/Falha não é aprovação/);assert.equal(hub.opinions.batches[0].jobs[0].status,'failed');});
test('parar durante autorização cancela o revisor sem reenviar ao principal',async t=>{const{hub,c,main}=await setup(t,{review:'permission'});await send(hub,c,'permission',config());await wait(()=>hub.opinions.batches[0]?.jobs[0].approvals?.length);const r=hub.automaticReviews.cycles[0];await hub.automaticReviews.cancel(r.id);await wait(()=>!hub.automaticReviews.tasks.size);assert.equal(r.status,'cancelled');assert.equal(main.logs.length,1);assert.equal(hub.opinions.batches[0].jobs[0].status,'interrupted');});
test('repetir o envio original não cria outra revisão',async t=>{const{hub,c,workers}=await setup(t);await send(hub,c,'same',config({returnToPrincipal:false}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');await send(hub,c,'same',config({returnToPrincipal:false}));assert.equal(workers.length,1);assert.equal(hub.automaticReviews.cycles.length,1);});
test('configuração inválida é recusada antes da inferência principal',async t=>{const{hub,c,main}=await setup(t);await assert.rejects(send(hub,c,'invalid',config({trigger:'guess'})),/inválida/);assert.equal(main.logs.length,0);});
test('falha de gravação antes de armar impede inferência',async t=>{const{hub,c,main}=await setup(t);const persist=hub.opinions.persist;hub.opinions.persist=async()=>{throw Error('Disco cheio');};await assert.rejects(send(hub,c,'disk',config()),/Disco cheio/);hub.opinions.persist=persist;assert.equal(main.logs.length,0);assert.equal(hub.automaticReviews.cycles.length,0);});
test('reinício suspende revisões por concluir e nunca recomeça o histórico',async t=>{const{hub}=await setup(t);const automatic=new AutomaticReviews(hub);automatic.restore({policies:{},cycles:[{id:'old',status:'reviewing',conversationId:'missing',config:config(),settings:{}}]});await automatic.load();assert.equal(automatic.cycles[0].status,'suspended');automatic.changed();await new Promise(r=>setTimeout(r,30));assert.equal(automatic.tasks.size,0);await automatic.close();});
test('classificação não infere implementação a partir de palavras ou comandos',()=>{assert.match(reviewReason(config({trigger:'implementation'}),{status:'completed',sandbox:'workspace-write'},{files:[],commands:[{command:'escrever código'}]}),/Não foram observadas/);assert.match(reviewReason(config({trigger:'plan'}),{status:'completed',sandbox:'plan'},{files:['changed.js']}),/alterações observadas/);});

test('retorno interrompido não é repetido nem revisto novamente',async t=>{const{hub,c,main}=await setup(t);const sendOriginal=main.send.bind(main);main.send=async(...args)=>{if(main.logs.length===1)main.behavior='hold';return sendOriginal(...args);};await send(hub,c,'interrupted-return',config());await wait(()=>hub.automaticReviews.cycles[0]?.status==='assessing');await main.interrupt(c.id);await wait(()=>hub.automaticReviews.cycles[0]?.status==='failed');assert.equal(main.logs.length,2);assert.equal(hub.opinions.batches.length,1);});
test('mensagens em fila aguardam revisão e avaliação do principal',async t=>{const{hub,c,main}=await setup(t,{principal:'hold'});await send(hub,c,'queued-original',config());const turnId=c.turnId;await hub.followups.enqueue(c.id,'Depois da revisão','queued-after',turnId,'queue');main.behavior='success';main.finish(c,'Resposta original');await wait(()=>main.logs.length===3&&c.status==='completed');assert.equal(main.logs[1].requestId,hub.automaticReviews.cycles[0].returnRequestId);assert.equal(main.logs[2].requestId,'queued-after');});
test('modo explícito manual de implementação não altera o modo de outra resposta',async t=>{const{hub,c,main,workers}=await setup(t);await hub.send(c.id,'Pedido simples','manual');await wait(()=>c.status==='completed');const message=c.messages.at(-1);await hub.opinions.create(c.id,{requestId:'manual-code',messageKey:message.id,participants:[config().participant],reviewMode:'implementation'});await wait(()=>!hub.opinions.tasks.size);assert.match(workers[0].logs[0].text,/implementação real no disco/);assert.equal(main.logs.length,1);});

test('passagem de cliente conserva o grupo e revê apenas o pedido no destino',async t=>{const{hub,c,workers}=await setup(t);const result=await hub.send(c.id,'Pedido no Claude','switch-review',{provider:'claude',model:'test',effort:'low',sandbox:'plan',autoReview:config({trigger:'plan',participant:{provider:'opencode',model:'test',effort:'low'}})});await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');const cycle=hub.automaticReviews.cycles[0];assert.equal(cycle.conversationId,result.conversationId);assert.equal(cycle.groupId,c.id);assert.equal(cycle.provider,'claude');assert.equal(workers.length,1);assert.equal(hub.clients.claude.logs.length,2);});

test('HTTP conserva a configuração do pedido e protege alterações da política',async t=>{
 const{hub,c,main}=await setup(t);const server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeStreams();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/bootstrap')).json();
 const post=(route,body,authenticated=true)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...(authenticated?{'x-hydraq-token':token}:{})},body:JSON.stringify(body)});
 assert.equal((await post(`/api/conversations/${c.id}/review-policy`,{config:config()},false)).status,403);
 assert.equal(Object.keys(hub.automaticReviews.policies).length,0);
 const response=await post(`/api/conversations/${c.id}/send`,{text:'Objetivo',requestId:'http-auto',model:'test',effort:'high',sandbox:'workspace-write',autoReview:config()});
 assert.equal(response.status,200);await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');assert.equal(main.logs.length,2);
 assert.equal((await post(`/api/conversations/${c.id}/review-policy`,{config:config({scope:'conversation'})})).status,200);
 assert.equal(hub.automaticReviews.policies[c.id].scope,'conversation');
 assert.equal((await post(`/api/conversations/${c.id}/review-policy`,{config:null})).status,200);assert.equal(hub.automaticReviews.policies[c.id],undefined);
});

test('cancelamento durante preparação não inicia um retorno ao principal',async t=>{
 const{hub,c,main}=await setup(t);const create=hub.opinions.create.bind(hub.opinions);let release;const gate=new Promise(r=>{release=r;});let preparing=false;
 hub.opinions.create=async(...args)=>{preparing=true;await gate;return create(...args);};
 await send(hub,c,'cancel-preparing',config());await wait(()=>preparing);const r=hub.automaticReviews.cycles[0];await hub.automaticReviews.cancel(r.id);release();
 await wait(()=>!hub.automaticReviews.tasks.size);assert.equal(r.status,'cancelled');assert.equal(main.logs.length,1);assert.equal(hub.opinions.batches[0].jobs[0].status,'interrupted');
});

test('dois revisores independentes recebem acesso de leitura e voltam juntos uma única vez',async t=>{
 const{hub,c,main,workers}=await setup(t,{files:['game.js']});
 const participants=[{provider:'claude',model:'test',effort:'low'},{provider:'antigravity',model:'test',effort:'high'}];
 await send(hub,c,'two-reviewers',config({trigger:'implementation',participants}));
 await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');
 assert.equal(workers.length,2);assert.equal(main.logs.length,2);assert.equal(hub.opinions.merges.length,1);
 assert.equal(hub.opinions.merges[0].jobIds.length,2);
 for(const worker of workers){assert.equal(worker.logs[0].settings.sandbox,'plan');assert.match(worker.logs[0].text,/não autoriza o revisor a editar/);assert.doesNotMatch(worker.logs[0].text,/PARECER-claude|PARECER-antigravity/);}
 assert.equal(workers[0].logs[0].text,workers[1].logs[0].text);
 assert.match(main.logs[1].text,/PARECER-claude/);assert.match(main.logs[1].text,/PARECER-antigravity/);assert.equal(main.logs[1].settings.sandbox,'workspace-write');
 assert.equal(hub.automaticReviews.cycles.length,1);
});
test('pareceres manuais ficam separados e apenas os selecionados entram sem nova revisão',async t=>{
 const{hub,c,main}=await setup(t);const participants=[{provider:'claude',model:'test',effort:'low'},{provider:'cursor',model:'test',effort:'low'}];
 await send(hub,c,'manual-team',config({scope:'conversation',participants,returnToPrincipal:false}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');
 const batch=hub.opinions.batches[0];assert.equal(main.logs.length,1);assert.equal(hub.opinions.merges.length,0);
 await hub.opinions.incorporate(c.id,{jobIds:[batch.jobs[1].id],requestId:'pick-one-review',comment:'Avalia só este parecer',settings:{model:'test',effort:'high',sandbox:'workspace-write'}});
 await wait(()=>c.status==='completed');await new Promise(r=>setTimeout(r,50));assert.equal(main.logs.length,2);assert.match(main.logs[1].text,/PARECER-cursor/);assert.doesNotMatch(main.logs[1].text,/PARECER-claude/);assert.equal(hub.automaticReviews.cycles.length,1);assert.equal(hub.opinions.merges[0].status,'submitted');
});
test('escrita exige booleano explícito por revisor e conserva o acesso do principal',async t=>{
 const{hub,c,main,workers}=await setup(t);const participants=[{provider:'codex',model:'test',effort:'low'},{provider:'claude',model:'test',effort:'low',allowWrite:true}];
 await send(hub,c,'writer-opt-in',config({participants,returnToPrincipal:false}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');
 const reader=workers.find(w=>w.provider==='codex'),writer=workers.find(w=>w.provider==='claude');assert.equal(reader.logs[0].settings.sandbox,'read-only');assert.equal(writer.logs[0].settings.sandbox,'workspace-write');assert.match(writer.logs[0].text,/ativou explicitamente escrita/);assert.doesNotMatch(writer.logs[0].text,/Trabalha em modo Planear|Não implementes correções/);assert.equal(main.logs.length,1);assert.equal(c.sandbox,'workspace-write');
});
test('revisores de leitura avançam em paralelo e um resultado lento impede retorno prematuro',async t=>{
 const{hub,c,main,workers}=await setup(t,{review:{claude:'hold',cursor:'hold'}});const participants=['claude','cursor'].map(provider=>({provider,model:'test',effort:'low'}));
 await send(hub,c,'parallel-readers',config({participants}));await wait(()=>workers.length===2&&workers.every(w=>w.logs.length===1));
 workers[0].finish(workers[0].conversations[0],'PRIMEIRO');await wait(()=>hub.opinions.batches[0].jobs.some(j=>j.status==='completed'));assert.equal(main.logs.length,1);
 workers[1].finish(workers[1].conversations[0],'SEGUNDO');await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');assert.equal(main.logs.length,2);assert.match(main.logs[1].text,/PRIMEIRO/);assert.match(main.logs[1].text,/SEGUNDO/);
});
test('um escritor torna a equipa sequencial e parar também cancela revisores em fila',async t=>{
 const{hub,c,main,workers}=await setup(t,{review:'hold'});const participants=[{provider:'claude',model:'test',effort:'low',allowWrite:true},{provider:'cursor',model:'test',effort:'low'}];
 await send(hub,c,'serial-writer',config({participants}));await wait(()=>workers.length===1&&workers[0].logs.length===1);assert.equal(hub.opinions.batches[0].jobs[1].status,'queued');
 const r=hub.automaticReviews.cycles[0];await hub.automaticReviews.cancel(r.id);await wait(()=>!hub.automaticReviews.tasks.size);assert.equal(workers.length,1);assert.equal(main.logs.length,1);assert.ok(hub.opinions.batches[0].jobs.every(j=>j.status==='interrupted'));assert.equal(r.status,'cancelled');
});
test('falha de um revisor não aprova nem elimina o parecer concluído do outro',async t=>{
 const{hub,c,main}=await setup(t,{review:{claude:'pre-fail'}});const participants=['claude','cursor'].map(provider=>({provider,model:'test',effort:'low'}));
 await send(hub,c,'one-failed',config({participants}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='failed');assert.equal(main.logs.length,1);assert.equal(hub.opinions.merges.length,0);assert.equal(hub.opinions.batches[0].jobs.find(j=>j.provider==='cursor').text,'PARECER-cursor');
});
test('validação migra o revisor único e recusa duplicados, equipa excessiva e escrita ambígua',async t=>{
 const{hub,c,main}=await setup(t);const old=hub.automaticReviews.validate(config());assert.equal(old.participants.length,1);assert.equal(old.participants[0].allowWrite,false);
 let index=0;for(const participants of [[],[...Array(5)].map(()=>config().participant),[config().participant,config().participant],[{...config().participant,allowWrite:'true'}]]) await assert.rejects(send(hub,c,'invalid-team-'+index++,config({participants})),/revisor|revisores|repetido/);
 assert.equal(main.logs.length,0);
});

const gatedTeam=()=>['claude','antigravity'].map(provider=>({provider,model:'test',effort:'low'}));
test('modo necessário envia só o parecer recomendado e conserva o outro separado',async t=>{
 const{hub,c,main,workers}=await setup(t,{decisions:{claude:true,antigravity:false}});
 await send(hub,c,'conditional-mixed',config({returnMode:'necessary',participants:gatedTeam()}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');
 const batch=hub.opinions.batches[0],cycle=hub.automaticReviews.cycles[0];assert.equal(main.logs.length,2);assert.equal(hub.opinions.merges.length,1);assert.deepEqual(cycle.selectedJobIds,[batch.jobs[0].id]);assert.deepEqual(hub.opinions.merges[0].jobIds,[batch.jobs[0].id]);assert.match(main.logs[1].text,/PARECER-claude/);assert.doesNotMatch(main.logs[1].text,/PARECER-antigravity|hydraq_review_decision/);assert.equal(batch.jobs[1].recommendation.sendToPrincipal,false);assert.equal(batch.jobs[1].text,'PARECER-antigravity');assert.equal(hub.opinions.snapshot().batches[0].jobs[0].decisionToken,undefined);assert.notEqual(batch.jobs[0].decisionToken,batch.jobs[1].decisionToken);for(const worker of workers)assert.equal(worker.logs[0].settings.sandbox,'plan');
 await send(hub,c,'conditional-mixed',config({returnMode:'necessary',participants:gatedTeam()}));assert.equal(main.logs.length,2);assert.equal(hub.automaticReviews.cycles.length,1);
});
test('nenhum revisor recomenda envio: não chama o principal e não declara aprovação',async t=>{
 const{hub,c,main}=await setup(t,{decisions:{claude:false,antigravity:false}});await send(hub,c,'conditional-no',config({returnMode:'necessary',participants:gatedTeam()}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');assert.equal(main.logs.length,1);assert.equal(hub.opinions.merges.length,0);assert.equal(hub.automaticReviews.scopes().length,0);assert.match(hub.automaticReviews.cycles[0].reason,/não equivale a uma aprovação/);
});
test('decisões em falta ficam pendentes, libertam a reserva e permitem seleção manual',async t=>{
 const{hub,c,main}=await setup(t,{decisions:{}});await send(hub,c,'conditional-missing',config({scope:'conversation',returnMode:'necessary',participants:gatedTeam()}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='needs-decision');const batch=hub.opinions.batches[0];assert.equal(main.logs.length,1);assert.equal(hub.automaticReviews.scopes().length,0);assert.ok(batch.jobs.every(j=>j.recommendation.status==='pending'));
 await hub.opinions.incorporate(c.id,{requestId:'manual-unclear',jobIds:[batch.jobs[0].id],settings:{model:'test',effort:'high',sandbox:'workspace-write'}});await wait(()=>c.status==='completed');assert.equal(main.logs.length,2);assert.equal(hub.automaticReviews.cycles.length,1);
});
test('recomendação confirmada segue sem tratar a decisão ausente do outro como aprovação',async t=>{
 const{hub,c,main}=await setup(t,{decisions:{claude:true}});await send(hub,c,'conditional-one-missing',config({returnMode:'necessary',participants:gatedTeam()}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');assert.equal(main.logs.length,2);assert.equal(hub.automaticReviews.cycles[0].undecidedJobIds.length,1);assert.equal(hub.opinions.merges[0].jobIds.length,1);assert.match(hub.automaticReviews.cycles[0].reason,/pendente/);
});
test('falha de um participante fica pendente mas não descarta a recomendação válida do outro',async t=>{
 const{hub,c,main}=await setup(t,{review:{antigravity:'pre-fail'},decisions:{claude:true}});await send(hub,c,'conditional-one-failed',config({returnMode:'necessary',participants:gatedTeam()}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');assert.equal(main.logs.length,2);const failed=hub.opinions.batches[0].jobs[1];assert.equal(failed.status,'failed');assert.equal(failed.recommendation.status,'pending');assert.deepEqual(hub.automaticReviews.cycles[0].undecidedJobIds,[failed.id]);assert.equal(hub.opinions.merges[0].jobIds.length,1);
});
test('decisão válida é analisada antes de limitar o tamanho do parecer',async t=>{
 const{hub,c,main}=await setup(t,{decisions:job=>'PARECER-LONGO-'+('x'.repeat(25000))+'\n<hydraq_review_decision request="'+job.decisionToken+'">{"sendToPrincipal":true,"reason":"Há um erro relevante"}</hydraq_review_decision>'});await send(hub,c,'conditional-long',config({returnMode:'necessary'}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');const job=hub.opinions.batches[0].jobs[0];assert.equal(job.recommendation.sendToPrincipal,true);assert.ok(job.text.length<25000);assert.match(job.text,/Excerto limitado/);assert.equal(main.logs.length,2);
});
test('modo de envio novo persiste, conserva modos antigos e recusa modos desconhecidos antes do envio',async t=>{
 const{hub,c,main}=await setup(t);assert.equal(hub.automaticReviews.validate(config()).returnMode,'always');assert.equal(hub.automaticReviews.validate(config({returnToPrincipal:false})).returnMode,'manual');const next={trigger:'all',scope:'conversation',returnMode:'necessary',participants:gatedTeam()};await hub.automaticReviews.policy(c.id,next);const saved=JSON.parse(await readFile(hub.opinions.directory+'/state.json','utf8'));assert.equal(saved.automatic.policies[c.id].returnMode,'necessary');await assert.rejects(send(hub,c,'bad-mode',config({returnMode:'guess'})),/inválida/);assert.equal(main.logs.length,0);
});
test('retorno condicional interrompido não é reenviado e reinício não repete recomendações',async t=>{
 const{hub,c,main}=await setup(t,{decisions:{claude:true}});const original=main.send.bind(main);main.send=async(...args)=>{if(main.logs.length===1)main.behavior='hold';return original(...args);};await send(hub,c,'conditional-interrupted',config({returnMode:'necessary'}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='assessing');
 const copy=JSON.parse(JSON.stringify(hub.automaticReviews.state()));const recovered=new AutomaticReviews(hub);recovered.restore(copy);await recovered.load();assert.equal(recovered.cycles[0].status,'suspended');await recovered.close();await main.interrupt(c.id);await wait(()=>hub.automaticReviews.cycles[0]?.status==='failed');assert.equal(main.logs.length,2);assert.equal(hub.opinions.merges.length,1);
});

test('justificação e parecer são filtrados depois de ler a decisão, sem perder a classificação',async t=>{
 const fakeSecret='sk-'+('a'.repeat(30));const{hub,c,main}=await setup(t,{decisions:job=>'PARECER com '+fakeSecret+'\n<hydraq_review_decision request="'+job.decisionToken+'">'+JSON.stringify({sendToPrincipal:true,reason:'Foi encontrado API_KEY='+fakeSecret})+'</hydraq_review_decision>'});await send(hub,c,'conditional-redaction',config({returnMode:'necessary'}));await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');const job=hub.opinions.batches[0].jobs[0];assert.equal(job.recommendation.sendToPrincipal,true);assert.ok(!JSON.stringify(hub.opinions.snapshot()).includes(fakeSecret));assert.ok(!main.logs[1].text.includes(fakeSecret));
});

test('síntese automática pede resposta completa e respeita o formato e permissões originais',async t=>{
 const{hub,c,main}=await setup(t);c.sandbox='read-only';
 await hub.send(c.id,'Compara JSON e SQLite em três frases. Responde apenas à comparação.','full-answer',{model:'test',effort:'high',sandbox:'read-only',autoReview:config({trigger:'plan'})});
 await wait(()=>hub.automaticReviews.cycles[0]?.status==='completed');const prompt=main.logs[1].text;
 assert.match(prompt,/resposta final completa e autónoma/);assert.match(prompt,/não te limites a comentar as críticas/);assert.match(prompt,/incluindo pedidos para responder apenas/);assert.match(prompt,/cliente\/modelo que as sugeriu/);assert.match(prompt,/Compara JSON e SQLite em três frases/);assert.match(prompt,/não atribuas sugestões que não recebeste/);
 assert.equal(main.logs[1].settings.sandbox,'read-only');assert.equal(hub.automaticReviews.cycles.length,1);assert.equal(main.logs.length,2);
});
