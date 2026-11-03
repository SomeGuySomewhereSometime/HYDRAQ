import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdtemp,mkdir,writeFile,readFile,rename,rm,symlink,link,readlink,stat,readdir,appendFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Providers} from '../lib/providers.mjs';
import {ClaudeX,hydraReturnNote} from '../lib/claudex.mjs';
import {OpinionClient} from './fixtures/opinion-client.mjs';
import {noBwrap} from './fixtures/sandbox.mjs';
import {runValidation,validationSnapshot,sourceFingerprint} from '../lib/hydra-validation.mjs';
import {hydraPolicy,decide} from '../lib/antigravity-guard.mjs';

const wait=async(fn)=>{const end=Date.now()+10000;while(!fn()){if(Date.now()>end)throw Error('Timeout');await new Promise(r=>setTimeout(r,20));}};
async function setup(t,extra={}){
 const root=await mkdtemp('/tmp/hydra-flow-'),cwd=root+'/project';await mkdir(cwd);await writeFile(cwd+'/value.txt','before');await extra.prepare?.({root,cwd});
 if(extra.dataLink){await mkdir(root+'/dados-reais');await symlink(root+'/dados-reais',root+'/hub');}
 const clients=Object.fromEntries(['codex','claude','antigravity'].map(k=>[k,new OpinionClient(k,root+'/'+k,{behavior:'hold'})]));
 const hub=new Providers({dataDir:root+'/hub',defaultCwd:cwd,clients,git:async()=>[]});await hub.load();const cx=hub.claudex;cx.endpoint('http://127.0.0.1:1/api/claudex/tools');
 t.after(async()=>{await hub.close();await rm(root,{recursive:true,force:true});});
 const roles=extra.roles||Object.keys(clients),request='Implementa a alteração de value.txt para after e testa.';
 const place=extra.conversation?{conversationId:(await hub.create({provider:'codex',cwd,model:'test',effort:'low',sandbox:'workspace-write'})).id}:{};
 const {task}=await cx.create({cwd,text:request,requestId:randomUUID(),roles,members:Object.fromEntries(roles.map(k=>[k,{model:'test',effort:'low'}])),...place,...extra});
 const r=cx.record(task.id);await wait(()=>roles.every(k=>cx.native(r,k).status==='running'));
 const raw=(role,name,args={})=>cx.tool([...cx.leases].find(([,l])=>l.role===role&&l.taskId===r.id)?.[0],name,args);
 // An approval has to have seen the changes; only the tests about that rule skip this.
 const readAll=async role=>{let page=await raw(role,'read_changes');while(!page.readComplete)page=await raw(role,'read_changes',{offset:page.remaining.offset??0,fileOffset:page.remaining.fileOffset??0});return page;};
 const call=async(role,name,args={})=>{if(name==='submit_review'&&args.decision==='approve'&&r.workflow.changes?.file)await readAll(role);return raw(role,name,args);};
 const read=role=>call(role,'read_dialogue');
 const finish=()=>{for(const k of roles)clients[k].finish(cx.native(r,k),'Terminado.');};
 // In finalizing only the principal has a turn until there is a conclusion: the reviewers are ready already.
 const phase=async p=>{await wait(()=>r.workflow.phase===p&&roles.filter(k=>!['implementing','fixing','finalizing'].includes(p)||k===r.author).every(k=>cx.native(r,k).status==='running'));};
 const turn=role=>wait(()=>cx.native(r,role).status==='running');
 const positions=async(intent='implement')=>{for(const role of roles)await call(role,'initial_position',{text:'Posição '+role,intent,authorizationQuote:request,revision:r.revision});};
 const candidate=async()=>{for(const role of roles)if(r.ready[role]!==r.evidenceRevision){await turn(role);await call(role,'ready_to_conclude',await read(role));}return (await call(r.author,'propose_final',{...await read(r.author),text:'Plano aprovado: alterar value.txt e verificar o seu conteúdo.'})).candidate;};
 const vote=async(c,role,decision='approve')=>{await turn(role);return call(role,'review_final',{...await read(role),candidateId:c.id,hash:c.hash,decision,...(decision!=='approve'?{reason:'Preferia outra solução.'}:{})});};
 const answerObjection=async(decision='keep',reason='Mantenho: a objeção não muda o que foi pedido.')=>{await wait(()=>r.workflow.objection&&cx.native(r,r.author).status==='running');return call(r.author,'answer_objection',{...await read(r.author),decision,reason});};
 const plan=async()=>{await positions();const c=await candidate();for(const role of roles)await vote(c,role,role===roles[2]?'changes':'approve');finish();if(roles.length>2){await answerObjection();finish();}await phase('implementing');return c;};
 const workplace=()=>r.workspace&&!r.workspace.removed?r.workspace.copy:cwd;
 const implemented=async()=>{await writeFile(workplace()+'/value.txt','after');await call(r.author,'implementation_done',{...await read(r.author),summary:'Alterado value.txt; verificar conteúdo.'});finish();await phase('validating');};
 const tests=async(command='test "$(cat value.txt)" = after')=>{
  const ids={};for(const role of roles)ids[role]=(await call(role,'start_test',{messageId:'check-'+r.workflow.round,command,purpose:'Verificar o valor produzido.'})).test.id;
  await wait(()=>r.workflow.tests.filter(x=>x.round===r.workflow.round).every(x=>x.status!=='running'));return ids;
 };
 return {root,cwd,hub,cx,r,roles,clients,call,raw,read,finish,phase,turn,positions,candidate,vote,answerObjection,plan,implemented,tests,place:workplace};
}

test('trio: maioria aprova plano, só principal escreve, todos testam e votam conclusão',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();
 assert.equal(x.r.workflow.approvedPlan.votes.antigravity.decision,'changes');
 for(const role of x.roles)assert.equal(x.clients[role].logs.at(-1).settings.hydraWrite,role==='codex');
 await assert.rejects(x.call('codex','propose_final',{...await x.read('codex'),text:'Sucesso prematuro'}),/antes de implementar/);
 await x.implemented();const ids=await x.tests();
 assert.ok(x.r.workflow.tests.every(t=>t.status==='passed'));
 for(const role of x.roles){assert.equal(x.clients[role].logs.at(-1).settings.hydraWrite,false);await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Conteúdo correto e teste passou.',testIds:[ids[role]]});}
 x.finish();await x.phase('finalizing');const c=await x.candidate();for(const role of x.roles)await x.vote(c,role,role==='antigravity'?'changes':'approve');x.finish();await x.answerObjection();x.finish();await wait(()=>x.r.status==='completed');
 assert.equal(x.r.result.quorum,2);assert.match(x.r.result.label,/maioria/);assert.equal(x.r.result.tests.length,3);assert.equal(x.r.workflow.rounds.length,1);
});

test('pergunta/planeamento e modo só leitura nunca autorizam execução mesmo com votos',async t=>{
 for(const extra of [{text:'Planeia a alteração, não implementes.'},{requestMode:'read-only'}]){
  const x=await setup(t,extra);await x.positions(extra.requestMode?'implement':'read-only');const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);x.finish();await wait(()=>x.r.status==='completed');
  assert.equal(x.r.workflow.authorized,false);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before');assert.ok(Object.values(x.clients).every(c=>c.logs.every(l=>!l.settings.hydraWrite)));
 }
});

test('autorização requer todos, não aceita citação inventada; dois participantes precisam de dois votos',async t=>{
 const x=await setup(t,{roles:['codex','claude']});
 await assert.rejects(x.call('codex','initial_position',{text:'Posição',intent:'implement',authorizationQuote:'ordem inventada'}),/literalmente/);
 await x.call('codex','initial_position',{text:'Posição',intent:'implement',authorizationQuote:x.r.messages[0].text});await x.call('claude','initial_position',{text:'É apenas uma análise',intent:'read-only'});
 assert.equal(x.r.workflow.authorized,false);const c=await x.candidate();await x.vote(c,'codex');x.clients.codex.finish(x.cx.native(x.r,'codex'),'Fim');await new Promise(r=>setTimeout(r,80));assert.equal(x.r.result,undefined);assert.equal(x.r.workflow.phase,'planning');
 await x.vote(c,'claude');x.clients.claude.finish(x.cx.native(x.r,'claude'),'Fim');await wait(()=>x.r.status==='completed');
});

test('falha de teste bloqueia aprovação e regressa ao principal; nova ronda invalida provas antigas',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests('test "$(cat value.txt)" = missing');
 for(const role of x.roles){await assert.rejects(x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Ignorar falha',testIds:[ids[role]]}),/falhas/);await x.call(role,'submit_review',{...await x.read(role),decision:'changes',reason:'Teste falhou.',testIds:[ids[role]]});}
 x.finish();await x.phase('fixing');assert.equal(x.r.result,undefined);await x.implemented();assert.equal(x.r.workflow.round,2);
 await assert.rejects(x.call('claude','submit_review',{...await x.read('claude'),decision:'approve',reason:'Teste antigo',testIds:[ids.claude]}),/desta versão/);
});

test('parar cancela testes; ID repetido não executa duas vezes nem outra identidade',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();
 const args={messageId:'slow',command:'sleep 30; test -f value.txt',purpose:'Verificar cancelamento'},a=await x.call('claude','start_test',args),b=await x.call('claude','start_test',args);
 assert.equal(a.test.id,b.test.id);assert.equal(b.duplicate,true);assert.equal(x.r.workflow.tests.length,1);
 await assert.rejects(x.call('claude','start_test',{...args,command:'test -f value.txt'}),/reutilizado/);
 await x.cx.pause(x.r.id);await wait(()=>x.r.workflow.tests[0].status==='interrupted');assert.equal(x.r.result,undefined);
});

test('atualização durante escrita interrompe a execução e elimina autorização antiga',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.cx.update(x.r.id,{requestId:'new',text:'Agora só quero um plano, não alteres mais nada.'});
 assert.equal(x.r.status,'paused');assert.equal(x.r.workflow.phase,'planning');assert.equal(x.r.workflow.authorized,false);assert.equal(x.r.candidateId,null);
});

test('sem maioria reabre o plano, conservando os votos exatos e sem habilitar escrita',async t=>{
 const x=await setup(t);await x.positions();const c=await x.candidate();
 for(const role of x.roles)await x.vote(c,role,role==='codex'?'approve':'changes');x.finish();
 await wait(()=>x.r.candidateId===null&&x.r.messages.some(m=>m.type==='phase'));
 assert.equal(x.r.workflow.phase,'planning');assert.equal(x.r.candidates[0].votes.claude.decision,'changes');assert.equal(x.r.result,undefined);
 assert.ok(Object.values(x.clients).every(c=>c.logs.every(l=>!l.settings.hydraWrite)));
});

test('alteração externa depois dos testes impede publicar uma versão que não foi testada',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();
 for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Testado.',testIds:[ids[role]]});x.finish();await x.phase('finalizing');
 await writeFile(x.cwd+'/value.txt','external-change');const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);x.finish();
 await wait(()=>x.r.status==='paused');assert.equal(x.r.result,undefined);assert.match(x.r.error,/mudou depois dos testes/);
});

test('revisão bloqueada não se transforma em sucesso por maioria',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();
 for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:role==='antigravity'?'blocked':'approve',reason:role==='antigravity'?'Falta verificar integração real.':'Teste passou.',testIds:[ids[role]]});
 x.finish();await wait(()=>x.r.status==='paused');assert.equal(x.r.result,undefined);assert.match(x.r.error,/Falta verificar integração real/);
});

test('teste que reescreve a fonte na cópia não pode certificar a implementação',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();
 const ids=await x.tests('echo fake > value.txt; test "$(cat value.txt)" = fake');
 assert.ok(x.r.workflow.tests.every(t=>t.exitCode===0&&t.sourceChanged&&t.status==='failed'));
 assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'after');
 await assert.rejects(x.call('claude','submit_review',{...await x.read('claude'),decision:'approve',reason:'Passou',testIds:[ids.claude]}),/falhas/);
});

test('nova revisão do pedido recusa uma classificação atrasada sem revision atual',async t=>{
 const x=await setup(t);await x.positions();await x.cx.update(x.r.id,{requestId:'only-plan',text:'Agora apenas planeia, sem implementar.'});
 await assert.rejects(x.call('codex','initial_position',{text:'Ordem antiga',intent:'implement',authorizationQuote:x.r.messages[0].text}),/Pedido atualizado/);
 const v=await x.read('codex');await x.call('codex','initial_position',{text:'Apenas plano.',intent:'read-only',revision:v.revision});assert.equal(x.r.workflow.authorized,false);
});

test('reinício conserva testes interrompidos sem executar nem reenviar; cópias são limpas',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();x.finish();
 clearInterval(x.cx.timer);clearTimeout(x.cx.scheduled);x.cx.loaded=false;await x.cx.queue;
 x.r.workflow.tests.push({id:'pending',role:'claude',round:1,status:'running',command:'test pending'});await x.cx.persist();
 const logs=Object.values(x.clients).reduce((n,c)=>n+c.logs.length,0);
 await rm(x.cx.directory+'/owner.json');x.cx.ownsLock=false;
 const recovered=new ClaudeX({hub:x.hub,directory:x.cx.directory,prepare:x.cx.prepare});await recovered.load();
 assert.equal(recovered.error,undefined);const r=recovered.record(x.r.id);assert.equal(r.status,'paused');assert.equal(r.workflow.tests[0].status,'interrupted');assert.equal(r.workflow.snapshot.directory,null);
 assert.equal(Object.values(x.clients).reduce((n,c)=>n+c.logs.length,0),logs);await recovered.close();x.r.status='paused';x.cx.raw=await readFile(x.cx.directory+'/state.json','utf8');
});

test('proteção do agy distingue principal de revisor e mantém MCP restrito',()=>{
 const input={toolCall:{name:'write_to_file',args:{TargetFile:'/tmp/project/file'}}};
 assert.equal(decide(input,hydraPolicy(['read_dialogue'])).decision,'deny');
 assert.equal(decide(input,hydraPolicy(['read_dialogue'],{write:true,cwd:'/tmp/project'})).decision,'ask');
 assert.equal(decide({toolCall:{name:'call_mcp_tool',args:{ServerName:'external',ToolName:'write'}}},hydraPolicy(['read_dialogue'],{write:true,cwd:'/tmp/project'})).decision,'deny');
});

test('isolamento real: escrita só na cópia, sem home/rede e versão independente das alterações do teste',{skip:noBwrap},async t=>{
 const root=await mkdtemp('/tmp/hydra-isolation-');t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(root+'/src');await writeFile(root+'/src/value.txt','original');await symlink('value.txt',root+'/src/relative-link');
 const snapshot=await validationSnapshot(root+'/src',root+'/snapshots'),before=await sourceFingerprint(root+'/src');assert.equal(await readlink(snapshot.directory+'/relative-link'),'value.txt');
 const result=await runValidation({snapshot:snapshot.directory,cwd:root+'/src',command:'echo edited > value.txt; test "$(cat value.txt)" = edited && test ! -e /home/sauron/.codex/auth.json && test \"$(cat relative-link)\" = edited'});
 assert.equal(result.exitCode,0,result.output);assert.equal(result.sourceChanged,true);assert.equal(before,await sourceFingerprint(root+'/src'));assert.equal(await readFile(root+'/src/value.txt','utf8'),'original');
});

async function nativeAnswer(x,role='codex',question='Qual o formato?',answer='Texto simples'){
 const id=randomUUID(),c=x.cx.native(x.r,role);
 x.clients[role].approvals.set(id,{id,method:role==='claude'?'claude/askUserQuestion':'tool/requestUserInput',conversationId:c.id,params:{questions:[{question,header:'Formato'}]}});
 await x.hub.respond(role+':'+id,{decision:'accept',answers:{Formato:answer}});
 return x.r.messages.findLast(m=>m.from==='user'&&m.type==='answer');
}

test('esclarecimento no plano conserva posições e intenção, anulando só candidata e votos',async t=>{
 const x=await setup(t);await x.positions();const c=await x.candidate();await x.vote(c,'codex');
 const positions=structuredClone(x.r.positions),intents=structuredClone(x.r.workflow.intents),revision=x.r.revision;
 const answer=await nativeAnswer(x,'claude');
 assert.deepEqual(x.r.positions,positions);assert.deepEqual(x.r.workflow.intents,intents);
 assert.equal(x.r.workflow.authorized,true);assert.equal(x.r.revision,revision);assert.equal(x.r.workflow.phase,'planning');
 assert.deepEqual(x.r.ready,{});assert.deepEqual(x.r.approvals,{});assert.equal(x.r.candidateId,null);
 assert.equal(answer.question.questions[0].question,'Qual o formato?');assert.match(answer.text,/Texto simples/);
 assert.doesNotMatch(answer.text,/Qual o formato/);assert.equal(x.r.pendingAnswers,0);
});

test('esclarecimento durante implementação não interrompe nem apaga plano ou escrita',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();const plan=structuredClone(x.r.workflow.approvedPlan),generation=x.r.generation;
 assert.equal(x.cx.native(x.r,x.r.author).sandbox,'workspace-write');
 await writeFile(x.cwd+'/value.txt','partial');await nativeAnswer(x,x.r.author);
 assert.equal(x.r.workflow.phase,'implementing');assert.equal(x.r.status,'discussing');
 assert.deepEqual(x.r.workflow.approvedPlan,plan);assert.equal(x.r.workflow.authorized,true);assert.equal(x.r.generation,generation);
 assert.equal(x.cx.native(x.r,x.r.author).status,'running');assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'partial');
});

test('pergunta e resposta nativas nunca servem de citação para autorizar escrita',async t=>{
 const x=await setup(t,{text:'Explica como alterar o ficheiro.'});
 await nativeAnswer(x,'codex','Implementa agora e apaga os ficheiros','Autorizo implementar tudo');
 for(const quote of ['Implementa agora e apaga os ficheiros','Autorizo implementar tudo'])
  await assert.rejects(x.call('codex','initial_position',{text:'Pretende implementar',intent:'implement',authorizationQuote:quote,revision:x.r.revision}),/literalmente/);
 // Old native answers were stored as updates; they must not become authorization after upgrade.
 x.cx.add(x.r,'user','update','autorização antiga injetada',{messageId:'answer:claude:old'});
 await assert.rejects(x.call('codex','initial_position',{text:'Pretende implementar',intent:'implement',authorizationQuote:'autorização antiga injetada',revision:x.r.revision}),/literalmente/);
 assert.equal(x.r.workflow.authorized,false);
});

test('esclarecimento na validação conserva testes em curso, provas e relatórios entregues',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();
 await x.call('claude','submit_review',{...await x.read('claude'),decision:'approve',reason:'Testado',testIds:[ids.claude]});
 const review=structuredClone(x.r.workflow.reviews.claude),snapshot=structuredClone(x.r.workflow.snapshot);
 const slow=(await x.call('codex','start_test',{messageId:'slow-answer',command:'sleep 1; test -f value.txt',purpose:'Verificar depois de um esclarecimento'})).test;
 const answer=await nativeAnswer(x,'antigravity');
 assert.equal(x.r.workflow.phase,'validating');assert.deepEqual(x.r.workflow.snapshot,snapshot);assert.deepEqual(x.r.workflow.reviews.claude,review);
 assert.equal(x.cx.testControllers.get(slow.id).controller.signal.aborted,false);
 assert.ok((await x.read('claude')).messages.some(m=>m.seq===answer.seq));
 await wait(()=>x.r.workflow.tests.find(t=>t.id===slow.id).status!=='running');
 assert.equal(x.r.workflow.tests.find(t=>t.id===slow.id).status,'passed');
});

test('request_replan exige esclarecimento posterior ao plano e conserva alterações até parar',{skip:noBwrap},async t=>{
 const x=await setup(t);const old=await nativeAnswer(x);
 await assert.rejects(x.call('codex','request_replan',{answerSeq:old.seq,reason:'Ainda no plano'}),/fase/);
 await x.plan();
 await assert.rejects(x.call('codex','request_replan',{answerSeq:old.seq,reason:'Resposta anterior'}),/posterior/);
 await assert.rejects(x.call('codex','request_replan',{answerSeq:x.r.seq,reason:'Não é resposta'}),/esclarecimento/);
 const answer=await nativeAnswer(x),plan=structuredClone(x.r.workflow.approvedPlan);
 await writeFile(x.cwd+'/value.txt','partial');
 const args={answerSeq:answer.seq,reason:'A resposta muda o formato e invalida o plano.'};
 assert.equal((await x.call('codex','request_replan',args)).finishTurn,true);
 assert.equal((await x.call('codex','request_replan',args)).duplicate,true);
 await assert.rejects(x.call('codex','implementation_done',{...await x.read('codex'),summary:'Continuar a escrever'}),/replaneamento/);
 assert.equal(x.r.workflow.phase,'implementing');assert.deepEqual(x.r.workflow.approvedPlan,plan);
 x.finish();await x.phase('planning');
 assert.equal(x.r.workflow.authorized,false);assert.deepEqual(x.r.positions,{});assert.equal(x.r.workflow.approvedPlan,null);
 assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'partial');
 assert.equal(x.r.workflow.replans[0].approvedPlan.id,plan.id);assert.equal(x.r.workflow.replans[0].reason,args.reason);
 assert.ok(x.r.workflow.replans[0].completedAt);assert.ok(x.r.messages.some(m=>/alterações parciais/i.test(m.text)));
 for(const role of x.roles)assert.equal(x.clients[role].logs.at(-1).settings.hydraWrite,false);
 const view=await x.read('codex');assert.ok(view.answers.some(m=>m.seq===answer.seq));
});

test('request_replan interrompe turno que não termina e espera confirmação antes do reset',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();const answer=await nativeAnswer(x);
 let stopRequested=false,release;const stopped=new Promise(resolve=>release=resolve),original=x.clients.codex.interrupt.bind(x.clients.codex);
 x.clients.codex.interrupt=async id=>{stopRequested=true;await stopped;return original(id);};
 try{
  await x.call('codex','request_replan',{answerSeq:answer.seq,reason:'É necessário rever o plano.'});
  await wait(()=>stopRequested);assert.equal(x.r.workflow.phase,'implementing');assert.ok(x.r.workflow.approvedPlan);
 }finally{release();}
 await x.phase('planning');assert.equal(x.r.workflow.authorized,false);
});

test('revisor pode pedir replaneamento na validação e testes antigos não certificam o novo plano',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();const answer=await nativeAnswer(x,'claude');
 await x.call('claude','request_replan',{answerSeq:answer.seq,reason:'A resposta altera os critérios de aceitação.'});
 x.finish();await x.phase('planning');assert.equal(x.r.workflow.authorized,false);assert.equal(x.r.workflow.snapshot,null);
 assert.equal(x.r.workflow.tests.length,3);assert.ok(x.r.workflow.tests.every(t=>t.status==='passed'));
 assert.equal(x.r.workflow.replans[0].phase,'validating');
 await x.positions();const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);x.finish();await x.phase('implementing');await x.implemented();
 await assert.rejects(x.call('claude','submit_review',{...await x.read('claude'),decision:'approve',reason:'Reutilizar ronda anterior',testIds:[ids.claude]}),/desta versão/);
});

test('esclarecimento é idempotente e uma resposta nativa recusada não altera o diálogo',async t=>{
 const x=await setup(t),body={requestId:'answer:dedupe',provider:'codex',questions:[{question:'Formato?'}],decision:'accept',answers:{Formato:'JSON'}};
 await x.cx.answer(x.r.id,body);const seq=x.r.seq,evidence=x.r.evidenceRevision;
 await x.cx.answer(x.r.id,structuredClone(body));assert.equal(x.r.seq,seq);assert.equal(x.r.evidenceRevision,evidence);
 await assert.rejects(x.cx.answer(x.r.id,{...body,answers:{Formato:'CSV'}}),/reutilizado/);
 const respond=x.clients.codex.respond;x.clients.codex.respond=async()=>{throw Error('Resposta nativa inválida');};
 try{await assert.rejects(nativeAnswer(x),/Resposta nativa inválida/);}finally{x.clients.codex.respond=respond;}
 assert.equal(x.r.seq,seq);assert.equal(x.r.pendingAnswers,0);assert.equal(x.r.workflow.phase,'planning');
});

test('resposta ainda em entrega impede avançar para escrita com o plano anterior',async t=>{
 const x=await setup(t);await x.positions();const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);
 let release;const gate=new Promise(resolve=>release=resolve),respond=x.clients.codex.respond.bind(x.clients.codex);
 x.clients.codex.respond=async(...args)=>{await gate;return respond(...args);};
 const pending=nativeAnswer(x);
 try{
  assert.equal(x.r.pendingAnswers,1);x.finish();await x.cx.advanceWorkflow(x.r);
  assert.equal(x.r.workflow.phase,'planning');assert.equal(x.r.workflow.approvedPlan,undefined);
 }finally{release();await pending;}
 assert.equal(x.r.candidateId,null);assert.equal(x.r.workflow.phase,'planning');
 assert.ok(Object.values(x.clients).every(client=>client.logs.every(log=>!log.settings.hydraWrite)));
});

test('esclarecimento depois dos relatórios exige leitura por todos antes de concluir',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();
 for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Verificado',testIds:[ids[role]]});
 const answer=await nativeAnswer(x,'claude');x.finish();await x.phase('validating');
 assert.equal(x.r.workflow.phase,'validating');assert.equal(Object.keys(x.r.workflow.reviews).length,3);
 for(const role of x.roles)assert.ok((await x.read(role)).messages.some(m=>m.seq===answer.seq));
 x.finish();await x.phase('finalizing');
 const tests=structuredClone(x.r.workflow.tests);await nativeAnswer(x,'claude');
 assert.equal(x.r.workflow.phase,'finalizing');assert.deepEqual(x.r.workflow.tests,tests);
});

test('replaneamento cancela testes ativos da ronda e mantém os resultados interrompidos no histórico',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();
 const check=(await x.call('codex','start_test',{messageId:'during-replan',command:'sleep 30; test -f value.txt',purpose:'Verificar interrupção da ronda antiga'})).test;
 const answer=await nativeAnswer(x,'claude');
 await x.call('claude','request_replan',{answerSeq:answer.seq,reason:'Critério de aceitação alterado'});x.finish();await x.phase('planning');
 assert.equal(x.r.workflow.tests.find(t=>t.id===check.id).status,'interrupted');assert.equal(x.r.workflow.snapshot,null);
 await assert.rejects(stat(x.cx.directory+'/validation/'+x.r.id),/ENOENT/);
});

test('replaneamento em fixing e pausa durante a paragem mantêm o pedido até à retoma explícita',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests('test -f missing.txt');
 for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:'changes',reason:'Falta o ficheiro',testIds:[ids[role]]});
 x.finish();await x.phase('fixing');const answer=await nativeAnswer(x);
 await x.call('codex','request_replan',{answerSeq:answer.seq,reason:'O esclarecimento altera a correção'});
 await x.cx.pause(x.r.id);await wait(()=>!x.cx.pauseDrains.has(x.r.id)&&!x.cx.jobs.has(x.r.id));
 assert.equal(x.r.workflow.phase,'fixing');assert.ok(x.r.workflow.replan);assert.equal(x.r.workflow.replans,undefined);
 await x.cx.resume(x.r.id);await x.phase('planning');assert.equal(x.r.workflow.authorized,false);
 assert.equal(x.r.workflow.replans[0].phase,'fixing');assert.equal(x.r.workflow.replans[0].status,'completed');
});

test('pedido novo durante replaneamento pendente interrompe e substitui o pedido antigo',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();const answer=await nativeAnswer(x);
 await x.call('codex','request_replan',{answerSeq:answer.seq,reason:'Plano a rever'});
 await x.cx.update(x.r.id,{requestId:'cancel-replan',text:'Agora só quero uma explicação, sem mais alterações.'});
 assert.equal(x.r.status,'paused');assert.equal(x.r.workflow.phase,'planning');assert.equal(x.r.workflow.replan,null);
 assert.equal(x.r.workflow.authorized,false);assert.equal(x.r.workflow.replans[0].status,'superseded');
 assert.notEqual(x.cx.native(x.r,'codex').status,'running');
});

test('replaneamento não reinicia o plano enquanto o estado do escritor é incerto',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();const answer=await nativeAnswer(x);
 await x.call('codex','request_replan',{answerSeq:answer.seq,reason:'Plano invalidado pelo esclarecimento'});
 const c=x.cx.native(x.r,'codex');c.status=c.turns.at(-1).status='uncertain';x.cx.kick();
 await wait(()=>x.r.status==='paused'||x.r.workflow.phase==='planning');
 assert.equal(x.r.workflow.phase,'implementing');assert.equal(x.r.status,'paused');assert.ok(x.r.workflow.replan);
 assert.match(x.r.error,/incerto/);assert.equal(x.r.workflow.replans,undefined);
});

test('reinício depois de partilhar resposta não conserva uma entrega pendente fantasma',async t=>{
 const x=await setup(t);clearInterval(x.cx.timer);clearTimeout(x.cx.scheduled);x.cx.loaded=false;
 await nativeAnswer(x,'claude');await x.cx.queue;
 const persisted=JSON.parse(await readFile(x.cx.directory+'/state.json','utf8'));
 assert.equal(persisted.conversations[0].pendingAnswers,1); // Persist happened before respond() finally.
 await rm(x.cx.directory+'/owner.json');x.cx.ownsLock=false;
 const recovered=new ClaudeX({hub:x.hub,directory:x.cx.directory,prepare:x.cx.prepare});
 try{
  await recovered.load();assert.equal(recovered.error,undefined);const r=recovered.record(x.r.id);
  assert.equal(r.pendingAnswers,0);assert.equal(r.status,'paused');assert.equal(r.messages.filter(m=>m.type==='answer').length,1);
 }finally{await recovered.close();x.r.status='paused';x.cx.raw=await readFile(x.cx.directory+'/state.json','utf8');}
});

test('replaneamento mantém a ligação MCP: uma thread Codex carregada não recebe outra',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();const answer=await nativeAnswer(x);
 const files=role=>x.clients[role].logs.at(-1).settings.contextMcp.file,before=files('codex'),leases=[...x.cx.leases.keys()];
 await x.call('codex','request_replan',{answerSeq:answer.seq,reason:'Plano invalidado.'});x.finish();await x.phase('planning');
 assert.equal(files('codex'),before);assert.deepEqual([...x.cx.leases.keys()],leases);
 assert.ok((await x.call('codex','read_dialogue')).request);assert.equal(await readFile(before,'utf8').then(Boolean),true);
});

test('esclarecimento não passa por pedido na conclusão publicada nem na tarefa seguinte',async t=>{
 const x=await setup(t);await nativeAnswer(x,'claude','Qual o formato?','JSON');await x.positions('read-only');const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);x.finish();await wait(()=>x.r.status==='completed');
 const published=x.cx.native(x.r,x.r.author).messages.findLast(m=>m.source==='claudex-publication'&&m.role==='user');
 assert.equal(published.text,x.r.messages[0].text);
 const next=await x.cx.create({cwd:x.cwd,text:'Continua a partir daqui.',requestId:randomUUID(),roles:x.roles,members:Object.fromEntries(x.roles.map(k=>[k,{model:'test',effort:'low'}])),resumeFrom:x.r.id});
 const checkpoint=JSON.parse(x.cx.record(next.task.id).messages.find(m=>m.type==='checkpoint').text);
 assert.deepEqual(checkpoint.request.map(m=>m.type),['request']);assert.equal(checkpoint.answers.length,1);assert.equal(checkpoint.answers[0].question.questions[0].question,'Qual o formato?');
});

test('revisor reacordado com a resposta no prompt não pausa a tarefa por não a reler',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();
 for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Verificado',testIds:[ids[role]]});
 const sent=x.clients.codex.logs.length;await nativeAnswer(x,'claude','Qual o formato?','Formato combinado');x.finish();
 // A turn already running only learned of it by a notice, so it gets a new turn with the answer in its prompt.
 await wait(()=>x.clients.codex.logs.length>sent&&x.r.roles.every(k=>x.cx.native(x.r,k).status==='running'));
 assert.equal(x.r.workflow.phase,'validating');assert.match(x.clients.codex.logs.at(-1).text,/Formato combinado/);
 x.finish();await x.phase('finalizing');assert.equal(x.r.status,'discussing');assert.ok(x.r.pause==null);
});

test('resposta posterior permite repetir testes e revisão, com a revisão anterior no histórico',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();
 const review=async decision=>x.call('codex','submit_review',{...await x.read('codex'),decision,reason:decision==='approve'?'Verificado':'A resposta cria um requisito por cumprir.',testIds:[ids.codex]});
 await review('approve');
 await assert.rejects(review('changes'),/já entregue/);await assert.rejects(x.call('codex','start_test',{messageId:'late',command:'test -f value.txt',purpose:'Sem novidade'}),/já entregue/);
 await nativeAnswer(x,'claude','Aceita vazio?','Sim, tem de aceitar vazio');
 assert.match((await x.read('codex')).nextAction,/esclarecimento posterior/);
 const again=(await x.call('codex','start_test',{messageId:'after-answer',command:'test -f value.txt',purpose:'Verificar o novo requisito'})).test;
 await wait(()=>x.r.workflow.tests.find(t=>t.id===again.id).status==='passed');
 await review('changes');
 assert.equal(x.r.workflow.reviews.codex.decision,'changes');assert.equal(x.r.workflow.reviews.codex.superseded[0].decision,'approve');
 await assert.rejects(review('approve'),/já entregue/);
});

test('teste novo depois da revisão acorda o revisor com o resultado',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();
 await x.call('codex','submit_review',{...await x.read('codex'),decision:'approve',reason:'Verificado',testIds:[ids.codex]});
 await nativeAnswer(x,'claude','Aceita vazio?','Sim');await x.read('codex');
 const again=(await x.call('codex','start_test',{messageId:'wake',command:'sleep 0.3; test -f value.txt',purpose:'Verificar a resposta'})).test,sent=x.clients.codex.logs.length;
 x.clients.codex.finish(x.cx.native(x.r,'codex'),'Aguardo o resultado.');
 await wait(()=>x.r.workflow.tests.find(t=>t.id===again.id).status==='passed'&&x.clients.codex.logs.length>sent);
 assert.equal(x.cx.native(x.r,'codex').status,'running');assert.equal(x.r.workflow.phase,'validating');
});

test('o pedido aos modelos manda seguir os esclarecimentos, sem os tornar autorização',async t=>{
 const x=await setup(t);await nativeAnswer(x,'claude','Mais algum requisito?','Acrescenta também a função sub');await x.positions();const c=await x.candidate();await x.vote(c,'claude');
 const sent=x.clients.codex.logs.length;await nativeAnswer(x,'claude','Outro requisito?','Nada mais');x.finish();await wait(()=>x.clients.codex.logs.length>sent);
 const prompt=x.clients.codex.logs.at(-1).text;
 assert.match(prompt,/têm de ser seguidos/);assert.match(prompt,/efetivamente pede, mesmo que acrescente trabalho, e nada além disso/);assert.match(prompt,/Acrescenta também a função sub/);
 await assert.rejects(x.call('codex','request_replan',{answerSeq:x.r.messages.findLast(m=>m.type==='answer').seq,reason:'Ainda no plano'}),/fase/);
});

test('sem isolamento de comandos, um principal Claude ou agy não chega a receber escrita',{skip:noBwrap},async t=>{
 const x=await setup(t,{author:'claude'});let problem='bwrap em falta.';x.cx.writerProblem=async()=>problem;
 await x.positions();const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);x.finish();
 await wait(()=>x.r.status==='paused');
 assert.equal(x.r.workflow.phase,'planning');assert.match(x.r.error,/bwrap em falta/);assert.equal(x.r.pause.kind,'preflight');assert.equal(x.r.workflow.approvedPlan,undefined);
 assert.ok(Object.values(x.clients).every(client=>client.logs.every(log=>!log.settings.hydraWrite)));
 // Once it is fixed the same plan goes on, with the votes it already had.
 problem=null;await settled(x);await x.cx.resume(x.r.id);await x.phase('implementing');
 assert.equal(x.clients.claude.logs.at(-1).settings.hydraWrite,true);assert.equal(x.r.workflow.approvedPlan.id,c.id);
 assert.match(x.clients.claude.logs.at(-1).text,/comandos correm isolados/);
});

test('o isolamento é verificado para Claude e agy e nunca para o Codex',{skip:noBwrap},async t=>{
 const x=await setup(t);
 assert.equal(await x.cx.writerProblem({author:'codex',cwd:'/caminho/inexistente'}),null);
 assert.equal(await x.cx.writerProblem({author:'claude',cwd:x.cwd}),null);
 assert.equal(typeof await x.cx.writerProblem({author:'antigravity',cwd:'/caminho/inexistente'}).catch(e=>e.message),'string');
});

test('um comando falhado por engano substitui-se com motivo e fica no histórico',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();
 const start=(args)=>x.call('claude','start_test',{purpose:'Verificar',...args}),done=id=>wait(()=>x.r.workflow.tests.find(t=>t.id===id).status!=='running');
 const bad=(await start({messageId:'engano',command:'grep -q nada value.txt'})).test;await done(bad.id);
 assert.equal(x.r.workflow.tests.find(t=>t.id===bad.id).status,'failed');
 const review=async(testIds)=>x.call('claude','submit_review',{...await x.read('claude'),decision:'approve',reason:'Verificado',testIds});
 await assert.rejects(review([ids.claude]),/falhas não podem ser omitidas/);
 await assert.rejects(start({messageId:'sem-motivo',command:'test -f value.txt',supersedes:bad.id}),/Texto inválido/);
 await assert.rejects(start({messageId:'passou',command:'test -f value.txt',supersedes:ids.claude,supersedeReason:'Motivo'}),/não tenha passado/);
 await assert.rejects(x.call('codex','start_test',{messageId:'alheio',command:'test -f value.txt',purpose:'x',supersedes:bad.id,supersedeReason:'Motivo'}),/não tenha passado/);
 // A replacement that fails changes nothing.
 const worse=(await start({messageId:'ainda-falha',command:'test -f nao-existe',supersedes:bad.id,supersedeReason:'Caminho errado'})).test;await done(worse.id);
 assert.equal(x.r.workflow.tests.find(t=>t.id===bad.id).supersededBy,undefined);await assert.rejects(review([ids.claude]),/falhas/);
 const first=(await start({messageId:'corrige-1',command:'test -f value.txt',supersedes:bad.id,supersedeReason:'O grep procurava outro texto'})).test;await done(first.id);
 assert.equal(x.r.workflow.tests.find(t=>t.id===bad.id).supersededBy,first.id);
 const second=(await start({messageId:'corrige-2',command:'test -f value.txt',supersedes:worse.id,supersedeReason:'Caminho errado'})).test;await done(second.id);
 await review([ids.claude,first.id,second.id]);
 for(const role of ['codex','antigravity'])await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Verificado',testIds:[ids[role]]});
 x.finish();await x.phase('finalizing');
 const history=x.r.workflow.tests.find(t=>t.id===bad.id);assert.equal(history.status,'failed');assert.equal(history.command,'grep -q nada value.txt');
 assert.equal(x.r.workflow.tests.find(t=>t.id===first.id).supersedeReason,'O grep procurava outro texto');
});

test('tempo esgotado e problema do ambiente também impedem aprovar',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();
 const run=async(command)=>{const test=(await x.call('claude','start_test',{messageId:command,command,purpose:'Verificar'})).test;await wait(()=>x.r.workflow.tests.find(t=>t.id===test.id).status!=='running');return x.r.workflow.tests.find(t=>t.id===test.id);};
 const missing=await run('ferramenta-que-nao-existe');assert.equal(missing.status,'environment');
 await assert.rejects(x.call('claude','submit_review',{...await x.read('claude'),decision:'approve',reason:'x',testIds:[missing.id]}),/testes concluídos com sucesso/);
});

test('dependências e outros ficheiros ignorados alterados na ronda anulam-na; caches não',{skip:noBwrap},async t=>{
 const prepare=async()=>{const x=await setup(t);await mkdir(x.cwd+'/node_modules/.cache',{recursive:true});await mkdir(x.cwd+'/build');await writeFile(x.cwd+'/node_modules/dep.js','1');await writeFile(x.cwd+'/node_modules/.cache/c','1');await writeFile(x.cwd+'/build/b.js','1');await x.plan();await x.implemented();const ids=await x.tests();for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Verificado',testIds:[ids[role]]});return x;};
 for(const file of ['node_modules/dep.js','build/b.js']){
  const changed=await prepare();await writeFile(changed.cwd+'/'+file,'22');changed.finish();
  await wait(()=>changed.r.status==='paused');assert.match(changed.r.error,/mudaram durante a revisão/,file);assert.equal(changed.r.result,undefined);assert.equal(changed.r.workflow.validatedHash,undefined,file);
 }
 const cache=await prepare();await writeFile(cache.cwd+'/node_modules/.cache/c','22');cache.finish();
 await cache.phase('finalizing');assert.equal(cache.r.workflow.validatedHash,cache.r.workflow.snapshot.hash);
});

test('dependência alterada depois da validação impede a publicação',{skip:noBwrap},async t=>{
 const x=await setup(t);await mkdir(x.cwd+'/node_modules/dep',{recursive:true});await writeFile(x.cwd+'/node_modules/dep/value','1');await x.plan();await x.implemented();
 const ids=await x.tests('test "$(cat node_modules/dep/value)" = 1');for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Dependência testada',testIds:[ids[role]]});x.finish();await x.phase('finalizing');
 await writeFile(x.cwd+'/node_modules/dep/value','2');const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);x.finish();
 await wait(()=>['completed','paused'].includes(x.r.status));assert.equal(x.r.status,'paused');assert.equal(x.r.result,undefined);assert.match(x.r.error,/mudou depois dos testes/);
 await wait(()=>!x.cx.pauseDrains.has(x.r.id)&&!x.cx.jobs.has(x.r.id));await x.cx.resume(x.r.id);assert.equal(x.r.workflow.phase,'validating');assert.equal(x.r.workflow.round,2,'a retoma testa a nova versão');
});

test('uma revisão reaberta impede a mudança de fase até haver nova decisão',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();
 for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Antes da resposta',testIds:[ids[role]]});
 await x.cx.answer(x.r.id,{requestId:'answer:review',provider:'claude',questions:[],decision:'accept',answers:{q:'Critério adicional'}});
 const extra=(await x.call('claude','start_test',{messageId:'review-new',command:'test -f value.txt',purpose:'Rever novo critério'})).test;await wait(()=>x.r.workflow.tests.find(t=>t.id===extra.id).status==='passed');
 for(const role of x.roles)await x.read(role);const turns=x.clients.claude.logs.length;x.finish();
 await wait(()=>x.clients.claude.logs.length>turns&&x.cx.native(x.r,'claude').status==='running');assert.equal(x.r.workflow.phase,'validating','o revisor volta a ser chamado');assert.match((await x.read('claude')).nextAction,/repete submit_review/);
 assert.equal(x.cx.resumeNeeded(x.r,'claude'),true,'uma retoma também o chama');assert.equal(x.cx.resumeNeeded(x.r,'codex'),false);
 await x.call('claude','submit_review',{...await x.read('claude'),decision:'approve',reason:'Depois da resposta',testIds:[extra.id]});assert.equal(x.r.workflow.reviews.claude.reason,'Depois da resposta');
 x.clients.claude.finish(x.cx.native(x.r,'claude'),'Terminado.');await x.phase('finalizing');
});

test('retoma: código alterado enquanto se congela a versão abre nova ronda, sem aproveitar testes antigos',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();
 for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Só after foi testado',testIds:[ids[role]]});
 await x.cx.pause(x.r.id);await wait(()=>!x.cx.pauseDrains.has(x.r.id)&&!x.cx.jobs.has(x.r.id));
 const original=fsp.mkdir;let injected=false;
 fsp.mkdir=async function(...args){if(String(args[0])===x.cx.validationDirectory(x.r)&&!injected){injected=true;fs.writeFileSync(x.cwd+'/value.txt','UNTESTED');}return original(...args);};syncBuiltinESMExports();
 try{await x.cx.resume(x.r.id);}finally{fsp.mkdir=original;syncBuiltinESMExports();}
 assert.equal(injected,true);assert.equal(x.r.workflow.phase,'validating');assert.equal(x.r.workflow.round,2);assert.deepEqual(x.r.workflow.reviews,{});assert.equal(x.r.workflow.validatedHash,undefined);
});

test('hard link para fora do projeto: pausa antes de escrever e a retoma continua depois de resolvido',{skip:noBwrap},async t=>{
 const x=await setup(t);await writeFile(x.root+'/fora.txt','1');await link(x.root+'/fora.txt',x.cwd+'/alias.txt');
 await x.positions();const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);x.finish();
 await wait(()=>x.r.status==='paused');assert.equal(x.r.workflow.phase,'planning');assert.equal(x.r.pause.kind,'preflight');assert.match(x.r.error,/alias\.txt/);assert.match(x.r.error,/hard link/i);assert.equal(x.r.workflow.approvedPlan,undefined);
 await rm(x.cwd+'/alias.txt');await settled(x);await x.cx.resume(x.r.id);await x.phase('implementing');
});

test('um hard link criado durante a pausa impede a retoma de escrever, e a verificação repete-se em cada escrita',{skip:noBwrap},async t=>{
 const x=await setup(t,{author:'claude'});await x.plan();const client=x.clients.claude,writes=()=>client.logs.filter(l=>l.settings?.hydraWrite).length,first=writes();
 await x.cx.pause(x.r.id);await settled(x);
 await writeFile(x.root+'/fora.txt','ORIGINAL');await link(x.root+'/fora.txt',x.cwd+'/alias.txt');
 await x.cx.resume(x.r.id);await wait(()=>x.r.status==='paused'&&x.r.pause?.kind==='preflight');await settled(x);
 assert.match(x.r.error,/alias\.txt/);assert.equal(writes(),first,'o principal não recebeu escrita');assert.equal(x.r.workflow.phase,'implementing');
 await rm(x.cwd+'/alias.txt');await x.cx.resume(x.r.id);await x.phase('implementing');assert.equal(writes(),first+1,'resolvido, a escrita continua');
});

test('configuração do Git alterada de forma indireta pausa antes da revisão',{skip:noBwrap},async t=>{
 for(const prepare of [
  async x=>{await writeFile(x.cwd+'/git-config',await readFile(x.cwd+'/.git/config'));await rm(x.cwd+'/.git/config');await symlink('../git-config',x.cwd+'/.git/config');return ()=>appendFile(x.cwd+'/git-config','\n[audit]\nvalue=NEW\n');},
  async x=>{await writeFile(x.cwd+'/incluido.cfg','[audit]\nvalue=OLD\n');execFileSync('git',['config','include.path','../incluido.cfg'],{cwd:x.cwd});return ()=>writeFile(x.cwd+'/incluido.cfg','[audit]\nvalue=NEW\n');},
 ]){
  const x=await setup(t,{author:'claude'});execFileSync('git',['init','-q'],{cwd:x.cwd});const change=await prepare(x);await x.plan();await change();await writeFile(x.cwd+'/value.txt','after');await x.call('claude','implementation_done',{...await x.read('claude'),summary:'Alterado.'});x.finish();
  await wait(()=>x.r.status==='paused');assert.equal(x.r.pause.kind,'reserved');assert.match(x.r.error,/git config/);assert.equal(x.r.workflow.phase,'implementing');
 }
});

test('o Codex não é principal quando o projeto contém os dados da HYDRAQ; os outros são',{skip:noBwrap},async t=>{
 const x=await setup(t);const inside=path.dirname(x.cx.directory);
 assert.match(await x.cx.writerProblem({author:'codex',cwd:inside}),/dados da HYDRAQ/);assert.equal(await x.cx.writerProblem({author:'codex',cwd:x.cwd}),null);
 // Only .hydraq at the root is hidden from Claude's and agy's commands; under another name they could write there.
 assert.match(await x.cx.writerProblem({author:'claude',cwd:inside}),/dados da HYDRAQ/);assert.match(await x.cx.writerProblem({author:'antigravity',cwd:inside}),/dados da HYDRAQ/);
 const under=x.cx.writerProblem.bind({directory:x.cwd+'/.hydraq/claudex'});assert.equal(await under({author:'claude',cwd:x.cwd}),null);assert.match(await under({author:'codex',cwd:x.cwd}),/dados da HYDRAQ/);
 assert.equal(await x.cx.writerProblem({author:'codex',cwd:x.cx.directory+'/projeto-la-dentro'}),null,'um projeto dentro da pasta de dados não os contém');
});

test('uma ferramenta chamada com o parâmetro errado diz quais são os certos',async t=>{
 const x=await setup(t);
 await assert.rejects(x.call('antigravity','initial_position',{position:'Análise',intent:'implement',authorizationQuote:'x',revision:x.r.revision}),e=>/Posição inicial inválido/.test(e.message)&&/recebe: text, revision, intent, authorizationQuote/.test(e.message)&&/Falta: text/.test(e.message)&&/Não reconhecido: position/.test(e.message));
 assert.equal(x.r.positions.antigravity,undefined);
 await x.call('antigravity','initial_position',{text:'Análise',intent:'implement',authorizationQuote:'Implementa a alteração de value.txt para after e testa.',revision:x.r.revision});assert.equal(x.r.positions.antigravity,'Análise');
});

test('um hook escrito antes de um replaneamento continua a ser detetado',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await mkdir(x.cwd+'/sub/.git/hooks',{recursive:true});await writeFile(x.cwd+'/sub/.git/hooks/pre-commit','#!/bin/sh\n');
 await x.cx.answer(x.r.id,{requestId:'answer:replan',provider:'codex',questions:[],decision:'accept',answers:{q:'Muda o formato'}});
 await x.call('codex','request_replan',{answerSeq:x.r.messages.findLast(m=>m.type==='answer').seq,reason:'A resposta muda o plano.'});x.finish();
 await wait(()=>x.r.workflow.phase==='planning'&&x.roles.every(k=>x.cx.native(x.r,k).status==='running'));await x.plan();
 await writeFile(x.cwd+'/value.txt','after');await x.call(x.r.author,'implementation_done',{...await x.read(x.r.author),summary:'Alterado value.txt; verificar conteúdo.'});x.finish();
 await wait(()=>x.r.status==='paused');assert.equal(x.r.pause.kind,'reserved');assert.match(x.r.error,/pre-commit/);
});

test('parar depois de escrever avisa de hooks e de ficheiros ignorados alterados, não só de código',{skip:noBwrap},async t=>{
 for(const change of [async x=>{await mkdir(x.cwd+'/sub/.git/hooks',{recursive:true});await writeFile(x.cwd+'/sub/.git/hooks/pre-commit','#!/bin/sh\n');},async x=>{await mkdir(x.cwd+'/node_modules');await writeFile(x.cwd+'/node_modules/d.js','1');},async x=>{await mkdir(x.cwd+'/build');await writeFile(x.cwd+'/build/b.js','1');}]){
  const x=await setup(t,{conversation:true});await x.plan();await change(x);await x.cx.stop(x.r.id);await wait(()=>x.r.released);assert.equal(x.cx.native(x.r,'codex').hydraReturn.unvalidated,true);
 }
 const quiet=await setup(t,{conversation:true});await quiet.plan();await writeFile(quiet.cwd+'/server.log','1');await quiet.cx.stop(quiet.r.id);await wait(()=>quiet.r.released);assert.equal(quiet.cx.native(quiet.r,'codex').hydraReturn.unvalidated,undefined,'um registo não é uma alteração da tarefa');
});

test('um editor aberto não anula a ronda nem impede a publicação',{skip:noBwrap},async t=>{
 const x=await setup(t);await mkdir(x.cwd+'/.idea');await writeFile(x.cwd+'/.idea/workspace.xml','1');await x.plan();await x.implemented();const ids=await x.tests();for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Verificado',testIds:[ids[role]]});
 await writeFile(x.cwd+'/.idea/workspace.xml','22');await writeFile(x.cwd+'/server.log','1');x.finish();await x.phase('finalizing');
 await writeFile(x.cwd+'/.idea/workspace.xml','333');const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);x.finish();await wait(()=>x.r.status==='completed');assert.equal(x.r.result.unvalidated,undefined);
});

test('pastas reservadas alteradas durante a escrita pausam antes da revisão; a retoma aceita o estado',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await writeFile(x.cwd+'/value.txt','after');await mkdir(x.cwd+'/sub/.git/hooks',{recursive:true});await writeFile(x.cwd+'/sub/.git/hooks/pre-commit','#!/bin/sh\n');
 await x.call(x.r.author,'implementation_done',{...await x.read(x.r.author),summary:'Alterado value.txt; verificar conteúdo.'});x.finish();
 await wait(()=>x.r.status==='paused');assert.equal(x.r.pause.kind,'reserved');assert.match(x.r.error,/sub\/\.git\/hooks\/pre-commit/);assert.equal(x.r.workflow.phase,'implementing');assert.equal(x.r.workflow.snapshot,undefined);
 await settled(x);await x.cx.resume(x.r.id);await x.phase('validating');assert.equal(x.r.workflow.round,1);
 assert.equal(JSON.stringify(await x.read('claude')).includes('pre-commit'),false,'o estado interno não vai para os modelos');
});

test('sem conseguir preparar os testes, ninguém recebe escrita',{skip:noBwrap},async t=>{
 const x=await setup(t);let problem='A pasta tem demasiado código.';x.cx.testingProblem=async()=>problem;
 await x.positions();const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);x.finish();
 await wait(()=>x.r.status==='paused');assert.equal(x.r.workflow.phase,'planning');assert.match(x.r.error,/revisores não conseguiriam testar/);assert.match(x.r.error,/demasiado código/);
 assert.ok(Object.values(x.clients).every(client=>client.logs.every(log=>!log.settings.hydraWrite)));
 problem=null;await settled(x);await x.cx.resume(x.r.id);await x.phase('implementing');assert.equal(x.r.workflow.approvedPlan.id,c.id);
});

test('com os dados da HYDRAQ dentro do projeto, a pasta privada fica fora dele',{skip:noBwrap},async t=>{
 const x=await setup(t),project=path.dirname(x.cx.directory);
 const place=x.cx.validationDirectory({id:'abc',cwd:project});
 assert.equal(place,path.join(os.homedir(),'.local','state','hydraq','validation','abc'));assert.equal(x.cx.validationDirectory(x.r),x.cx.directory+'/validation/'+x.r.id);
 const inside={id:randomUUID(),cwd:project,workflow:{}};t.after(()=>x.cx.cleanupValidation(inside));
 assert.equal(await x.cx.testingProblem(inside),null);
});

test('pausar uma tarefa não espera pelos testes de outra',async t=>{
 const x=await setup(t),other={taskId:'outra',controller:new AbortController(),job:new Promise(()=>{})};
 x.cx.testControllers||=new Map();x.cx.testControllers.set('alheio',other);t.after(()=>x.cx.testControllers.delete('alheio'));
 await x.cx.pause(x.r.id);await x.cx.pauseDrains.get(x.r.id);assert.equal(x.r.status,'paused');assert.equal(other.controller.signal.aborted,false);
});

test('request_replan também está disponível na conclusão para qualquer participante',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();
 for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Verificado',testIds:[ids[role]]});
 x.finish();await x.phase('finalizing');const answer=await nativeAnswer(x,'codex');
 await x.turn('antigravity');await x.call('antigravity','request_replan',{answerSeq:answer.seq,reason:'A resposta invalida o que foi implementado.'});
 x.finish();await x.phase('planning');
 assert.equal(x.r.workflow.authorized,false);assert.equal(x.r.workflow.replans[0].phase,'finalizing');assert.equal(x.r.result,undefined);
});

// The same things resume() refuses to go ahead without.
const settled=x=>wait(()=>!x.cx.pauseDrains.has(x.r.id)&&!x.cx.jobs.has(x.r.id)&&![...x.cx.dispatchOwners.values()].includes(x.r.id)&&!x.cx.preparing.get(x.r.id)?.size);
const pauseResume=async(x,during=async()=>{})=>{await x.cx.pause(x.r.id);await settled(x);await during();await x.cx.resume(x.r.id);};
const sent=x=>Object.fromEntries(x.roles.map(k=>[k,x.clients[k].logs.length]));
const working=(x,...roles)=>wait(()=>roles.every(k=>x.cx.native(x.r,k).status==='running'));
const review=async(x,role,decision,testIds,reason='Verificado')=>x.call(role,'submit_review',{...await x.read(role),decision,reason,testIds});
const reviewed=async(x,ids)=>{for(const role of x.roles)await review(x,role,'approve',[ids[role]]);x.finish();await x.phase('finalizing');};

test('retomar no plano conserva a proposta e os votos e só acorda quem falta',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.positions();const c=await x.candidate();await x.vote(c,'codex');const before=sent(x);
 await pauseResume(x);await working(x,'claude','antigravity');
 assert.equal(x.r.workflow.phase,'planning');assert.equal(x.r.candidateId,c.id);assert.equal(x.r.workflow.votes.codex.decision,'approve');assert.equal(x.clients.codex.logs.length,before.codex,'quem já votou não gasta um turno');
 for(const role of ['claude','antigravity'])await x.vote(c,role);x.finish();await x.phase('implementing');assert.equal(x.r.workflow.approvedPlan.id,c.id);
});

test('retomar na implementação fica na mesma fase, com o plano e as alterações parciais',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();const plan=x.r.workflow.approvedPlan.id,before=sent(x);await writeFile(x.cwd+'/value.txt','parcial');
 await pauseResume(x);await working(x,'codex');
 assert.equal(x.r.workflow.phase,'implementing');assert.equal(x.r.workflow.approvedPlan.id,plan);assert.equal(x.r.workflow.authorized,true);assert.equal(x.r.workflow.round,0);
 assert.equal(x.clients.codex.logs.at(-1).settings.hydraWrite,true);assert.match(x.clients.codex.logs.at(-1).text,/alterações parciais/);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'parcial');
 assert.equal(x.clients.claude.logs.length,before.claude);assert.equal(x.clients.antigravity.logs.length,before.antigravity);
});

test('implementação já entregue não volta ao principal: a retoma segue para a revisão',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await writeFile(x.cwd+'/value.txt','after');await x.call('codex','implementation_done',{...await x.read('codex'),summary:'Feito.'});
 await pauseResume(x);await x.phase('validating');
 assert.equal(x.r.workflow.round,1);assert.equal(x.clients.codex.logs.at(-1).settings.hydraWrite,false);
});

test('retomar na revisão com a mesma versão reutiliza testes e revisões',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();await review(x,'claude','approve',[ids.claude]);
 const slow=(await x.call('antigravity','start_test',{messageId:'lento',command:'sleep 30; test -f value.txt',purpose:'Interrompido pela pausa'})).test,before=sent(x);
 await pauseResume(x);await working(x,'codex','antigravity');
 const w=x.r.workflow;assert.equal(w.phase,'validating');assert.equal(w.round,1);assert.equal(w.reviews.claude.decision,'approve');assert.ok(w.snapshot.directory);assert.equal(w.tests.find(t=>t.id===ids.codex).status,'passed');
 assert.equal(w.tests.find(t=>t.id===slow.id).status,'interrupted');assert.equal(x.clients.claude.logs.length,before.claude,'a revisão entregue não se repete');
 await review(x,'codex','approve',[ids.codex]);await review(x,'antigravity','approve',[ids.antigravity]);x.finish();await x.phase('finalizing');
 assert.equal(w.round,1);assert.equal(w.rounds.length,1);assert.equal(w.failedVersions?.length||0,0);
});

test('a versão reabre: código ou dependências alterados na pausa dão nova ronda sem passar pelo principal',{skip:noBwrap},async t=>{
 for(const change of [x=>writeFile(x.cwd+'/value.txt','mudou-na-pausa'),x=>writeFile(x.cwd+'/node_modules/dep.js','2')]){
  const x=await setup(t);await mkdir(x.cwd+'/node_modules');await writeFile(x.cwd+'/node_modules/dep.js','1');await x.plan();await x.implemented();const ids=await x.tests();await review(x,'claude','approve',[ids.claude]);
  const before=x.r.workflow.snapshot.hash;await pauseResume(x,()=>change(x));await x.phase('validating');
  const w=x.r.workflow;assert.equal(w.round,2);assert.deepEqual(w.reviews,{});assert.equal(w.rounds.at(-1).versionChanged,true);assert.equal(w.failedVersions?.length||0,0);assert.ok(x.roles.every(k=>x.clients[k].logs.at(-1).settings.hydraWrite===false));
  await assert.rejects(review(x,'claude','approve',[ids.claude]),/desta versão/);
  if(w.snapshot.hash===before)assert.equal(await x.call('claude','start_test',{messageId:'nova',command:'test -f value.txt',purpose:'Nova ronda'}).then(r=>r.test.round),2);
 }
});

test('retomar na conclusão com a mesma versão não repete nada',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();await reviewed(x,ids);const c=await x.candidate();await x.vote(c,'codex');const tests=x.r.workflow.tests.length,before=sent(x);
 await pauseResume(x);await working(x,'claude','antigravity');
 const w=x.r.workflow;assert.equal(w.phase,'finalizing');assert.equal(x.r.candidateId,c.id);assert.equal(w.round,1);assert.equal(w.tests.length,tests);assert.equal(x.clients.codex.logs.length,before.codex);assert.ok(x.roles.every(k=>x.clients[k].logs.at(-1).settings.hydraWrite===false));
 for(const role of ['claude','antigravity'])await x.vote(c,role);x.finish();await wait(()=>x.r.status==='completed');assert.ok(x.r.result.text.startsWith(c.text));assert.doesNotMatch(x.r.result.label,/por validar/);
});

test('código alterado depois de validado volta a testar, sem passar pelo principal',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();await reviewed(x,ids);
 await pauseResume(x,()=>writeFile(x.cwd+'/value.txt','externo'));await x.phase('validating');
 assert.equal(x.r.workflow.round,2);assert.equal(x.r.candidateId,null);assert.ok(x.roles.every(k=>x.clients[k].logs.at(-1).settings.hydraWrite===false));
});

test('pausa enquanto o turno do principal se prepara não impede retomar',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.positions();const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);
 let release;const gate=new Promise(r=>release=r),prepare=x.cx.prepare;x.cx.prepare=async(...a)=>{await gate;return prepare(...a);};x.finish();
 await wait(()=>x.r.members.codex.sandbox==='workspace-write');assert.notEqual(x.cx.native(x.r,'codex').sandbox,'workspace-write');
 const paused=x.cx.pause(x.r.id);release();await paused;await settled(x);x.cx.prepare=prepare;await x.cx.resume(x.r.id);await x.phase('implementing');
 assert.equal(x.clients.codex.logs.at(-1).settings.hydraWrite,true);
});

const failRound=async(x,content)=>{await writeFile(x.cwd+'/value.txt',content);await x.call(x.r.author,'implementation_done',{...await x.read(x.r.author),summary:'Versão '+content});x.finish();await x.phase('validating');const ids=await x.tests('test "$(cat value.txt)" = nunca');for(const role of x.roles)await review(x,role,'changes',[ids[role]],'O teste falhou.');x.finish();};

test('só versões diferentes gastam tentativas; a mesma versão a falhar outra vez pausa logo',{skip:noBwrap},async t=>{
 const same=await setup(t);await same.plan();await failRound(same,'a');await same.phase('fixing');await failRound(same,'a');
 await wait(()=>same.r.status==='paused');assert.match(same.r.error,/mesma versão voltou a não passar/);assert.deepEqual(same.r.workflow.failedVersions.length,1);
 const three=await setup(t);await three.plan();await failRound(three,'a');await three.phase('fixing');await failRound(three,'b');await three.phase('fixing');await failRound(three,'c');
 await wait(()=>three.r.status==='paused');assert.match(three.r.error,/três versões/);assert.equal(three.r.workflow.failedVersions.length,3);
 // An explicit resume gives the principal another go, with the attempts counted anew.
 await settled(three);await three.cx.resume(three.r.id);await three.phase('fixing');assert.deepEqual(three.r.workflow.failedVersions,[]);assert.equal(three.clients.codex.logs.at(-1).settings.hydraWrite,true);
 await three.cx.update(three.r.id,{requestId:'novo',text:'Pedido novo.'});assert.deepEqual(three.r.workflow.failedVersions,[]);
});

test('revisão bloqueada: a retoma repete só esse revisor na mesma versão',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();
 for(const role of x.roles)await review(x,role,role==='antigravity'?'blocked':'approve',[ids[role]],role==='antigravity'?'Falta uma ferramenta.':'Verificado');x.finish();
 await wait(()=>x.r.status==='paused');await settled(x);const before=sent(x);await x.cx.resume(x.r.id);await working(x,'antigravity');
 const w=x.r.workflow;assert.equal(w.phase,'validating');assert.equal(w.round,1);assert.equal(w.reviews.antigravity,undefined);assert.equal(w.reviews.claude.decision,'approve');assert.equal(x.clients.claude.logs.length,before.claude);
 await review(x,'antigravity','approve',[ids.antigravity]);x.finish();await x.phase('finalizing');
});

test('fechar o servidor com o principal a escrever pausa a tarefa e não devolve a conversa',{skip:noBwrap},async t=>{
 const x=await setup(t,{conversation:true});await x.plan();await writeFile(x.cwd+'/value.txt','parcial');
 await x.cx.close();assert.equal(x.r.status,'paused');assert.equal(x.r.pause.kind,'restart');assert.match(x.r.pause.reason,/HYDRAQ fechou/);
 const next=new ClaudeX({hub:x.hub,directory:x.cx.directory,prepare:x.cx.prepare});next.endpoint('http://127.0.0.1:1/api/claudex/tools');await next.load();
 try{
  const r=next.record(x.r.id);await new Promise(resolve=>setTimeout(resolve,1200));
  assert.equal(r.status,'paused');assert.equal(r.released,undefined);assert.equal(next.native(r,'codex').claudexTask,r.id);assert.ok(next.holds(next.native(r,'codex').id));
  await next.resume(r.id);await wait(()=>next.native(r,'codex').status==='running');
  assert.equal(r.workflow.phase,'implementing');assert.equal(x.clients.codex.logs.at(-1).settings.hydraWrite,true);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'parcial');
 }finally{await next.close();x.r.status='paused';x.cx.raw=await readFile(x.cx.directory+'/state.json','utf8');}
});

test('atualização na revisão limpa os ficheiros de testes e a conclusão avisa do código por validar',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const folder=x.cx.validationDirectory(x.r);assert.ok((await readdir(folder)).length);
 await x.cx.update(x.r.id,{requestId:'so-explica',text:'Afinal só explica o que fizeste.'});await assert.rejects(stat(folder),/ENOENT/);
 await x.positions('read-only');const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);x.finish();await wait(()=>x.r.status==='completed');
 assert.match(x.r.result.label,/alterações por validar/);assert.match(x.r.result.text,/nenhuma revisão validou/);assert.equal(x.r.result.hash,c.hash);assert.equal(x.r.result.unvalidated,true);
 assert.match(x.cx.native(x.r,x.r.author).messages.findLast(m=>m.role==='assistant').text,/nenhuma revisão validou/);
});

test('sem alterações no código, a conclusão de um pedido que mudou não traz aviso',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.cx.update(x.r.id,{requestId:'plano',text:'Afinal só quero um plano.'});await settled(x);await x.cx.resume(x.r.id);await wait(()=>x.roles.every(k=>x.cx.native(x.r,k).status==='running'));
 await x.positions('read-only');const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);x.finish();await wait(()=>x.r.status==='completed');
 assert.doesNotMatch(x.r.result.label,/por validar/);assert.equal(x.r.result.text,c.text);
});

test('parar uma tarefa numa conversa avisa o modelo seguinte só se houver código por validar',{skip:noBwrap},async t=>{
 const stopped=async(x)=>{await x.cx.stop(x.r.id);await wait(()=>x.r.released);return x.cx.native(x.r,'codex').hydraReturn;};
 const writing=await setup(t,{conversation:true});await writing.plan();await writeFile(writing.cwd+'/value.txt','parcial');
 const partial=await stopped(writing);assert.equal(partial.unvalidated,true);assert.match(hydraReturnNote(partial),/nenhuma revisão validou/);assert.equal(writing.cx.snapshot().records[0].unvalidated,true);
 const planning=await setup(t,{conversation:true});await planning.positions();const clean=await stopped(planning);assert.equal(clean.unvalidated,undefined);assert.doesNotMatch(hydraReturnNote(clean),/validou/);
 const validated=await setup(t,{conversation:true});await validated.plan();await validated.implemented();const ids=await validated.tests();await reviewed(validated,ids);
 assert.equal((await stopped(validated)).unvalidated,undefined,'a versão validada não precisa de aviso');
});

test('com uma interrupção por confirmar, a retoma explica que tem de esperar',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.positions();const interrupt=x.clients.codex.interrupt;x.clients.codex.interrupt=async()=>({requested:true});t.after(()=>{x.clients.codex.interrupt=interrupt;});
 await x.cx.pause(x.r.id);await settled(x);assert.equal(x.r.pause.interruptionPending,true);
 await assert.rejects(x.cx.resume(x.r.id),/aguarda que parem/);assert.equal(x.r.status,'paused');
 const c=x.cx.native(x.r,'codex');c.status=c.turns.at(-1).status='interrupted';x.cx.kick();await wait(()=>!x.r.pause.interruptionPending);await settled(x);
 await x.cx.resume(x.r.id);await working(x,'codex');assert.equal(x.r.status,'discussing');
});

// A task in a private copy: the project only receives what was tested.
const approveRound=async x=>{const ids=await x.tests();for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Testado.',testIds:[ids[role]]});x.finish();await x.phase('finalizing');};
const conclude=async x=>{const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);x.finish();};
// The status comes first and the private folder goes right after it, in the same step.
const ended=(x,...states)=>wait(()=>states.includes(x.r.status)&&!x.cx.jobs.has(x.r.id)&&(!x.r.workspace||x.r.workspace.left));
const inCopy={skip:noBwrap};

test('tarefa completa na cópia: o projeto só muda depois de testado e aprovado, e as conversas voltam',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude'}),copy=x.r.workspace.copy;
 for(const role of x.roles){const c=x.cx.native(x.r,role);assert.equal(c.cwd,copy,role+' trabalha na cópia desde o início');assert.equal(c.workspaceOrigin,x.cwd);}
 assert.match(x.clients.claude.logs[0].text,/PASTA DE TRABALHO/);assert.ok(x.clients.claude.logs[0].text.includes(copy));
 await x.plan();assert.equal(x.clients.claude.logs.at(-1).settings.hydraWrite,true);
 await x.implemented();assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before','escrever na cópia não mexe no projeto');
 await x.tests(`test "$(cat value.txt)" = after && test "$(cat ${x.cwd}/value.txt)" = after`).then(async ids=>{for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'O caminho original leva à cópia.',testIds:[ids[role]]});});x.finish();await x.phase('finalizing');
 assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before','aprovar os testes ainda não aplica');
 await conclude(x);await ended(x,'completed');
 assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'after');assert.match(x.r.result.text,/aplicada ao teu projeto \(1 ficheiro\)/);assert.deepEqual(x.r.workspace.applied.files,['value.txt']);assert.equal(x.r.result.unvalidated,undefined);
 for(const role of x.roles){const c=x.cx.native(x.r,role);assert.equal(c.cwd,x.cwd);assert.equal(c.workspaceOrigin,undefined);}
 assert.equal(await stat(x.r.workspace.folder).then(()=>true,()=>false),false,'a pasta privada desaparece');
});

test('cópia: uma tarefa só de leitura não a usa, um valor inválido é recusado, e sem cópia a tarefa não começa',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',requestMode:'read-only'});assert.equal(x.r.workspace,undefined);assert.equal(x.cx.native(x.r,'codex').cwd,x.cwd);
 const members=Object.fromEntries(x.roles.map(k=>[k,{model:'test',effort:'low'}]));
 await assert.rejects(x.cx.create({cwd:x.cwd,text:'x',requestId:randomUUID(),roles:x.roles,members,workspace:'outra'}),/Local de trabalho inválido/);
 const y=await setup(t,{workspace:'copy'}),before=y.cx.records.length;y.cx.enterWorkspace=async()=>{throw Error('sem espaço');};
 await y.cx.pause(y.r.id);await wait(()=>!y.cx.pauseDrains.has(y.r.id));await y.cx.stop(y.r.id);for(const k of y.roles)y.clients[k].finish(y.cx.native(y.r,k),'Fim.');await settled(y);
 const other=await mkdtemp(y.root+'/outro-');await assert.rejects(y.cx.create({cwd:other,text:'x',requestId:randomUUID(),roles:y.roles,members,workspace:'copy'}),/cópia privada: sem espaço/);assert.equal(y.cx.records.length,before);
});

test('cópia: se deixar de apontar para ela, o principal não recebe escrita',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude'});delete x.cx.native(x.r,'claude').workspaceOrigin;
 await x.positions();const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);x.finish();
 await wait(()=>x.r.status==='paused');assert.equal(x.r.pause.kind,'preflight');assert.match(x.r.error,/não aponta para a cópia/);assert.ok(Object.values(x.clients).every(client=>client.logs.every(log=>!log.settings.hydraWrite)));
 await settled(x);x.cx.native(x.r,'claude').workspaceOrigin=x.cwd;await x.cx.resume(x.r.id);await x.phase('implementing');assert.equal(x.clients.claude.logs.at(-1).settings.hydraWrite,true);
 // Each grant looks again: a copy that vanished during a pause stops everything.
 const y=await setup(t,{workspace:'copy',author:'claude'});await y.plan();await y.cx.pause(y.r.id);await settled(y);await rm(y.r.workspace.copy,{recursive:true});await assert.rejects(y.cx.resume(y.r.id),/já não existe/);
});

test('cópia: pausar, retomar e replanear ficam lá, e o projeto não vê nada disso',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude'});await x.plan();await writeFile(x.place()+'/parcial.txt','a meio');
 await x.cx.pause(x.r.id);await settled(x);for(const role of x.roles)assert.equal(x.cx.native(x.r,role).cwd,x.r.workspace.copy,'pausar não devolve a conversa');
 await x.cx.resume(x.r.id);await x.phase('implementing');assert.equal(await readFile(x.place()+'/parcial.txt','utf8'),'a meio');assert.equal(await stat(x.cwd+'/parcial.txt').then(()=>true,()=>false),false);
 await x.cx.answer(x.r.id,{requestId:'answer:replan',provider:'claude',questions:[],decision:'accept',answers:{q:'Afinal é outra coisa.'}});
 const seq=x.r.workflow.answerSeq;await x.call('claude','request_replan',{answerSeq:seq,reason:'O esclarecimento muda o plano.'});x.finish();await wait(()=>x.r.workflow.phase==='planning');
 assert.equal(x.cx.native(x.r,'claude').cwd,x.r.workspace.copy);assert.equal(await readFile(x.place()+'/parcial.txt','utf8'),'a meio');assert.equal(await stat(x.cwd+'/parcial.txt').then(()=>true,()=>false),false);
});

test('cópia: uma edição tua durante a tarefa volta aos testes com a junção, e só depois é aplicado',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude'});await writeFile(x.cwd+'/teu.txt','antes');await x.plan();await x.implemented();await approveRound(x);
 await writeFile(x.cwd+'/novo-teu.txt','editado por ti');await conclude(x);
 await wait(()=>x.r.workflow.phase==='validating'&&x.r.workflow.round===2);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before','nada foi aplicado');assert.equal(await readFile(x.place()+'/novo-teu.txt','utf8'),'editado por ti','a junção está na cópia');assert.deepEqual(x.r.workflow.reviews,{});
 await x.phase('validating');await approveRound(x);await conclude(x);await ended(x,'completed');
 assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'after');assert.equal(await readFile(x.cwd+'/novo-teu.txt','utf8'),'editado por ti');assert.equal(x.r.workflow.round,2);
});

test('cópia: os dois no mesmo ficheiro pausa sem escrever; resolvido, aplica sem gastar turnos',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude'});await x.plan();await x.implemented();await approveRound(x);await writeFile(x.cwd+'/value.txt','editado por ti');await conclude(x);
 await wait(()=>x.r.status==='paused');assert.equal(x.r.pause.kind,'workspace');assert.match(x.r.error,/mesmos ficheiros: value\.txt/);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'editado por ti');
 await settled(x);const sent=Object.values(x.clients).reduce((n,c)=>n+c.logs.length,0);await writeFile(x.cwd+'/value.txt','before');await x.cx.resume(x.r.id);await ended(x,'completed');
 assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'after');assert.equal(Object.values(x.clients).reduce((n,c)=>n+c.logs.length,0),sent);
});

test('cópia: um resultado que muda o que o Git corre espera por ti; a retoma aceita',inCopy,async t=>{
 const root=await mkdtemp('/tmp/hydra-git-');t.after(()=>rm(root,{recursive:true,force:true}));
 const x=await setup(t,{workspace:'copy',author:'claude',prepare:undefined});
 // The task of setup() has no Git; this one starts from a repository whose settings name a file the plan changes.
 await x.cx.pause(x.r.id);await settled(x);await x.cx.stop(x.r.id);for(const k of x.roles)x.clients[k].finish(x.cx.native(x.r,k),'Fim.');await settled(x);
 const cwd=root+'/p';await mkdir(cwd);await writeFile(cwd+'/value.txt','before');execFileSync('git',['init','-q'],{cwd});execFileSync('git',['config','core.fsmonitor','./value.txt'],{cwd});
 const members=Object.fromEntries(x.roles.map(k=>[k,{model:'test',effort:'low'}])),request='Implementa a alteração de value.txt para after e testa.';
 const {task}=await x.cx.create({cwd,text:request,requestId:randomUUID(),roles:x.roles,members,author:'claude',workspace:'copy'}),r=x.cx.record(task.id);await wait(()=>x.roles.every(k=>x.cx.native(r,k).status==='running'));
 const call=(role,name,args={})=>x.cx.tool([...x.cx.leases].find(([,l])=>l.role===role&&l.taskId===r.id)?.[0],name,args),read=role=>call(role,'read_dialogue'),finish=()=>{for(const k of x.roles)x.clients[k].finish(x.cx.native(r,k),'Terminado.');};
 const working=async(p,who=x.roles)=>wait(()=>r.workflow.phase===p&&who.every(k=>x.cx.native(r,k).status==='running'));
 const candidate=async text=>{for(const role of x.roles)if(r.ready[role]!==r.evidenceRevision){await wait(()=>x.cx.native(r,role).status==='running');await call(role,'ready_to_conclude',await read(role));}return (await call('claude','propose_final',{...await read('claude'),text})).candidate;};const vote=async c=>{for(const role of x.roles){await wait(()=>x.cx.native(r,role).status==='running');await call(role,'review_final',{...await read(role),candidateId:c.id,hash:c.hash,decision:'approve'});}finish();};
 for(const role of x.roles)await call(role,'initial_position',{text:'Posição',intent:'implement',authorizationQuote:request,revision:r.revision});
 await vote(await candidate('Plano.'));await working('implementing',['claude']);await writeFile(r.workspace.copy+'/value.txt','after');await call('claude','implementation_done',{...await read('claude'),summary:'Feito.'});finish();await working('validating');
 const ids={};for(const role of x.roles)ids[role]=(await call(role,'start_test',{messageId:'c',command:'test "$(cat value.txt)" = after',purpose:'Verificar.'})).test.id;await wait(()=>r.workflow.tests.every(t=>t.status!=='running'));
 for(const role of x.roles){await call(role,'read_changes');await call(role,'submit_review',{...await read(role),decision:'approve',reason:'Ok.',testIds:[ids[role]]});}finish();await working('finalizing',['claude']);await vote(await candidate('Conclusão.'));
 await wait(()=>r.status==='paused');assert.equal(r.pause.kind,'workspace-reserved');assert.match(r.error,/value\.txt/);assert.equal(await readFile(cwd+'/value.txt','utf8'),'before');
 await wait(()=>!x.cx.pauseDrains.has(r.id)&&!x.cx.jobs.has(r.id));await x.cx.resume(r.id);await wait(()=>r.status==='completed');assert.equal(await readFile(cwd+'/value.txt','utf8'),'after');
});

test('cópia: um encerramento a meio de aplicar é retomado até ao fim, mesmo com o servidor fechado',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude'});await x.plan();await writeFile(x.place()+'/a.txt','a');await writeFile(x.place()+'/b.txt','b');await x.implemented();await approveRound(x);
 x.cx.applyEnvironment={HYDRAQ_APPLY_STOP_AFTER:1};await conclude(x);await wait(()=>x.r.status==='paused');assert.equal(x.r.pause.kind,'workspace');
 delete x.cx.applyEnvironment;await settled(x);
 const written=await Promise.all(['a.txt','b.txt','value.txt'].map(f=>stat(x.cwd+'/'+f).then(()=>f,()=>null)));assert.equal(written.filter(f=>f&&f!=='value.txt').length,1,'ficou mesmo a meio');
 // The server goes away with the journal on disk, and a new one finds it.
 clearInterval(x.cx.timer);clearTimeout(x.cx.scheduled);x.cx.loaded=false;await x.cx.queue;await rm(x.cx.directory+'/owner.json');x.cx.ownsLock=false;
 const recovered=new ClaudeX({hub:x.hub,directory:x.cx.directory,prepare:x.cx.prepare});await recovered.load();assert.equal(recovered.error,undefined);
 const r=recovered.record(x.r.id);assert.equal(r.status,'paused');assert.equal(await stat(r.workspace.folder+'/aplicacao/plano.json').then(()=>true,()=>false),true);
 await recovered.resume(r.id);await wait(()=>r.status==='completed'&&r.workspace.left);assert.equal(await readFile(x.cwd+'/a.txt','utf8'),'a');assert.equal(await readFile(x.cwd+'/b.txt','utf8'),'b');assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'after');assert.equal(r.result.unvalidated,undefined);assert.equal(await stat(r.workspace.folder).then(()=>true,()=>false),false);
 await recovered.close();x.r.status='completed';x.cx.raw=await readFile(x.cx.directory+'/state.json','utf8');
});

test('cópia na mesma conversa: parar devolve a conversa, o trabalho fica na cópia e o projeto intacto',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'codex',conversation:true});const copy=x.r.workspace.copy;await x.plan();await writeFile(copy+'/value.txt','a meio');
 await x.cx.stop(x.r.id);for(const k of x.roles)x.clients[k].finish(x.cx.native(x.r,k),'Fim.');await wait(()=>x.r.released);
 const c=x.cx.native(x.r,'codex');assert.equal(c.cwd,x.cwd);assert.equal(c.workspaceOrigin,undefined);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before');assert.equal(await readFile(copy+'/value.txt','utf8'),'a meio');
 assert.equal(c.hydraReturn.kept,copy);assert.equal(c.hydraReturn.unvalidated,undefined);assert.match(hydraReturnNote(c.hydraReturn),/ficou na cópia privada/);assert.equal(x.r.unvalidated,undefined);
 // On the next start, a folder with no task is removed; this one still has its task.
 const orphan=path.join(x.cx.directory,'workspaces','sem-tarefa');await mkdir(orphan,{recursive:true});await x.cx.sweepWorkspaces();assert.equal(await stat(orphan).then(()=>true,()=>false),false);assert.equal(await stat(copy).then(()=>true,()=>false),true);
});

test('cópia na mesma conversa: no fim volta à pasta do projeto, com as definições anteriores',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'codex',conversation:true});await x.plan();await x.implemented();await approveRound(x);await conclude(x);await wait(()=>x.r.released);
 assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'after');for(const role of x.roles)assert.equal(x.cx.native(x.r,role).cwd,x.cwd);assert.equal(x.cx.native(x.r,'codex').hydraReturn.kept,undefined);
});

const halfApplied=async(x,stopAfter=1)=>{
 await x.plan();await writeFile(x.place()+'/a-mais-longo.txt','a');await writeFile(x.place()+'/b-mais-longo.txt','b');await x.implemented();await approveRound(x);
 x.cx.applyEnvironment={HYDRAQ_APPLY_STOP_AFTER:stopAfter};await conclude(x);await wait(()=>x.r.status==='paused');await settled(x);delete x.cx.applyEnvironment;
};
const planOf=x=>x.r.workspace.folder+'/aplicacao/plano.json',there=file=>stat(file).then(()=>true,()=>false);

test('cópia: parar a meio de aplicar desfaz o que foi escrito e o trabalho fica na cópia',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude',conversation:true});await halfApplied(x);
 assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'after','ficou mesmo a meio');assert.equal(await there(x.cwd+'/a-mais-longo.txt'),false);assert.equal(x.r.workspace.applying,true);assert.equal(await there(planOf(x)),true);
 const copy=x.r.workspace.copy;await x.cx.stop(x.r.id);for(const k of x.roles)x.clients[k].finish(x.cx.native(x.r,k),'Fim.');await wait(()=>x.r.released);
 assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before','o projeto volta ao que era');assert.match(x.r.error,/foi desfeito/);assert.equal(await there(planOf(x)),false);
 assert.equal(await readFile(copy+'/value.txt','utf8'),'after','o trabalho aprovado não se perde');assert.equal(await readFile(copy+'/a-mais-longo.txt','utf8'),'a');
 const c=x.cx.native(x.r,'claude');assert.equal(c.hydraReturn.kept,copy);assert.match(hydraReturnNote(c.hydraReturn),/não foi aplicado ficou na cópia privada/);
});

test('cópia: parar a meio com uma edição tua no caminho guarda tudo e diz onde; resolvido, a retoma acaba',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude',conversation:true});await halfApplied(x);await writeFile(x.cwd+'/value.txt','EDIÇÃO TUA');
 const folder=x.r.workspace.folder;await x.cx.stop(x.r.id);for(const k of x.roles)x.clients[k].finish(x.cx.native(x.r,k),'Fim.');await settled(x);
 assert.equal(x.r.status,'interrupted');assert.match(x.r.error,/parcialmente alterado/);assert.ok(x.r.error.includes(folder),'diz onde está a recuperação');assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'EDIÇÃO TUA');assert.equal(await there(planOf(x)),true);
 await new Promise(r=>setTimeout(r,1300));assert.equal(x.r.released,undefined,'a conversa não é devolvida com o projeto a meio');assert.equal(x.r.workspace.left,undefined);for(const role of x.roles)assert.equal(x.cx.native(x.r,role).cwd,x.r.workspace.copy);
 // Parar outra vez continua a não apagar nada.
 await x.cx.stop(x.r.id);await settled(x);assert.equal(await there(planOf(x)),true);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'EDIÇÃO TUA');
 await writeFile(x.cwd+'/value.txt','after');await x.cx.resume(x.r.id);await wait(()=>x.r.released);
 assert.equal(x.r.status,'completed');assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'after');assert.equal(await readFile(x.cwd+'/a-mais-longo.txt','utf8'),'a');assert.equal(await readFile(x.cwd+'/b-mais-longo.txt','utf8'),'b');
});

test('cópia: fechar o servidor a meio de aplicar não apaga nada do que a recuperação precisa',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude'});await halfApplied(x);await x.cx.close();assert.equal(await there(planOf(x)),true);assert.equal(await there(x.r.workspace.copy),true);
 await rm(x.cx.directory+'/owner.json',{force:true});x.cx.ownsLock=false;const recovered=new ClaudeX({hub:x.hub,directory:x.cx.directory,prepare:x.cx.prepare});await recovered.load();assert.equal(recovered.error,undefined);
 const r=recovered.record(x.r.id);assert.equal(r.workspace.applying,true);assert.equal(await there(planOf(x)),true);await recovered.close();x.cx.raw=await readFile(x.cx.directory+'/state.json','utf8');
});

test('cópia: uma versão aprovada depois de uma interrupção é a que chega ao projeto, inteira',inCopy,async t=>{
 for(const stopAfter of [0,2]){
  const x=await setup(t,{workspace:'copy',author:'claude',conversation:true});await halfApplied(x,stopAfter);const previous=x.r.workflow.validatedHash;
  await writeFile(x.place()+'/candidato-novo.txt','aprovado depois');await x.cx.resume(x.r.id);await x.phase('validating');assert.equal(x.r.workflow.round,2);
  // The project does not wait half-way through the old version for the whole of the new round.
  assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before');assert.equal(await there(planOf(x)),false);assert.equal(x.r.workspace.applying,false);
  const ids=await x.tests('test "$(cat value.txt)" = after && test -f candidato-novo.txt');for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Testada a versão nova.',testIds:[ids[role]]});x.finish();await x.phase('finalizing');assert.notEqual(x.r.workflow.validatedHash,previous);
  await conclude(x);await wait(()=>x.r.released);assert.equal(x.r.status,'completed');
  assert.equal(await readFile(x.cwd+'/candidato-novo.txt','utf8'),'aprovado depois','stopAfter '+stopAfter);assert.equal(await readFile(x.cwd+'/a-mais-longo.txt','utf8'),'a');assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'after');
 }
});

test('cópia: o que tem gravado o caminho da cópia recebe o do projeto antes de testar; um binário volta ao principal',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude'});await x.plan();const copy=x.place();
 await writeFile(copy+'/modulo.so',Buffer.concat([Buffer.from([0]),Buffer.from(copy)]));await symlink(copy+'/value.txt',copy+'/atalho');await writeFile(copy+'/config.txt','raiz='+copy+'\n');await writeFile(copy+'/value.txt','after');
 await x.call('claude','implementation_done',{...await x.read('claude'),summary:'Feito.'});x.finish();
 await wait(()=>x.r.messages.some(m=>m.from==='coordinator'&&/caminho da cópia/.test(m.text)));await x.phase('implementing');assert.equal(x.r.workflow.implementation,null);assert.equal(x.r.workflow.snapshot,undefined);
 assert.match(x.r.messages.filter(m=>m.from==='coordinator').at(-1).text,/modulo\.so/);
 await rm(copy+'/modulo.so');await x.implemented();await approveRound(x);await conclude(x);await ended(x,'completed');
 assert.equal(await readlink(x.cwd+'/atalho'),x.cwd+'/value.txt');assert.equal(await readFile(x.cwd+'/atalho','utf8'),'after');assert.equal(await readFile(x.cwd+'/config.txt','utf8'),'raiz='+x.cwd+'\n');assert.equal(await there(x.cwd+'/modulo.so'),false);
 // If it keeps coming back, the user is told.
 const y=await setup(t,{workspace:'copy',author:'claude'});await y.plan();const place=y.place();await writeFile(place+'/modulo.so',Buffer.concat([Buffer.from([0]),Buffer.from(place)]));
 for(const attempt of [1,2,3]){await y.call('claude','implementation_done',{...await y.read('claude'),summary:'Feito.'});y.finish();if(attempt<3)await wait(()=>y.r.workflow.implementation===null&&y.cx.native(y.r,'claude').status==='running');}
 await wait(()=>y.r.status==='paused');assert.equal(y.r.pause.kind,'workspace');assert.match(y.r.error,/modulo\.so/);
});

test('cópia: uma versão nova ou um pedido novo não avançam enquanto a aplicação a meio não puder ser desfeita',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude'});await halfApplied(x);await writeFile(x.place()+'/mais.txt','novo');await writeFile(x.cwd+'/value.txt','EDIÇÃO TUA');
 await assert.rejects(x.cx.resume(x.r.id),/ficou a meio/);assert.equal(x.r.status,'paused');assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'EDIÇÃO TUA');
 await assert.rejects(x.cx.resume(x.r.id,{requestId:'novo',text:'Afinal é outra coisa.'}),/ficou a meio/);assert.equal(x.r.workflow.phase,'finalizing');assert.equal(await there(planOf(x)),true);
 await writeFile(x.cwd+'/value.txt','after');await x.cx.resume(x.r.id,{requestId:'novo-2',text:'Afinal é outra coisa.'});assert.equal(x.r.workflow.phase,'planning');assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before','desfeito antes de replanear');assert.equal(await there(planOf(x)),false);
});

test('cópia: o indicador de aplicação não fica preso depois de um encerramento sem plano',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'codex',conversation:true});await x.plan();x.r.workspace.applying=true;await x.cx.stop(x.r.id);for(const k of x.roles)x.clients[k].finish(x.cx.native(x.r,k),'Fim.');await wait(()=>x.r.released);assert.equal(x.r.workspace.applying,false);
 // On a restart it is read from the disk.
 const y=await setup(t,{workspace:'copy',author:'claude'});await y.plan();await y.cx.pause(y.r.id);await settled(y);y.r.workspace.applying=true;await y.cx.serial(()=>y.cx.persist());await y.cx.close();await rm(y.cx.directory+'/owner.json',{force:true});y.cx.ownsLock=false;
 const recovered=new ClaudeX({hub:y.hub,directory:y.cx.directory,prepare:y.cx.prepare});await recovered.load();assert.equal(recovered.record(y.r.id).workspace.applying,false);await recovered.close();y.cx.raw=await readFile(y.cx.directory+'/state.json','utf8');
});

test('fluxo normal, sem a cópia: uma alias longa não impede a tarefa de começar, e nenhum segredo da configuração fica no estado',{skip:noBwrap},async t=>{
 const home=await mkdtemp('/tmp/hydra-global-');t.after(()=>{delete process.env.GIT_CONFIG_GLOBAL;return rm(home,{recursive:true,force:true});});await writeFile(home+'/g.cfg','[alias]\n\tgrande = !f() { echo '+'z'.repeat(400)+'; }; f\n[http]\n\textraHeader = Authorization: Bearer eyJ.SEGREDO.assinatura\n');process.env.GIT_CONFIG_GLOBAL=home+'/g.cfg';
 const x=await setup(t,{author:'claude'});execFileSync('git',['init','-q'],{cwd:x.cwd});execFileSync('git',['config','http.extraHeader','Authorization: Bearer eyJ.SEGREDO.local'],{cwd:x.cwd});await x.plan();assert.equal(x.r.workflow.phase,'implementing',String(x.r.error));assert.ok(x.r.workflow.reserved);
 await x.cx.serial(()=>x.cx.persist());assert.doesNotMatch(await readFile(path.join(x.cx.directory,'state.json'),'utf8'),/SEGREDO/);assert.doesNotMatch(JSON.stringify(x.cx.detail(x.r.id)),/SEGREDO/);
});

test('a publicação que pausa ao aplicar termina a drenagem sem ajuda do utilizador',inCopy,async t=>{
 for(const kind of ['partial','conflict','reserved']){
  const x=await setup(t,{workspace:'copy',author:'claude'});await x.plan();await x.implemented();await approveRound(x);
  if(kind==='partial')x.cx.applyEnvironment={HYDRAQ_APPLY_STOP_AFTER:0};
  if(kind==='conflict')await writeFile(x.cwd+'/value.txt','EDIÇÃO TUA');
  if(kind==='reserved'){execFileSync('git',['init','-q'],{cwd:x.cwd});execFileSync('git',['config','core.fsmonitor','./value.txt'],{cwd:x.cwd});}
  await conclude(x);await wait(()=>x.r.status==='paused');await wait(()=>!x.cx.jobs.has(x.r.id)&&!x.cx.pauseDrains.has(x.r.id)&&x.r.pause.draining===false);
  assert.equal(x.r.pause.interruptionPending,false);assert.equal(x.r.workspace.applying,kind==='partial');
  delete x.cx.applyEnvironment;
 }
});

test('uma exceção antes do diário repõe applying e a pausa termina',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude'});await x.plan();await x.implemented();await approveRound(x);await rm(x.r.workspace.validated.directory+'.json');await conclude(x);
 await wait(()=>x.r.status==='paused');await wait(()=>x.r.pause?.draining===false&&!x.cx.jobs.has(x.r.id));assert.equal(x.r.workspace.applying,false);assert.equal(await there(planOf(x)),false);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before');
});

const retained=async(t,extra={})=>{
 const x=await setup(t,{workspace:'copy',author:'claude',conversation:true,...extra});await halfApplied(x);await x.cx.stop(x.r.id);x.finish();await wait(()=>x.r.released&&!x.cx.jobs.has(x.r.id));return x;
};
test('a cópia guardada é aplicada sem acordar modelos e apagada só com confirmação',inCopy,async t=>{
 const x=await retained(t),turns=Object.values(x.clients).map(client=>client.logs.length),folder=x.r.workspace.folder;
 assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before');let detail=await x.cx.applySavedWorkspace(x.r.id);
 assert.equal(detail.workspace.applied.manual,true);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'after');assert.equal(await readFile(x.cwd+'/a-mais-longo.txt','utf8'),'a');assert.equal(await there(folder),false,'já aplicada, a cópia não fica a ocupar disco');assert.ok(detail.workspace.removed);assert.equal(detail.workspace.kept,false);
 assert.deepEqual(Object.values(x.clients).map(client=>client.logs.length),turns);assert.ok(x.roles.every(role=>x.cx.native(x.r,role).cwd===x.cwd));
 detail=await x.cx.applySavedWorkspace(x.r.id);assert.ok(detail.workspace.applied,'um segundo clique não é um erro');await assert.rejects(x.cx.deleteSavedWorkspace(x.r.id,{confirm:true}),/não tem uma cópia/);
 const y=await retained(t),other=y.r.workspace.folder;await assert.rejects(y.cx.deleteSavedWorkspace(y.r.id,{}),/Confirma explicitamente/);assert.equal(await there(other),true);
 detail=await y.cx.deleteSavedWorkspace(y.r.id,{confirm:true});assert.equal(detail.workspace.kept,false);assert.ok(detail.workspace.removed);assert.equal(await there(other),false);assert.equal(await readFile(y.cwd+'/value.txt','utf8'),'before');
});

test('aplicar a cópia guardada recusa projeto, código ou dependências diferentes da versão aprovada',inCopy,async t=>{
 for(const change of ['original','copy','dependency']){
  const x=await retained(t);
  if(change==='original')await writeFile(x.cwd+'/outro.txt','TEU');
  else if(change==='copy')await writeFile(x.r.workspace.copy+'/value.txt','NÃO TESTADO');
  else{await mkdir(x.r.workspace.copy+'/node_modules/dep',{recursive:true});await writeFile(x.r.workspace.copy+'/node_modules/dep/index.js','2');}
  if(change==='original'){const d=await x.cx.applySavedWorkspace(x.r.id);assert.match(d.workspace.actionError,/projeto mudou/);}
  else await assert.rejects(x.cx.applySavedWorkspace(x.r.id),/cópia mudou/);
  assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before');assert.equal(await there(x.cwd+'/a-mais-longo.txt'),false);assert.equal(await there(planOf(x)),false);assert.equal(x.r.workspace.applying,false);
 }
});

test('aplicar cópia guardada respeita reserva e aprovação; apagar nunca remove um diário pendente',inCopy,async t=>{
 const x=await retained(t);x.hub.closing=true;await assert.rejects(x.cx.deleteSavedWorkspace(x.r.id,{confirm:true}),/indisponível/);x.hub.closing=false;assert.equal(await there(x.r.workspace.folder),true);x.hub.reservations.set('other',{cwd:x.cwd,resources:[],kind:'test',id:'other'});await assert.rejects(x.cx.applySavedWorkspace(x.r.id));x.hub.reservations.delete('other');assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before');
 delete x.r.workflow.validatedVersion;await assert.rejects(x.cx.applySavedWorkspace(x.r.id),/testada e aprovada/);
 const y=await retained(t);y.cx.applyEnvironment={HYDRAQ_APPLY_STOP_AFTER:1};const pending=await y.cx.applySavedWorkspace(y.r.id);assert.equal(pending.workspace.applying,true);await assert.rejects(y.cx.deleteSavedWorkspace(y.r.id,{confirm:true}),/aplicação por concluir/);assert.equal(await there(planOf(y)),true);
 delete y.cx.applyEnvironment;await y.cx.stop(y.r.id);await settled(y);assert.equal(await readFile(y.cwd+'/value.txt','utf8'),'before');assert.equal(await there(planOf(y)),false);await y.cx.deleteSavedWorkspace(y.r.id,{confirm:true});assert.equal(await there(y.r.workspace.folder),false);
});

test('reiniciar limpa a operação de uma cópia devolvida quando não chegou a criar diário',inCopy,async t=>{
 const x=await retained(t);x.r.workspace.action='apply';x.r.workspace.applying=true;await x.cx.persist();await x.cx.close();await rm(x.cx.directory+'/owner.json',{force:true});x.cx.ownsLock=false;
 const recovered=new ClaudeX({hub:x.hub,directory:x.cx.directory,prepare:x.cx.prepare});await recovered.load();assert.equal(recovered.error,undefined);const r=recovered.record(x.r.id);
 assert.equal(r.workspace.action,undefined);assert.equal(r.workspace.applying,false);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before');
 await recovered.close();x.cx.raw=await readFile(x.cx.directory+'/state.json','utf8');
});

test('uma exceção na cópia guardada não deixa ação nem reserva presas antes do diário',inCopy,async t=>{
 const x=await retained(t);await rm(x.r.workspace.validated.directory+'.json');await assert.rejects(x.cx.applySavedWorkspace(x.r.id));
 assert.equal(x.r.workspace.applying,false);assert.equal(x.r.workspace.action,undefined);assert.equal([...x.hub.reservations.keys()].some(key=>key.startsWith('claudex-saved:')),false);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before');
 await x.cx.deleteSavedWorkspace(x.r.id,{confirm:true});assert.equal(await there(x.r.workspace.folder),false);
});

test('cópia guardada: com a aplicação a meio, só a pasta do projeto fica reservada',inCopy,async t=>{
 const x=await retained(t),elsewhere=x.root+'/outro-projeto';await mkdir(elsewhere);const other=(await x.hub.create({provider:'codex',cwd:elsewhere,model:'test',effort:'low',sandbox:'workspace-write'})).id;
 x.cx.applyEnvironment={HYDRAQ_APPLY_STOP_AFTER:1};await x.cx.applySavedWorkspace(x.r.id);delete x.cx.applyEnvironment;assert.equal(x.r.workspace.applying,true);
 const scope=x.cx.scopes().find(item=>item.id===x.r.id);assert.deepEqual(scope.resources,[]);assert.match(scope.reason,/Aplicação por concluir/);
 await assert.rejects(x.hub.send(x.r.origin.conversationId,'Trabalha.','aqui-'+randomUUID(),{}),/Aplicação por concluir/,'na mesma pasta não se escreve');
 await x.hub.send(other,'Trabalha noutra pasta.','ali-'+randomUUID(),{});
});

test('cópia guardada: o que o Git usa pede confirmação, que só vale para essa lista',inCopy,async t=>{
 const prepare=async({cwd})=>{execFileSync('git',['init','-q'],{cwd});execFileSync('git',['config','core.fsmonitor','./value.txt'],{cwd});};
 const x=await retained(t,{prepare});let detail=await x.cx.applySavedWorkspace(x.r.id);
 assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before');assert.deepEqual(Object.keys(detail.workspace.actionConfirm),['value.txt']);assert.match(detail.workspace.actionError,/Git usa: value\.txt/);assert.equal(detail.workspace.applied,undefined);
 await assert.rejects(x.cx.applySavedWorkspace(x.r.id,{confirm:{'value.txt':'outra coisa'}}),/Revê a lista/,'uma página desatualizada não confirma');assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before');
 await assert.rejects(x.cx.applySavedWorkspace(x.r.id,{confirm:{...detail.workspace.actionConfirm,'outro.sh':'1'}}),/Revê a lista/);
 detail=await x.cx.applySavedWorkspace(x.r.id,{confirm:x.r.workspace.actionConfirm});assert.ok(detail.workspace.applied,String(detail.workspace.actionError));assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'after');assert.equal(detail.workspace.actionConfirm,undefined);
 // Without having been asked, there is nothing to confirm.
 const y=await retained(t);await assert.rejects(y.cx.applySavedWorkspace(y.r.id,{confirm:{}}),/Revê a lista/);assert.equal(await readFile(y.cwd+'/value.txt','utf8'),'before');
});

test('cópia guardada: se a pasta já desapareceu, a tarefa não fica presa num erro',inCopy,async t=>{
 const x=await retained(t),note=()=>x.cx.native(x.r,x.r.author).hydraReturn;assert.ok(note().kept);await rm(x.r.workspace.folder,{recursive:true,force:true});
 const detail=await x.cx.deleteSavedWorkspace(x.r.id,{confirm:true});assert.equal(detail.workspace.kept,false);assert.ok(detail.workspace.removed);assert.equal(note().kept,undefined);
 const y=await retained(t);await rm(y.r.workspace.folder,{recursive:true,force:true});await assert.rejects(y.cx.applySavedWorkspace(y.r.id),/já não existe/);assert.equal(y.r.workspace.kept,false);assert.equal(await readFile(y.cwd+'/value.txt','utf8'),'before');
 // Only the project inside gone: it cannot be applied, and it can still be deleted.
 const z=await retained(t);await rm(z.r.workspace.copy,{recursive:true,force:true});await assert.rejects(z.cx.applySavedWorkspace(z.r.id),/não é segura/);await z.cx.deleteSavedWorkspace(z.r.id,{confirm:true});assert.equal(await there(z.r.workspace.folder),false);
});

test('cópia: com a pasta de dados por uma ligação simbólica, a tarefa corre até ao fim',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude',dataLink:true});assert.ok(x.r.workspace.folder.includes('/dados-reais/'),'guarda o caminho real');await x.plan();await x.implemented();await approveRound(x);await conclude(x);await ended(x,'completed');assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'after');
 const y=await retained(t,{dataLink:true});const detail=await y.cx.applySavedWorkspace(y.r.id);assert.ok(detail.workspace.applied,String(detail.workspace.actionError));assert.equal(await readFile(y.cwd+'/value.txt','utf8'),'after');
});

test('uma recusa da cópia guardada diz uma só vez que nada foi escrito',inCopy,async t=>{
 const x=await retained(t);await writeFile(x.cwd+'/outro.txt','TEU');const detail=await x.cx.applySavedWorkspace(x.r.id);assert.equal((detail.workspace.actionError.match(/Nada foi/g)||[]).length,1,detail.workspace.actionError);
});

const restartRetained=async x=>{
 await x.cx.close();
 const recovered=new ClaudeX({hub:x.hub,directory:x.cx.directory,prepare:x.cx.prepare});await recovered.load();
 x.hub.claudex=x.cx=recovered;x.r=recovered.record(x.r.id);assert.equal(recovered.error,undefined);
};
const pendingRetained=async t=>{
 const x=await retained(t);x.cx.applyEnvironment={HYDRAQ_APPLY_STOP_AFTER:1};
 try{await x.cx.applySavedWorkspace(x.r.id);}finally{delete x.cx.applyEnvironment;}
 assert.equal(x.r.workspace.applying,true);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'after');return x;
};
const accessCopy={...inCopy,skip:noBwrap||(process.getuid?.()===0?'root não reproduz EACCES por permissões':false)};

test('cópia inacessível não é marcada como removida nem perde trabalho por aplicar',accessCopy,async t=>{
 const x=await retained(t),parent=path.dirname(x.r.workspace.folder);
 await fsp.chmod(parent,0);
 try{
  for(const action of ['applySavedWorkspace','deleteSavedWorkspace'])await assert.rejects(x.cx[action](x.r.id,{confirm:true}),/Repõe o acesso/);
  assert.equal(x.r.workspace.kept,true);assert.equal(x.r.workspace.removed,undefined);assert.equal(x.r.workspace.applying,false);
  assert.ok(x.cx.native(x.r,x.r.author).hydraReturn.kept);
 }finally{await fsp.chmod(parent,0o700);}
 await restartRetained(x);assert.equal(await there(x.r.workspace.folder),true);
 await x.cx.applySavedWorkspace(x.r.id);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'after');assert.ok(x.r.workspace.applied);
});

test('acesso perdido durante aplicação conserva diário e reserva, também no reinício, e permite desfazer',accessCopy,async t=>{
 const x=await pendingRetained(t),parent=path.dirname(x.r.workspace.folder);
 await fsp.chmod(parent,0);
 try{
  for(const action of ['applySavedWorkspace','deleteSavedWorkspace'])await assert.rejects(x.cx[action](x.r.id,{confirm:true}),/Repõe o acesso/);
  await restartRetained(x);
  assert.equal(x.r.workspace.applying,true);assert.equal(x.r.workspace.kept,true);assert.equal(x.r.workspace.removed,undefined);
  await assert.rejects(x.hub.send(x.r.origin.conversationId,'Trabalha.','acesso-'+randomUUID(),{}),/Aplicação por concluir/);
 }finally{await fsp.chmod(parent,0o700);}
 await restartRetained(x);assert.equal(await there(planOf(x)),true);assert.equal(await there(x.r.workspace.copy),true);
 await x.cx.stop(x.r.id);assert.equal(x.r.workspace.applying,false);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before');assert.equal(await there(planOf(x)),false);
});

test('pasta temporariamente ausente com aplicação pendente mantém a reserva e não é limpa como órfã',inCopy,async t=>{
 const x=await pendingRetained(t),folder=x.r.workspace.folder,moved=folder+'-deslocada';await fsp.rename(folder,moved);
 try{
  await assert.rejects(x.cx.deleteSavedWorkspace(x.r.id,{confirm:true}),/aplicação por concluir/);
  await restartRetained(x);assert.equal(x.r.workspace.applying,true);assert.equal(x.r.workspace.removed,undefined);
  assert.equal(await there(moved+'/aplicacao/plano.json'),true,'o diário deslocado não é lixo órfão');
  await assert.rejects(x.hub.send(x.r.origin.conversationId,'Trabalha.','ausente-'+randomUUID(),{}),/Aplicação por concluir/);
  await x.cx.stop(x.r.id);assert.equal(x.r.workspace.applying,true,'parar sem acesso ao diário não confirma um desfazer');
 }finally{await fsp.rename(moved,folder);}
 await x.cx.stop(x.r.id);assert.equal(x.r.workspace.applying,false);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before');
});

test('diário sobrevivente corrige a marca removed antiga antes da limpeza e fica disponível para desfazer',inCopy,async t=>{
 const x=await pendingRetained(t);x.r.workspace.removed=new Date().toISOString();x.r.workspace.kept=false;x.r.workspace.applying=false;await x.cx.persist();
 await x.cx.sweepWorkspaces();assert.equal(await there(planOf(x)),true,'a limpeza verifica o diário mesmo com removed gravado');
 await restartRetained(x);assert.equal(x.r.workspace.removed,undefined);assert.equal(x.r.workspace.kept,true);assert.equal(x.r.workspace.applying,true);assert.equal(await there(x.r.workspace.copy),true);
 const saved=JSON.parse(await readFile(x.cx.directory+'/state.json','utf8')).conversations.find(r=>r.id===x.r.id);assert.equal(saved.workspace.removed,undefined);assert.equal(saved.workspace.applying,true);
 await assert.rejects(x.cx.deleteSavedWorkspace(x.r.id,{confirm:true}),/aplicação por concluir/);
 await x.cx.stop(x.r.id);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before');assert.equal(x.r.workspace.applying,false);
});

test('cópia: uma tarefa pausada com a aplicação a meio reserva só a pasta, e pode retomar',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude'});await halfApplied(x);const members=Object.fromEntries(x.roles.map(k=>[k,{model:'test',effort:'low'}])),scope=x.cx.scopes().find(item=>item.id===x.r.id);assert.deepEqual(scope.resources,[]);assert.match(scope.reason,/Aplicação por concluir/);
 await assert.rejects(x.cx.create({text:'Outra.',requestId:randomUUID(),roles:x.roles,members,author:'claude',cwd:x.cwd,workspace:'copy'}),/Aplicação por concluir/,'uma tarefa nova partia do projeto a meio');
 const elsewhere=x.root+'/outro-projeto';await mkdir(elsewhere);const other=(await x.hub.create({provider:'codex',cwd:elsewhere,model:'test',effort:'low',sandbox:'workspace-write'})).id;await x.hub.send(other,'Trabalha noutra pasta.','ali-'+randomUUID(),{});x.clients.codex.finish(x.clients.codex.conversation(other),'Fim.');await wait(()=>x.clients.codex.conversation(other).status!=='running');
 await x.cx.resume(x.r.id);await ended(x,'completed');assert.equal(await readFile(x.cwd+'/a-mais-longo.txt','utf8'),'a');assert.equal(x.cx.scopes().some(item=>item.id===x.r.id),false,'a reserva acaba com a aplicação');
});

test('cópia: pasta privada apagada a meio de aplicar: não fica bloqueada para sempre, e só com confirmação',inCopy,async t=>{
 const x=await retained(t),folder=x.r.workspace.folder;x.cx.applyEnvironment={HYDRAQ_APPLY_STOP_AFTER:1};await x.cx.applySavedWorkspace(x.r.id);delete x.cx.applyEnvironment;assert.equal(x.r.workspace.applying,true);
 // While the folder is there, the recovery is what counts.
 await assert.rejects(x.cx.releaseLostWorkspace(x.r.id,{confirm:true}),/existe/);assert.equal(x.r.workspace.applying,true);
 await rm(folder,{recursive:true,force:true});await x.cx.stop(x.r.id);await settled(x);assert.equal(x.r.workspace.folderLost,true);assert.match(x.r.error,/desapareceu/);assert.doesNotMatch(x.r.error,/recuperação está em/,'não aponta para uma pasta que não existe');assert.ok(x.cx.scopes().some(item=>item.id===x.r.id));
 await assert.rejects(x.cx.releaseLostWorkspace(x.r.id,{}),/Confirma/);assert.ok(x.cx.scopes().some(item=>item.id===x.r.id));
 const detail=await x.cx.releaseLostWorkspace(x.r.id,{confirm:true});assert.equal(detail.workspace.applying,false);assert.ok(detail.workspace.lost);assert.ok(detail.workspace.removed);assert.equal(x.cx.scopes().some(item=>item.id===x.r.id),false);assert.match(x.r.error,/libertado/);
 assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'after','o projeto fica como estava');const again=(await x.hub.create({provider:'codex',cwd:x.cwd,model:'test',effort:'low',sandbox:'workspace-write'})).id;await x.hub.send(again,'Trabalha.','depois-'+randomUUID(),{});
 await assert.rejects(x.cx.releaseLostWorkspace(x.r.id,{confirm:true}),/não tem uma aplicação/);
});

test('cópia: libertar também serve uma tarefa ainda não devolvida, e devolve a conversa com o aviso',inCopy,async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude',conversation:true});await halfApplied(x);const folder=x.r.workspace.folder;await rm(folder,{recursive:true,force:true});
 await assert.rejects(x.cx.resume(x.r.id),/desapareceu/);await x.cx.stop(x.r.id);x.finish();await settled(x);assert.equal(x.r.workspace.folderLost,true);
 await x.cx.releaseLostWorkspace(x.r.id,{confirm:true});await wait(()=>x.r.released);for(const role of x.roles){const c=x.cx.native(x.r,role);assert.equal(c.cwd,x.cwd);assert.equal(c.workspaceOrigin,undefined);}
 const note=x.cx.native(x.r,'claude').hydraReturn;assert.equal(note.lost,true);assert.match(hydraReturnNote(note),/parte da versão aplicada/);assert.equal(note.kept,undefined);
});

test('cópia: com a pasta inacessível, libertar é recusado; se voltar, desfaz normalmente',inCopy,async t=>{
 const x=await retained(t),folder=x.r.workspace.folder,parent=path.dirname(folder);x.cx.applyEnvironment={HYDRAQ_APPLY_STOP_AFTER:1};await x.cx.applySavedWorkspace(x.r.id);delete x.cx.applyEnvironment;t.after(()=>chmod(parent,0o755).catch(()=>{}));
 await chmod(parent,0);await assert.rejects(x.cx.releaseLostWorkspace(x.r.id,{confirm:true}),/aceder/);assert.equal(x.r.workspace.applying,true);await x.cx.stop(x.r.id);await settled(x);assert.equal(x.r.workspace.folderLost,undefined,'um erro de acesso não diz que desapareceu');await chmod(parent,0o755);
 // Moved away and put back: the same.
 await rename(folder,folder+'-longe');await x.cx.stop(x.r.id);await settled(x);assert.equal(x.r.workspace.folderLost,true);await rename(folder+'-longe',folder);await x.cx.stop(x.r.id);await wait(()=>x.r.workspace.applying===false);await settled(x);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before');assert.equal(x.r.workspace.folderLost,undefined);assert.ok(!x.r.workspace.lost);
});

test('cópia: depois de reiniciar, a pasta apagada a meio já aparece como perdida',inCopy,async t=>{
 const x=await retained(t);x.cx.applyEnvironment={HYDRAQ_APPLY_STOP_AFTER:1};await x.cx.applySavedWorkspace(x.r.id);delete x.cx.applyEnvironment;await rm(x.r.workspace.folder,{recursive:true,force:true});await x.cx.close();await rm(x.cx.directory+'/owner.json',{force:true});x.cx.ownsLock=false;
 const again=new ClaudeX({hub:x.hub,directory:x.cx.directory,prepare:x.cx.prepare});await again.load();const r=again.record(x.r.id);assert.equal(r.workspace.applying,true);assert.equal(r.workspace.folderLost,true);await again.releaseLostWorkspace(r.id,{confirm:true});assert.equal(again.scopes().some(item=>item.id===r.id),false);await again.close();x.cx.raw=await readFile(x.cx.directory+'/state.json','utf8');
});

const vote=async(x,c,role,decision='approve',reason='A versão tem um erro concreto em value.txt.')=>wait(()=>x.cx.native(x.r,role).status==='running').then(async()=>x.raw(role,'review_final',{...await x.read(role),candidateId:c.id,hash:c.hash,decision,...(decision==='approve'?{}:{reason})}));
test('votos, revisões e testes dos colegas só se veem depois de entregar os próprios',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.positions();const c=await x.candidate();await vote(x,c,'codex');await vote(x,c,'claude','changes');
 const before=await x.read('antigravity');
 assert.deepEqual(before.workflow.votes,{});assert.deepEqual(before.approvals,{});assert.equal(before.candidate.votes,undefined);assert.equal(before.candidate.id,c.id);
 const seen=await vote(x,c,'antigravity');assert.equal(seen.votes.claude.decision,'changes');
 const after=await x.read('antigravity');assert.equal(after.workflow.votes.codex.decision,'approve');assert.ok(after.approvals.codex);assert.equal(after.candidate.votes.claude.decision,'changes');
 x.finish();await x.answerObjection();x.finish();await x.phase('implementing');await x.implemented();
 const ids=await x.tests();
 assert.deepEqual((await x.raw('claude','test_status')).tests.map(test=>test.role),['claude']);
 assert.deepEqual((await x.read('claude')).workflow.tests.map(test=>test.role),['claude']);
 await x.call('codex','submit_review',{...await x.read('codex'),decision:'approve',reason:'Verificado.',testIds:[ids.codex]});
 const hidden=(await x.read('claude')).workflow;assert.deepEqual(hidden.reviews,{});assert.equal(hidden.rounds.at(-1).reviews,undefined);
 assert.ok((await x.read('codex')).workflow.reviews.codex);
 assert.deepEqual((await x.raw('codex','test_status')).tests.map(test=>test.role).sort(),['antigravity','claude','codex']);
 await x.call('claude','submit_review',{...await x.read('claude'),decision:'approve',reason:'Verificado.',testIds:[ids.claude]});
 assert.equal((await x.read('claude')).workflow.reviews.codex.decision,'approve');
 // What earlier rounds decided stays readable: the fix depends on it.
 assert.equal((await x.read('antigravity')).workflow.approvedPlan.votes.claude.decision,'changes');
});
test('objeção com maioria: principal responde uma vez e depois decide a maioria',async t=>{
 const x=await setup(t);await x.positions();const c=await x.candidate();await vote(x,c,'codex');await vote(x,c,'claude');await vote(x,c,'antigravity','changes');
 const before=x.clients.codex.logs.length;x.finish();
 await wait(()=>x.r.workflow.objection&&x.cx.native(x.r,'codex').status==='running');
 assert.equal(x.r.workflow.phase,'planning');assert.equal(x.clients.codex.logs.length,before+1);
 // Only the principal is woken, and nobody else can reopen the decision.
 assert.notEqual(x.cx.native(x.r,'claude').status,'running');assert.notEqual(x.cx.native(x.r,'antigravity').status,'running');
 const view=await x.read('codex');assert.match(view.nextAction,/answer_objection/);assert.equal(view.workflow.objection.against[0].role,'antigravity');
 await assert.rejects(x.call('codex','answer_objection',{...view,decision:'talvez',reason:'x'}),/keep ou revise/);
 await assert.rejects(x.call('codex','send_to_peer',{messageId:'m1',type:'discovery',text:'Tentar reabrir.'}),/objeção a ser decidida/);
 await x.answerObjection('keep','Mantenho o plano: a objeção não se aplica a este pedido.');x.finish();await x.phase('implementing');
 assert.equal(x.r.workflow.approvedPlan.objection.response.decision,'keep');assert.equal(x.r.workflow.approvedPlan.objection.against[0].role,'antigravity');
 assert.ok(x.r.messages.some(m=>m.type==='objection-response'&&m.from==='codex'));assert.ok(x.r.messages.some(m=>m.type==='phase'&&/o principal manteve o plano/.test(m.text)));
 assert.equal(x.r.workflow.objection,null);
});
test('objeção: quem já votou não reabre a versão; numa votação o que há a dizer vai no voto',async t=>{
 const x=await setup(t);await x.positions();const c=await x.candidate();await vote(x,c,'codex');
 await assert.rejects(x.call('codex','send_to_peer',{messageId:'a',type:'question',text:'Reabrir?'}),/Já votaste/);
 await assert.rejects(x.call('claude','send_to_peer',{messageId:'b',type:'objection',text:'Discordo.'}),/review_final/);
 await assert.rejects(x.call('codex','declare_impasse',await x.read('codex').then(v=>({...v,text:'Impasse depois de votar.'}))),/Já votaste|review_final/);await assert.rejects(x.call('claude','declare_impasse',await x.read('claude').then(v=>({...v,text:'Impasse.'}))),/review_final/);
 assert.equal(x.r.candidateId,c.id);assert.equal(x.r.workflow.votes.codex.candidateId,c.id);
});
test('objeção: revise volta a rever a proposta e uma nova versão recebe novos votos',async t=>{
 const x=await setup(t);await x.positions();const c=await x.candidate();await vote(x,c,'codex');await vote(x,c,'claude');await vote(x,c,'antigravity','changes');x.finish();
 await x.answerObjection('revise','Tem razão, vou corrigir o plano.');x.finish();
 await wait(()=>x.r.candidateId===null&&x.roles.every(k=>x.cx.native(x.r,k).status==='running'));
 assert.equal(x.r.workflow.phase,'planning');assert.equal(x.r.workflow.objection,null);assert.deepEqual(x.r.workflow.votes,{});assert.equal(x.r.candidates[0].objection.response.decision,'revise');
 const next=await x.candidate();assert.notEqual(next.id,c.id);for(const role of x.roles)await vote(x,next,role);x.finish();await x.phase('implementing');
 assert.equal(x.r.workflow.approvedPlan.id,next.id);assert.equal(x.r.workflow.approvedPlan.objection,undefined);
});
test('objeção na revisão: keep passa à conclusão, revise regressa à correção',{skip:noBwrap},async t=>{
 const round=async decision=>{
  const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();
  await x.call('codex','submit_review',{...await x.read('codex'),decision:'approve',reason:'Verificado.',testIds:[ids.codex]});await x.call('claude','submit_review',{...await x.read('claude'),decision:'approve',reason:'Verificado.',testIds:[ids.claude]});
  await x.call('antigravity','submit_review',{...await x.read('antigravity'),decision:'changes',reason:'Falta tratar o caso vazio.',testIds:[ids.antigravity]});
  x.finish();await x.answerObjection(decision,'Resposta à objeção sobre o caso vazio.');x.finish();return x;
 };
 const kept=await round('keep');await kept.phase('finalizing');assert.equal(kept.r.workflow.validatedHash,kept.r.workflow.snapshot.hash);assert.equal(kept.r.workflow.rounds.at(-1).objection.response.decision,'keep');
 const c=await kept.candidate();for(const role of kept.roles)await vote(kept,c,role);kept.finish();await wait(()=>kept.r.status==='completed');
 const evidence=kept.cx.native(kept.r,'codex').turns.at(-1).finalAnswer;
 assert.match(evidence,/Registo da HYDRAQ/);assert.match(evidence,/Objeção de antigravity: Falta tratar o caso vazio/);assert.match(evidence,/Resposta do principal \(manteve a versão\): Resposta à objeção/);assert.match(evidence,/Testes da versão aprovada \(ronda 1\)/);assert.match(evidence,/codex: `test "\$\(cat value.txt\)" = after` — passed/);
 const revised=await round('revise');await revised.phase('fixing');assert.equal(revised.r.workflow.validatedHash,undefined);assert.equal(revised.r.workflow.implementation,null);assert.deepEqual(revised.r.workflow.failedVersions,[revised.r.workflow.rounds.at(-1).hash]);
});
test('objeção: uma resposta em falta insiste uma vez e depois fica para o utilizador; a retoma volta a pedir',async t=>{
 const x=await setup(t);await x.positions();const c=await x.candidate();await vote(x,c,'codex');await vote(x,c,'claude');await vote(x,c,'antigravity','changes');
 const dispatches=()=>x.r.dispatches.filter(d=>d.objection===x.r.workflow.objection?.id).length;
 x.finish();await wait(()=>dispatches()===1&&x.cx.native(x.r,'codex').status==='running');x.finish();await wait(()=>dispatches()===2&&x.cx.native(x.r,'codex').status==='running');x.finish();
 await wait(()=>x.r.status==='paused');assert.equal(x.r.pause.kind,'idle');assert.equal(x.r.candidateId,c.id);
 await wait(()=>!x.cx.pauseDrains.has(x.r.id)&&!x.cx.jobs.has(x.r.id));await x.cx.resume(x.r.id);await wait(()=>dispatches()===3&&x.cx.native(x.r,'codex').status==='running');
 assert.equal(x.r.candidateId,c.id,'a retoma conserva os votos');assert.ok(x.r.approvals.codex&&x.r.approvals.claude);
 await x.answerObjection();x.finish();await x.phase('implementing');
});
test('três versões sem maioria ficam para o utilizador',async t=>{
 const x=await setup(t);await x.positions();
 for(let i=0;i<3;i++){const c=await x.candidate();await vote(x,c,'codex');await vote(x,c,'claude','changes');await vote(x,c,'antigravity','changes');x.finish();if(i<2){await wait(()=>x.r.candidateId===null&&x.roles.every(k=>x.cx.native(x.r,k).status==='running'));}}
 await wait(()=>x.r.status==='paused');assert.equal(x.r.pause.kind,'no-majority');assert.match(x.r.pause.reason,/Três versões sem maioria/);
 await wait(()=>!x.cx.pauseDrains.has(x.r.id)&&!x.cx.jobs.has(x.r.id));await x.cx.resume(x.r.id);await wait(()=>x.r.status==='discussing'&&x.r.candidateId===null);assert.equal(x.r.workflow.noMajority,1);
});
test('divergências aprovadas num pedido de implementação nunca chegam a implementação',async t=>{
 const x=await setup(t,{conversation:true});await x.positions();assert.equal(x.r.workflow.authorized,true);
 for(const role of x.roles)await x.call(role,'ready_to_conclude',await x.read(role));
 const c=(await x.call('codex','propose_final',{...await x.read('codex'),text:'Pontos comuns e divergências atribuídas.',outcome:'divergences'})).candidate;
 for(const role of x.roles)await vote(x,c,role);x.finish();await wait(()=>x.r.status==='completed');
 assert.equal(x.r.workflow.phase,'planning');assert.equal(x.r.workflow.writeStarted,undefined);assert.equal(x.r.workflow.approvedPlan,undefined);
 assert.ok(x.clients.codex.logs.every(l=>!l.settings.hydraWrite));assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before');
 assert.equal(x.r.result.outcome,'divergences');assert.match(x.r.result.label,/divergências/);assert.match(x.r.result.text,/nada foi implementado/);
});
test('conclusão só com divergências na cópia não aplica; a versão testada espera por ti',{skip:noBwrap},async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude',conversation:true});await x.plan();await x.implemented();const ids=await x.tests();
 for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Verificado.',testIds:[ids[role]]});x.finish();await x.phase('finalizing');
 await x.call('claude','ready_to_conclude',await x.read('claude'));
 const c=(await x.call('claude','propose_final',{...await x.read('claude'),text:'A implementação passou, mas há divergências.',outcome:'divergences'})).candidate;
 for(const role of x.roles)await vote(x,c,role);x.finish();await wait(()=>x.r.released);
 assert.equal(x.r.status,'completed');assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'before','o projeto não mudou');assert.equal(x.r.workspace.kept,true);assert.equal(x.r.workspace.applied,undefined);assert.match(x.r.result.text,/não foi aplicada/);
 await wait(()=>!x.cx.jobs.has(x.r.id)&&!x.cx.pauseDrains.has(x.r.id));await x.cx.applySavedWorkspace(x.r.id);assert.equal(await readFile(x.cwd+'/value.txt','utf8'),'after');
});

test('read_changes mostra o que mudou desde o plano, com base guardada no servidor',{skip:noBwrap},async t=>{
 const x=await setup(t,{prepare:async({cwd})=>{await writeFile(cwd+'/apagar.txt','velho\n');await writeFile(cwd+'/modo.sh','#!/bin/sh\n');await symlink('value.txt',cwd+'/ligacao');await writeFile(cwd+'/grande.bin',Buffer.alloc(2<<20,'a'));await writeFile(cwd+'/.env','SEGREDO=1\n');}});
 await x.plan();
 assert.ok(x.r.workflow.baseline.folder);assert.equal(x.r.workflow.baselineVersion.hash.length,64);
 await assert.rejects(x.raw('codex','read_changes'),/só ficam fixas/);
 await rm(x.cwd+'/apagar.txt');await writeFile(x.cwd+'/novo.txt','novo\n');await chmod(x.cwd+'/modo.sh',0o755);await rm(x.cwd+'/ligacao');await symlink('novo.txt',x.cwd+'/ligacao');await writeFile(x.cwd+'/grande.bin',Buffer.alloc(2<<20,'b'));await writeFile(x.cwd+'/.env','SEGREDO=2\n');
 await x.implemented();
 const seen=await x.raw('claude','read_changes'),byPath=Object.fromEntries(seen.files.map(f=>[f.path,f]));
 assert.deepEqual(Object.keys(byPath).sort(),['apagar.txt','grande.bin','ligacao','modo.sh','novo.txt','value.txt']);
 assert.equal(byPath['value.txt'].status,'modified');assert.equal(byPath['value.txt'].additions,1);assert.equal(byPath['value.txt'].deletions,1);
 assert.equal(byPath['novo.txt'].status,'added');assert.equal(byPath['apagar.txt'].status,'deleted');assert.match(byPath['modo.sh'].mode,/ -> /);assert.equal(byPath['grande.bin'].large,true);assert.equal(byPath.ligacao.link,true);
 assert.match(seen.diff,/--- value\.txt\n@@[^\n]*\n-before\n\\ No newline[^\n]*\n\+after/);assert.match(seen.diff,/--- apagar\.txt\n@@[^\n]*\n-velho/);assert.match(seen.diff,/ligação para novo\.txt/);assert.doesNotMatch(seen.diff,/SEGREDO/);assert.doesNotMatch(seen.diff,/diff --git|\/tmp\/|\/hub\//);
 assert.equal(seen.summary.files,6);assert.equal(seen.dependenciesChanged,false);assert.equal(seen.nextOffset,null);
 const one=await x.raw('claude','read_changes',{file:'novo.txt'});assert.match(one.diff,/^--- novo\.txt\n/);assert.doesNotMatch(one.diff,/value\.txt/);
 await assert.rejects(x.raw('claude','read_changes',{file:'nunca.txt'}),/não mudou/);
 const ids=await x.tests();
 await assert.rejects(x.raw('codex','submit_review',{...await x.read('codex'),decision:'approve',reason:'Sem ler.',testIds:[ids.codex]}),/read_changes/);
 await x.raw('codex','submit_review',{...await x.read('codex'),decision:'changes',reason:'Ainda sem ler, a pedir correção.',testIds:[ids.codex]});
 await x.raw('claude','submit_review',{...await x.read('claude'),decision:'approve',reason:'Lido e testado.',testIds:[ids.claude]});
 // The comparison outlives the frozen folder: a pause clears that one.
 await x.cx.pause(x.r.id);await wait(()=>!x.cx.pauseDrains.has(x.r.id)&&!x.cx.jobs.has(x.r.id));assert.equal(x.r.workflow.snapshot.directory,null);assert.ok((await readdir(x.r.workflow.baseline.folder)).some(f=>f.startsWith('changes-')));
});
test('read_changes: páginas grandes, e a base desaparece com a tarefa',{skip:noBwrap},async t=>{
 const x=await setup(t,{conversation:true});await x.plan();const folder=x.r.workflow.baseline.folder;
 await writeFile(x.cwd+'/longo.txt',Array.from({length:12000},(_,i)=>'linha '+i).join('\n'));await x.implemented();
 const first=await x.raw('codex','read_changes');assert.equal(first.diff.length,40000);assert.equal(first.nextOffset,40000);
 const second=await x.raw('codex','read_changes',{offset:first.nextOffset});assert.ok(second.diff.length>0);assert.equal(second.offset,40000);assert.notEqual(second.diff,first.diff);
 await x.cx.stop(x.r.id);await wait(()=>x.r.released);assert.equal(await stat(folder).catch(()=>null),null);
});
test('testes: falha antes de ; ou dentro de um pipe conta; comandos que escondem falhas são recusados',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();
 const run=async(id,command)=>{const test=(await x.raw('codex','start_test',{messageId:id,command,purpose:'Verificar.'})).test;await wait(()=>x.r.workflow.tests.find(y=>y.id===test.id).status!=='running');return x.r.workflow.tests.find(y=>y.id===test.id);};
 assert.equal((await run('a','false; test -f value.txt')).status,'failed');
 assert.equal((await run('b','false | cat')).status,'failed');
 const cut=await run('c','yes | head -1');assert.equal(cut.exitCode,141);assert.equal(cut.status,'failed');assert.match(cut.error,/head/);
 assert.equal((await run('d','test -f value.txt 2>&1 | cat; echo terminou')).status,'passed');
 for(const command of ['npm test || true','npm test || :','npm test || exit 0','npm test || echo falhou','set +e; npm test','set +o pipefail; npm test | tail','(npm test || true)','if npm test; then echo ok; else echo falhou; fi','true','echo tudo bem','echo a; true','git diff','git status && git diff --stat','cat value.txt','npm test # comentário || true && true || true'])
  if(!command.includes('comentário'))await assert.rejects(x.raw('codex','start_test',{messageId:'r'+command,command,purpose:'Verificar.'}),/não serve de teste/,command);
 for(const command of ['npm test || exit 1','test -f a || { echo falta; exit 1; }','test "$(echo x || true)" = x','echo "a || true"; test -f value.txt','if ! npm test; then exit 1; fi','grep -q after value.txt','npm test # não uso || true','cat value.txt | grep -q after'])
  assert.equal((await import('../lib/hydra-validation.mjs')).testCommandProblem(command),null,command);
});
test('aprovar exige os comandos que o pedido nomeia, ou o motivo de não os correr',{skip:noBwrap},async t=>{
 const {namedCommands,ranCommand}=await import('../lib/hydra-validation.mjs');
 assert.deepEqual(namedCommands('Corrige e corre `npm test`, o pytest e make  check. Não uses npm install.'),['npm test','pytest','make check']);
 assert.deepEqual(namedCommands('Corre npm run test:unit e python3 -m pytest -q.'),['npm test:unit','pytest']);
 assert.deepEqual(namedCommands('Melhora o texto do botão.'),[]);
 assert.ok(ranCommand('cd app && npm run test -- --grep x','npm test'));assert.ok(ranCommand('python3 -m pytest -q','pytest'));assert.ok(!ranCommand('npm run test:unit','npm test'));assert.ok(!ranCommand('./pytest-wrapper','pytest'));
 const x=await setup(t,{text:'Implementa a alteração de value.txt para after e testa com node --test e pytest.'});
 const {authorizationQuote}={authorizationQuote:'Implementa a alteração de value.txt para after'};
 for(const role of x.roles)await x.call(role,'initial_position',{text:'Posição',intent:'implement',authorizationQuote,revision:x.r.revision});
 const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);x.finish();await x.phase('implementing');await x.implemented();
 assert.deepEqual((await x.read('codex')).requestedCommands,['node --test','pytest']);
 const ids=await x.tests();
 const approve=(role,extra={})=>x.call(role,'submit_review',{...extra.read,decision:'approve',reason:'Verificado.',testIds:extra.testIds||[ids[role]],...(extra.notRun?{notRun:extra.notRun}:{})});
 await assert.rejects(approve('codex',{read:await x.read('codex')}),/nomeia node --test, pytest/);
 await assert.rejects(approve('codex',{read:await x.read('codex'),notRun:[{command:'pytest',reason:'Sem testes em Python.'}]}),/nomeia node --test/);
 const named=(await x.raw('codex','start_test',{messageId:'n',command:'test -f value.txt; node --test --help > /dev/null',purpose:'Comando pedido.'})).test;await wait(()=>x.r.workflow.tests.find(y=>y.id===named.id).status!=='running');
 assert.equal(x.r.workflow.tests.find(y=>y.id===named.id).status,'passed');
 await approve('codex',{read:await x.read('codex'),testIds:[ids.codex,named.id],notRun:[{command:'pytest',reason:'Sem testes em Python.'}]});
 assert.deepEqual(x.r.workflow.reviews.codex.notRun,[{command:'pytest',reason:'Sem testes em Python.'}]);
 const reason='Sem testes em Python.';for(const role of ['claude','antigravity'])await approve(role,{read:await x.read(role),notRun:[{command:'node --test',reason},{command:'pytest',reason}]});
 x.finish();await x.phase('finalizing');const final=await x.candidate();for(const role of x.roles)await x.vote(final,role);x.finish();await wait(()=>x.r.status==='completed');
 assert.match(x.cx.native(x.r,'codex').turns.at(-1).finalAnswer,/codex não correu `pytest`: Sem testes em Python\./);
});
const fastWatch=x=>{x.cx.closeGraceMs=60;};
test('vigilância: turno que continua depois de registar o trabalho termina sem pausar a tarefa',async t=>{
 const x=await setup(t);fastWatch(x);await x.positions();const c=await x.candidate();
 await vote(x,c,'claude');
 await wait(()=>x.cx.native(x.r,'claude').status==='interrupted');
 assert.equal(x.r.status,'reviewing');assert.equal(x.r.pause,undefined);assert.equal(x.r.dispatches.findLast(d=>d.role==='claude').ended,'watchdog');
 await vote(x,c,'antigravity');await wait(()=>x.cx.native(x.r,'antigravity').status==='interrupted');
 await vote(x,c,'codex');await wait(()=>x.cx.native(x.r,'codex').status==='interrupted');
 await x.phase('implementing');assert.equal(x.r.pause,undefined);
});
test('vigilância: repetir a mesma chamada não mantém o turno aberto; prontidão só fecha quando nada falta',async t=>{
 const x=await setup(t);x.cx.closeGraceMs=300;await x.positions();
 await x.call('claude','ready_to_conclude',await x.read('claude'));
 const end=Date.now()+3000;while(Date.now()<end&&x.cx.native(x.r,'claude').status==='running'){await x.call('claude','ready_to_conclude',await x.read('claude')).catch(()=>{});await new Promise(r=>setTimeout(r,40));}
 assert.equal(x.cx.native(x.r,'claude').status,'interrupted');
 // The principal, ready with everyone else ready, still owes the proposal: its turn stays.
 const y=await setup(t);y.cx.closeGraceMs=100;await y.positions();await y.call('claude','ready_to_conclude',await y.read('claude'));await y.call('antigravity','ready_to_conclude',await y.read('antigravity'));await y.call('codex','ready_to_conclude',await y.read('codex'));
 await new Promise(r=>setTimeout(r,1400));assert.equal(y.cx.native(y.r,'codex').status,'running');assert.equal(y.r.status,'discussing');
 assert.ok((await y.call('codex','propose_final',{...await y.read('codex'),text:'Plano.'})).candidate);
});
test('vigilância: sem sinal de vida a tarefa pausa e diz quem; ferramenta em curso não conta',async t=>{
 const x=await setup(t);x.cx.agySilenceMs=x.cx.silenceMs=1500;
 const c=x.cx.native(x.r,'antigravity'),busy={id:'i1',turnId:c.turnId,type:'commandExecution',status:'inProgress'};c.items.push(busy);
 // Others stay alive by calling tools; agy is in a long command, which is not silence.
 const stop=setInterval(()=>{for(const role of ['codex','claude'])x.read(role).catch(()=>{});},300);t.after(()=>clearInterval(stop));
 await new Promise(r=>setTimeout(r,2200));assert.equal(x.r.status,'discussing');
 c.items.pop();await wait(()=>x.r.status==='paused');clearInterval(stop);
 assert.equal(x.r.pause.kind,'stuck');assert.equal(x.r.pause.stuck,'antigravity');assert.match(x.r.pause.reason,/Antigravity está há/);assert.match(x.r.pause.reason,/retira-o/);
 await wait(()=>!x.cx.pauseDrains.has(x.r.id)&&!x.cx.jobs.has(x.r.id));await x.cx.resume(x.r.id);await wait(()=>x.r.status==='discussing'&&x.roles.every(k=>x.cx.native(x.r,k).status==='running'));
});
const settledTask=async x=>wait(()=>!x.cx.pauseDrains.has(x.r.id)&&!x.cx.jobs.has(x.r.id));
test('retirar participante: só em pausa, nunca o principal; os dois restantes decidem',{skip:noBwrap},async t=>{
 const x=await setup(t);const gone=x.cx.native(x.r,'antigravity');await x.positions();const c=await x.candidate();await vote(x,c,'codex');await vote(x,c,'claude');
 const remove=(role,extra={})=>x.cx.removeParticipant(x.r.id,{role,confirm:true,...extra});
 await assert.rejects(remove('antigravity'),/Pausa primeiro/);
 await x.cx.pause(x.r.id);await settledTask(x);
 await assert.rejects(remove('codex'),/principal/);await assert.rejects(remove('antigravity',{confirm:false}),/Confirma/);await assert.rejects(remove('cursor'),/não participa/);
 const detail=await remove('antigravity');
 assert.deepEqual(x.r.roles,['codex','claude']);assert.equal(x.r.members.antigravity,undefined);assert.equal(x.r.removedParticipants[0].role,'antigravity');assert.equal(gone.claudexTask,undefined);assert.deepEqual(detail.roles,['codex','claude']);
 assert.ok(x.r.candidateId,'a versão em votação mantém-se');assert.ok(x.r.approvals.codex&&x.r.approvals.claude);assert.ok(x.r.messages.some(m=>/foi retirado da tarefa pelo utilizador/.test(m.text)));
 await assert.rejects(remove('claude'),/pelo menos dois|principal|não participa/);
 await settledTask(x);await x.cx.resume(x.r.id);await x.phase('implementing').catch(()=>{});
 await wait(()=>x.r.workflow.phase==='implementing');assert.equal(x.r.workflow.approvedPlan.id,c.id);assert.deepEqual(Object.keys(x.r.workflow.approvedPlan.approvals).sort(),['claude','codex']);
 assert.equal(x.hub.clients.antigravity.logs.filter(l=>l.settings.hydraWrite).length,0);
 // Reloading keeps it valid: members must match the roles.
 assert.ok(x.cx.snapshot().records.find(r=>r.id===x.r.id).removedParticipants[0].role==='antigravity');
});
test('retirar participante: revisão e testes dele deixam de contar, e a conclusão diz quem saiu',{skip:noBwrap},async t=>{
 const x=await setup(t,{conversation:true,roles:['codex','claude','antigravity']});await x.plan();await x.implemented();const gone=x.cx.native(x.r,'antigravity');
 const ids=await x.tests();await x.call('antigravity','submit_review',{...await x.read('antigravity'),decision:'changes',reason:'Objeção de quem vai sair.',testIds:[ids.antigravity]});
 await x.cx.pause(x.r.id);await settledTask(x);await x.cx.removeParticipant(x.r.id,{role:'antigravity',confirm:true});
 assert.equal(x.r.workflow.reviews.antigravity,undefined);assert.equal(x.r.removedParticipants[0].review.decision,'changes');assert.equal(gone.hydraReturn.outcome,'removed');assert.match(hydraReturnNote(gone.hydraReturn),/retirou-te/);
 await x.cx.resume(x.r.id);await wait(()=>x.roles.filter(k=>k!=='antigravity').every(k=>x.cx.native(x.r,k).status==='running'));
 for(const role of ['codex','claude'])await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Verificado.',testIds:[ids[role]]});
 for(const role of ['codex','claude'])x.clients[role].finish(x.cx.native(x.r,role),'Terminado.');
 await wait(()=>x.r.workflow.phase==='finalizing'&&x.cx.native(x.r,'codex').status==='running');
 await x.call('codex','ready_to_conclude',await x.read('codex'));
 const c=(await x.call('codex','propose_final',{...await x.read('codex'),text:'Conclusão a dois.'})).candidate;for(const role of ['codex','claude'])await vote(x,c,role);
 for(const role of ['codex','claude'])x.clients[role].finish(x.cx.native(x.r,role),'Terminado.');await wait(()=>x.r.status==='completed');
 assert.match(x.r.result.label,/Acordo de todos · 2\/2/);assert.match(x.cx.native(x.r,'codex').turns.at(-1).finalAnswer,/antigravity foi retirado da tarefa pelo utilizador/);
});

test('retirar participante cujo turno não confirma a paragem: sai da tarefa, e a pasta espera que ele pare',{skip:noBwrap},async t=>{
 const x=await setup(t);const stuck=x.cx.native(x.r,'antigravity');x.clients.antigravity.interrupt=async()=>{throw Error('Sem resposta do cliente.');};
 await x.cx.pause(x.r.id);await wait(()=>!x.cx.pauseDrains.has(x.r.id));assert.equal(x.r.pause.interruptionPending,true);assert.equal(stuck.status,'running');
 await assert.rejects(x.cx.resume(x.r.id),/turnos ainda em curso|ativo/);
 await wait(()=>!x.cx.jobs.has(x.r.id));await x.cx.removeParticipant(x.r.id,{role:'antigravity',confirm:true});
 assert.equal(x.r.pause.interruptionPending,false);assert.equal(stuck.claudexTask,undefined);assert.deepEqual(x.r.roles,['codex','claude']);
 // A turn that may still be running in this folder keeps the project reserved: nothing else starts on it until it stops.
 await wait(()=>!x.cx.jobs.has(x.r.id));await assert.rejects(x.cx.resume(x.r.id),/Aguarda a libertação/);assert.equal(x.r.status,'paused');
 x.clients.antigravity.finish(stuck,'Parou por fim.');await x.cx.resume(x.r.id);await wait(()=>['codex','claude'].every(k=>x.cx.native(x.r,k).status==='running'));assert.equal(x.r.status,'discussing');
});

test('retirar na cópia privada: a conversa dele volta ao projeto e os outros continuam na cópia',{skip:noBwrap},async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude',conversation:true});const gone=x.cx.native(x.r,'codex'),copy=x.r.workspace.copy;
 assert.equal(gone.cwd,copy);await x.cx.pause(x.r.id);await settledTask(x);await x.cx.removeParticipant(x.r.id,{role:'codex',confirm:true});
 assert.equal(gone.cwd,x.cwd);assert.equal(gone.workspaceOrigin,undefined);assert.equal(x.cx.native(x.r,'claude').cwd,copy);assert.equal(x.cx.native(x.r,'antigravity').cwd,copy);
 // The conversation the task was started from keeps showing it until the task gives it back.
 assert.equal(gone.claudexTask,x.r.id);
 await x.cx.stop(x.r.id);await wait(()=>x.r.released);assert.equal(gone.claudexTask,undefined);assert.equal(x.cx.native(x.r,'claude').cwd,x.cwd);
});
test('reinício: a base de read_changes fica para a tarefa pausada e sai com a terminada',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();x.finish();const folder=x.r.workflow.baseline.folder;
 const done=await setup(t);await done.plan();const gone=done.r.workflow.baseline.folder;await done.cx.stop(done.r.id);await wait(()=>done.r.status==='interrupted');
 clearInterval(x.cx.timer);clearTimeout(x.cx.scheduled);x.cx.loaded=false;await x.cx.queue;await rm(x.cx.directory+'/owner.json');x.cx.ownsLock=false;
 const recovered=new ClaudeX({hub:x.hub,directory:x.cx.directory,prepare:x.cx.prepare});await recovered.load();t.after(()=>recovered.close().catch(()=>{}));
 assert.equal(recovered.record(x.r.id).status,'paused');assert.ok((await readdir(folder)).includes('base.json'));
 // A task that ended long ago leaves nothing behind after the next start.
 done.r.updatedAt=new Date(Date.now()-8*24*3600*1000).toISOString();await done.cx.sweepBaselines();assert.equal(await stat(gone).catch(()=>null),null);
});

const approveRaw=async(x,role,ids)=>x.raw(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Alterações lidas e testes concluídos.',testIds:[ids[role]]});

test('falhas em listas AND não chegam a ser certificadas; uma cadeia simples mantém o código de erro',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();
 for(const command of ['test "$(cat value.txt)" = ERRADO && echo confirmado; echo terminou','(test "$(cat value.txt)" = ERRADO; echo passou) && test -f value.txt'])
  await assert.rejects(x.raw('codex','start_test',{messageId:command,command,purpose:'Verificar value.txt.'}),/não serve de teste/);
 const ids=await x.tests('test "$(cat value.txt)" = ERRADO && echo confirmado');
 assert.ok(x.r.workflow.tests.every(test=>test.status==='failed'));assert.equal(x.r.workflow.tests.length,3);
 await x.raw('codex','read_changes');await assert.rejects(approveRaw(x,'codex',ids),/sucesso/);
});

test('diff: aprovação exige todas as páginas, sem saltos, repetições ou leitura de só um ficheiro',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await writeFile(x.cwd+'/longo.txt',Array.from({length:12000},(_,i)=>'linha '+i).join('\n'));await x.implemented();const ids=await x.tests();
 const single=await x.raw('codex','read_changes',{file:'value.txt'});assert.equal(single.readComplete,false);assert.equal(single.remaining.offset,0);
 await assert.rejects(approveRaw(x,'codex',ids),/todas as páginas/);
 const first=await x.raw('codex','read_changes');assert.ok(first.nextOffset);assert.equal(first.readComplete,false);
 await x.raw('codex','read_changes');await x.raw('codex','read_changes',{offset:first.diffLength+100});
 await assert.rejects(approveRaw(x,'codex',ids),/todas as páginas/);
 // A final page delivered out of order cannot fill the hole in the middle.
 await x.raw('codex','read_changes',{offset:Math.floor(first.diffLength/40000)*40000});
 await assert.rejects(approveRaw(x,'codex',ids),/todas as páginas/);
 let page=first;while(!page.readComplete)page=await x.raw('codex','read_changes',{offset:page.remaining.offset??0,fileOffset:page.remaining.fileOffset??0});
 assert.equal(x.r.workflow.changesRead.codex,x.r.workflow.round);assert.equal(page.remaining.offset,null);await approveRaw(x,'codex',ids);
});

test('lista: mais de 300 binários são enumeráveis e a última página é obrigatória para aprovar',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();for(let i=0;i<302;i++)await writeFile(x.cwd+'/asset-'+String(i).padStart(3,'0')+'.bin',Buffer.from([0,1,2,3]));
 await x.implemented();const ids=await x.tests(),first=await x.raw('codex','read_changes');
 assert.equal(first.totalFiles,303);assert.equal(first.files.length,300);assert.equal(first.nextFileOffset,300);assert.equal(first.nextOffset,null);assert.equal(first.readComplete,false);
 await x.raw('codex','read_changes',{fileOffset:1000});await assert.rejects(approveRaw(x,'codex',ids),/todas as páginas/);
 const last=await x.raw('codex','read_changes',{fileOffset:first.nextFileOffset});assert.equal(last.files.length,3);assert.ok(last.files.some(file=>file.path==='asset-301.bin'));assert.equal(last.nextFileOffset,null);assert.equal(last.readComplete,true);
 await approveRaw(x,'codex',ids);
});

test('comparação ausente ou inválida bloqueia aprovação, mesmo com a leitura antiga registada',{skip:noBwrap},async t=>{
 for(const missing of ['base','content','comparison','comparison-after-read','changed-comparison']){
  const x=await setup(t);await x.plan();const base=x.r.workflow.baseline.folder;
  if(missing==='base')await rm(base+'/base.json');
  if(missing==='content')await rm(base+'/files/value.txt');
  await x.implemented();const ids=await x.tests();
  if(missing==='comparison')await rm(x.r.workflow.changes.file);
  if(missing==='comparison-after-read'||missing==='changed-comparison'){
   await x.raw('codex','read_changes');
   if(missing==='comparison-after-read')await rm(x.r.workflow.changes.file);
   else{const file=x.r.workflow.changes.file,json=JSON.parse(await readFile(file,'utf8'));json.files=[];await writeFile(file,JSON.stringify(json));}
  }
  await assert.rejects(approveRaw(x,'codex',ids),/comparação válida|todas as páginas/);
  assert.equal(x.r.workflow.reviews.codex,undefined,missing);
  await x.raw('codex','submit_review',{...await x.read('codex'),decision:'blocked',reason:'A comparação desta versão não está disponível.',testIds:[ids.codex]});
  assert.equal(x.r.workflow.reviews.codex.decision,'blocked');
 }
});

test('guardar a base falha antes de implementar; repor o armazenamento e retomar permite continuar',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.positions();const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);
 const real=x.cx.baselineDirectory.bind(x.cx),blocker=x.root+'/nao-e-pasta';await writeFile(blocker,'x');x.cx.baselineDirectory=()=>blocker+'/base';
 x.finish();await wait(()=>x.r.status==='paused');await settledTask(x);assert.equal(x.r.pause.kind,'changes');assert.equal(x.r.workflow.phase,'planning');assert.equal(x.r.workflow.baselineVersion,undefined);assert.ok(x.clients.codex.logs.every(log=>!log.settings.hydraWrite));
 x.cx.baselineDirectory=real;await x.cx.resume(x.r.id);await x.phase('implementing');assert.ok(x.r.workflow.baseline.folder);await x.implemented();const ids=await x.tests();await x.raw('codex','read_changes');await approveRaw(x,'codex',ids);
});

test('leitura completa mantém-se numa pausa da mesma versão e invalida-se na versão seguinte',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();await x.raw('codex','read_changes');const comparisonId=x.r.workflow.changes.comparisonId;
 await x.cx.pause(x.r.id);await settledTask(x);await x.cx.resume(x.r.id);await x.phase('validating');
 assert.equal(x.r.workflow.changes.comparisonId,comparisonId);assert.equal(x.r.workflow.changesCoverage.codex.complete,true);
 let ids=await x.tests();await approveRaw(x,'codex',ids);
 await x.cx.pause(x.r.id);await settledTask(x);await writeFile(x.cwd+'/value.txt','outra versão');await x.cx.resume(x.r.id);await x.phase('validating');
 ids=await x.tests('test -f value.txt');await assert.rejects(approveRaw(x,'codex',ids),/todas as páginas/);await x.raw('codex','read_changes');await approveRaw(x,'codex',ids);
});

test('orçamento de leitura: lockfiles e o que passa do limite ficam listados, sem leitura obrigatória, e a conclusão diz',{skip:noBwrap},async t=>{
 const lock=n=>JSON.stringify({packages:Object.fromEntries(Array.from({length:n},(_,i)=>['node_modules/p'+i,{version:'1.'+i,integrity:'sha512-'+'x'.repeat(80)}]))},null,1);
 const x=await setup(t,{prepare:async({cwd})=>{await writeFile(cwd+'/package-lock.json',lock(10));}});await x.plan();
 await writeFile(x.cwd+'/package-lock.json',lock(3000));await writeFile(x.cwd+'/grande.txt',Array.from({length:30000},(_,i)=>'linha '+i).join('\n'));await x.implemented();
 const first=await x.raw('codex','read_changes');
 assert.ok(first.diffLength>first.requiredLength);assert.equal(first.requiredLength,160000);assert.ok(first.optional.includes('package-lock.json'));assert.ok(first.optional.includes('grande.txt'));
 // The required part comes first: the lockfile is at the end.
 assert.match(first.diff,/^--- grande\.txt|^--- value\.txt/);
 let page=first;while(page.readComplete!==true){assert.ok(page.remaining.offset!==null||page.remaining.fileOffset!==null);page=await x.raw('codex','read_changes',{offset:page.remaining.offset??page.offset,fileOffset:page.remaining.fileOffset??0});}
 assert.ok(page.offset<first.diffLength-40000,'acaba antes do fim do texto');
 const ids=await x.tests();await x.raw('codex','submit_review',{...await x.read('codex'),decision:'approve',reason:'Lido o obrigatório.',testIds:[ids.codex]});
 for(const role of ['claude','antigravity'])await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Verificado.',testIds:[ids[role]]});
 x.finish();await x.phase('finalizing');const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);x.finish();await wait(()=>x.r.status==='completed');
 assert.match(x.r.result.text,/a leitura obrigatória antes de aprovar cobriu 160000/);assert.match(x.r.result.text,/package-lock\.json/);
});

test('continuações levam a fase atual e os esclarecimentos; o protocolo completo volta depois de uma pausa',async t=>{
 const x=await setup(t);const prompts=role=>x.clients[role].logs.filter(l=>l.settings.internal==='claudex').map(l=>l.text);
 assert.match(prompts('claude')[0],/1\. PLANNING/);assert.match(prompts('claude')[0],/Pedidos do utilizador/);
 await x.positions();x.finish();await wait(()=>prompts('claude').length===2&&x.cx.native(x.r,'claude').status==='running');
 const second=prompts('claude')[1];
 assert.match(second,/continuação da tarefa/);assert.match(second,/FASE ATUAL: planning/);assert.match(second,/1\. PLANNING/);assert.doesNotMatch(second,/3\. VALIDATING/);assert.doesNotMatch(second,/Implementa a alteração de value\.txt/);
 assert.ok(second.length<prompts('claude')[0].length/2,'menos de metade');
 await x.cx.pause(x.r.id);await wait(()=>!x.cx.pauseDrains.has(x.r.id)&&!x.cx.jobs.has(x.r.id));await x.cx.resume(x.r.id);await wait(()=>prompts('claude').length===3);
 assert.match(prompts('claude')[2],/3\. VALIDATING/,'depois de retomar vai o protocolo completo');assert.match(prompts('claude')[2],/Implementa a alteração de value\.txt/);
});
test('na conclusão os revisores não gastam um turno só para ficarem prontos',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();
 for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Verificado.',testIds:[ids[role]]});
 const turns=role=>x.r.members[role].turns,before=Object.fromEntries(x.roles.map(k=>[k,turns(k)]));
 x.finish();await x.phase('finalizing');await new Promise(r=>setTimeout(r,300));
 assert.equal(turns('claude'),before.claude);assert.equal(turns('antigravity'),before.antigravity);assert.equal(turns('codex'),before.codex+1);
 const c=await x.candidate();for(const role of x.roles)await x.vote(c,role);x.finish();await wait(()=>x.r.status==='completed');
 assert.equal(turns('claude'),before.claude+1,'um turno só para votar');
});

test('saídas longas dos testes ficam num ficheiro; o estado guarda o início e o fim',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();
 const test=(await x.raw('codex','start_test',{messageId:'longo',command:'test -f value.txt && seq 1 20000',purpose:'Saída longa.'})).test;await wait(()=>x.r.workflow.tests.find(y=>y.id===test.id).status!=='running');
 const saved=x.r.workflow.tests.find(y=>y.id===test.id);
 assert.equal(saved.status,'passed');assert.equal(saved.outputFile,true);assert.ok(saved.output.length<=4200);assert.match(saved.output,/^1\n2\n/);assert.match(saved.output,/20000\n?$/);assert.match(saved.output,/caracteres no ficheiro/);
 const status=(await x.raw('codex','test_status')).tests.find(y=>y.id===test.id);assert.equal(status.output.length,saved.outputLength);assert.match(status.output,/\n1500\n/);
 assert.equal((await x.cx.testOutput(x.r.id,test.id)).output,status.output);
 await assert.rejects(x.cx.testOutput(x.r.id,'00000000-0000-0000-0000-000000000000'),/não encontrado/);
 assert.ok(!(await readFile(x.cx.directory+'/state.json','utf8')).includes('\\n1500\\n'),'o estado não leva a saída inteira');
});
test('apagar tarefa: só terminada e devolvida, e leva o que guardou no disco',{skip:noBwrap},async t=>{
 const x=await setup(t,{conversation:true});await x.plan();const baseline=x.r.workflow.baseline.folder;await x.implemented();
 const test=(await x.raw('codex','start_test',{messageId:'longo',command:'test -f value.txt && seq 1 20000',purpose:'Saída longa.'})).test;await wait(()=>x.r.workflow.tests.find(y=>y.id===test.id).status!=='running');
 const outputs=x.cx.outputDirectory(x.r);assert.ok((await readdir(outputs)).length);
 await assert.rejects(x.cx.deleteTask(x.r.id,{confirm:true}),/terminada/);
 await x.cx.stop(x.r.id);await wait(()=>x.r.released);await wait(()=>!x.cx.jobs.has(x.r.id)&&!x.cx.pauseDrains.has(x.r.id));
 await assert.rejects(x.cx.deleteTask(x.r.id,{}),/Confirma/);
 const published=x.cx.native(x.r,'codex').messages.length,id=x.r.id;
 await x.cx.deleteTask(id,{confirm:true});
 assert.throws(()=>x.cx.record(id),/não encontrada/);assert.equal(await stat(outputs).catch(()=>null),null);assert.equal(await stat(baseline).catch(()=>null),null);
 assert.equal(x.cx.native({members:x.r.members},'codex').messages.length,published,'a conversa fica como estava');
 assert.ok(!(await readFile(x.cx.directory+'/state.json','utf8')).includes(id));
});
test('apagar tarefa: uma cópia guardada por aplicar impede-o',{skip:noBwrap},async t=>{
 const x=await setup(t,{workspace:'copy',author:'claude',conversation:true});await x.plan();await x.implemented();
 await x.cx.stop(x.r.id);await wait(()=>x.r.released);await wait(()=>!x.cx.jobs.has(x.r.id)&&!x.cx.pauseDrains.has(x.r.id));
 assert.equal(x.r.workspace.kept,true);await assert.rejects(x.cx.deleteTask(x.r.id,{confirm:true}),/cópia guardada/);
 await x.cx.deleteSavedWorkspace(x.r.id,{confirm:true});await x.cx.deleteTask(x.r.id,{confirm:true});assert.equal(x.cx.records.length,0);
});

test('shell com opções separadas: a asserção errada é recusada ou falha, nunca certificada',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();
 for(const command of ["bash --noprofile --norc -c 'test 1 = 2; echo terminou'","bash -l -c 'test 1 = 2; echo terminou'","bash -c -l 'test 1 = 2; echo terminou'","bash -lc -- 'test 1 = 2; echo terminou'"])
  await assert.rejects(x.raw('codex','start_test',{messageId:command,command,purpose:'Verificar a asserção.'}),/não serve de teste/);
 assert.equal(x.r.workflow.tests.length,0);
 const run=async(messageId,command)=>{const {test}=await x.raw('codex','start_test',{messageId,command,purpose:'Verificar o conteúdo.'});await wait(()=>x.r.workflow.tests.find(t=>t.id===test.id).status!=='running');return x.r.workflow.tests.find(t=>t.id===test.id);};
 assert.equal((await run('falha',"bash --noprofile --norc -e -o pipefail -c 'test 1 = 2; echo terminou'")).status,'failed');
 assert.equal((await run('passa',"bash --noprofile --norc -e -o pipefail -c 'test \"$(cat value.txt)\" = after; echo confirmado'")).status,'passed');
});

const longOutput=async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const started=(await x.raw('codex','start_test',{messageId:'saida',command:'test -f value.txt && seq 1 9000',purpose:'Saída de diagnóstico.'})).test;
 await wait(()=>x.r.workflow.tests.find(test=>test.id===started.id).status!=='running');x.test=x.r.workflow.tests.find(test=>test.id===started.id);x.output=x.cx.outputDirectory(x.r)+'/'+x.test.id+'.txt';return x;
};
test('saída completa ausente ou truncada é explícita, conserva excerto e permite nova leitura',{skip:noBwrap},async t=>{
 const x=await longOutput(t),original=await readFile(x.output,'utf8');
 for(const missing of ['ausente','incompleta']){
  if(missing==='ausente')await rm(x.output);else await writeFile(x.output,original.slice(0,200));
  await assert.rejects(x.cx.testOutput(x.r.id,x.test.id),error=>error.status===409&&error.code==='OUTPUT_UNAVAILABLE');
  const view=(await x.raw('codex','test_status')).tests.find(test=>test.id===x.test.id);
  assert.equal(view.outputComplete,false);assert.match(view.outputError,/indisponível/);assert.equal(view.output,x.test.output);assert.equal(view.status,'passed');
  await writeFile(x.output,original);const restored=await x.cx.testOutput(x.r.id,x.test.id);assert.equal(restored.complete,true);assert.equal(restored.length,restored.output.length);assert.equal(restored.output,original);
  assert.equal((await x.raw('codex','test_status')).tests.find(test=>test.id===x.test.id).outputComplete,true);
 }
});

test('saída completa sem acesso não é substituída silenciosamente pelo excerto',{skip:noBwrap||(process.getuid?.()===0?'root não reproduz EACCES':false)},async t=>{
 const x=await longOutput(t),folder=x.cx.outputDirectory(x.r);await chmod(folder,0);
 try{await assert.rejects(x.cx.testOutput(x.r.id,x.test.id),/indisponível/);const status=(await x.raw('codex','test_status')).tests.find(test=>test.id===x.test.id);assert.equal(status.outputComplete,false);assert.equal(status.output,x.test.output);}
 finally{await chmod(folder,0o700);}
 assert.equal((await x.cx.testOutput(x.r.id,x.test.id)).complete,true);
});

test('limpeza incompleta conserva tarefa e aviso no reinício; repor acesso permite apagar',{skip:noBwrap||(process.getuid?.()===0?'root não reproduz EACCES':false)},async t=>{
 const x=await setup(t,{conversation:true});await x.plan();await x.implemented();
 const started=(await x.raw('codex','start_test',{messageId:'saida',command:'test -f value.txt && seq 1 9000',purpose:'Saída de diagnóstico.'})).test;await wait(()=>x.r.workflow.tests.find(test=>test.id===started.id).status!=='running');
 await x.cx.stop(x.r.id);await wait(()=>x.r.released&&!x.cx.jobs.has(x.r.id)&&!x.cx.pauseDrains.has(x.r.id));
 const outputs=x.cx.outputDirectory(x.r),parent=path.dirname(outputs);await chmod(parent,0);
 try{
  await assert.rejects(x.cx.deleteTask(x.r.id,{confirm:true}),error=>error.status===409&&error.code==='DELETE_INCOMPLETE');
  assert.equal(x.cx.record(x.r.id),x.r);assert.match(x.r.deletionError,/saídas dos testes/);assert.equal(x.cx.snapshot().records.find(r=>r.id===x.r.id).deletionError,x.r.deletionError);
 }finally{await chmod(parent,0o700);}
 assert.equal(await stat(outputs).then(()=>true),true);
 await restartRetained(x);assert.match(x.r.deletionError,/limpeza ficou incompleta/);assert.equal(await stat(outputs).then(()=>true),true);
 const conversation=x.cx.native(x.r,'codex'),messages=conversation.messages.length;
 const result=await x.cx.deleteTask(x.r.id,{confirm:true});assert.equal(result.deleted,x.r.id);assert.equal(await stat(outputs).catch(()=>null),null);assert.equal(x.cx.records.length,0);assert.equal(conversation.messages.length,messages);
});

test('retomar na conclusão não acorda os revisores antes de haver versão para votar',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await x.implemented();const ids=await x.tests();
 for(const role of x.roles)await x.call(role,'submit_review',{...await x.read(role),decision:'approve',reason:'Verificado.',testIds:[ids[role]]});
 x.finish();await x.phase('finalizing');const before=Object.fromEntries(x.roles.map(k=>[k,x.r.members[k].turns]));
 await x.cx.pause(x.r.id);await wait(()=>!x.cx.pauseDrains.has(x.r.id)&&!x.cx.jobs.has(x.r.id));await x.cx.resume(x.r.id);
 await x.turn('codex');await new Promise(r=>setTimeout(r,300));
 assert.equal(x.r.members.codex.turns,before.codex+1);assert.equal(x.r.members.claude.turns,before.claude);assert.equal(x.r.members.antigravity.turns,before.antigravity);
});

test('start_test recusa scripts da entrada depois de -- sem registar falsos sucessos',{skip:noBwrap},async t=>{
 const x=await setup(t);await x.plan();await writeFile(x.cwd+'/check.sh','test "$(cat value.txt)" = after\n');await x.implemented();
 for(const [index,command] of ["bash -- <<'EOF'\ntest 1 = 2\necho terminou\nEOF","printf 'test 1 = 2\\necho terminou\\n' | bash --","sh -- <<< 'test 1 = 2; echo terminou'","bash -- < value.txt"].entries())
  await assert.rejects(x.raw('codex','start_test',{messageId:'stdin-'+index,command,purpose:'Verificar uma asserção.'}),/lê o script da entrada/);
 assert.equal(x.r.workflow.tests.length,0,'comandos recusados não produzem um resultado aprovado');
 const result=await x.raw('codex','start_test',{messageId:'ficheiro',command:'bash -- check.sh',purpose:'Verificar o conteúdo do projeto.'});
 await wait(()=>x.r.workflow.tests.find(t=>t.id===result.test.id).status!=='running');
 assert.equal(x.r.workflow.tests.find(t=>t.id===result.test.id).status,'passed');
});
