// Real subscriptions; fresh sessions and a synthetic project, never production histories.
// node validation/hydra-workflow-live.mjs --run [evidence-directory]
import {mkdtemp,mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {Providers} from '../lib/providers.mjs';
import {Hydraq} from '../lib/hydraq.mjs';
import {ClaudeCode} from '../lib/claude.mjs';
import {Antigravity} from '../lib/antigravity.mjs';
import {createHttpServer} from '../lib/http.mjs';
if(!process.argv.includes('--run'))throw Error('Usa --run: este ensaio faz chamadas reais.');
for(const [id,bin] of Object.entries({CODEX:'codex',CLAUDE:'claude',AGY:'agy'})){const file='/home/sauron/.local/bin/'+bin;if(await access(file).then(()=>true,()=>false))process.env['HYDRAQ_'+id+'_BIN']=file;}
const directory=await mkdtemp('/tmp/hydra-workflow-live-'),cwd=directory+'/project',out=path.resolve(process.argv[3]||'output/hydra-workflow-live');
await mkdir(cwd);await mkdir(out,{recursive:true});
await writeFile(cwd+'/sum.mjs','export const sum = (a,b) => a - b;\n');
await writeFile(cwd+'/sum.test.mjs',"import test from 'node:test'; import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; test('sum',()=>{assert.equal(sum(2,3),5);assert.equal(sum(-2,1),-1);assert.equal(sum(0,0),0);});\n");
// HYDRA_PROJECT=realista: Git, ignored dependencies, Python caches, a .env and the project's own test commands.
const realistic=process.env.HYDRA_PROJECT==='realista',fakeSecret='CHAVE-FICTICIA-'+Date.now();
if(realistic){
 await mkdir(cwd+'/node_modules/dep',{recursive:true});await writeFile(cwd+'/node_modules/dep/index.js','export const dep=1;\n');
 await writeFile(cwd+'/package.json',JSON.stringify({name:'ensaio',private:true,type:'module',scripts:{test:'node --test sum.test.mjs'}}));
 await writeFile(cwd+'/.gitignore','node_modules\n__pycache__\n.pytest_cache\n.env\n');await writeFile(cwd+'/.env','CHAVE='+fakeSecret+'\n');
 await writeFile(cwd+'/calc.py','def dobro(x):\n    return 2 * x\n');await writeFile(cwd+'/test_calc.py','from calc import dobro\ndef test_dobro():\n    assert dobro(2) == 4\n');
 execFileSync('python3',['-m','pytest','-q'],{cwd,stdio:'ignore'});
 execFileSync('git',['init','-q'],{cwd});execFileSync('git',['add','-A'],{cwd});execFileSync('git',['-c','user.name=t','-c','user.email=t@t','commit','-qm','Estado inicial'],{cwd});
}
const allClients={codex:new Hydraq({dataDir:directory+'/codex',defaultCwd:cwd}),claude:new ClaudeCode({dataDir:directory+'/claude',defaultCwd:cwd,questions:true}),antigravity:new Antigravity({dataDir:directory+'/antigravity',defaultCwd:cwd})};
const selectedRoles=(process.env.HYDRA_ROLES||'codex,claude,antigravity').split(',');const clients=Object.fromEntries(selectedRoles.map(k=>[k,allClients[k]]));
const hub=new Providers({dataDir:directory+'/hub',defaultCwd:cwd,clients,git:async()=>[]});let server;
const checks=[];let task;
try{
 await hub.load();await Promise.all(Object.values(clients).map(c=>c.connect()));
 const desired={codex:process.env.HYDRA_CODEX_MODEL||'gpt-6.1-sol',claude:process.env.HYDRA_CLAUDE_MODEL||'opus',antigravity:process.env.HYDRA_AGY_MODEL||'gemini-4-argon'};
 const members=Object.fromEntries(Object.entries(clients).map(([role,c])=>{const m=c.models.find(m=>m.id===desired[role]);if(!m)throw Error(role+': modelo indisponível '+JSON.stringify(c.models.map(m=>({id:m.id,name:m.name}))));if(role==='claude'&&desired[role]==='opus'&&!/opus.*5[.\-]5/i.test((m.name||'')+' '+(m.resolvedModel||'')))throw Error('O catálogo não confirmou Opus 5.5: '+JSON.stringify(m));return [role,{model:m.id,effort:process.env.HYDRA_EFFORT&&m.efforts.includes(process.env.HYDRA_EFFORT)?process.env.HYDRA_EFFORT:m.efforts.includes('low')?'low':m.defaultEffort}];}));
 console.log(JSON.stringify({directory,members}));
 server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const scenario=process.env.HYDRA_SCENARIO||'implement',author=process.env.HYDRA_AUTHOR||'codex';
 let text=scenario==='plan'?'Apenas analisem e proponham um plano curto para corrigir sum.mjs. Não implementem nem alterem ficheiros.':
  'Corrige sum.mjs para que sum some dois números. Implementa apenas essa correção; não alteres os testes existentes. O plano que dou é: ler sum.mjs e sum.test.mjs, corrigir a subtração para soma, executar node --test sum.test.mjs, rever e testar por todos. Sigam este plano curto, sem acrescentar funcionalidades ou refatorações. Nesta pasta só existem dois ficheiros; não é necessário pesquisar na web. No fim indiquem os testes executados. Usa as ferramentas Hydra para completar todas as fases automaticamente.';
 if(realistic)text+=' Valida com npm test, python3 -m pytest -q e git diff, pela ferramenta de testes da tarefa.';
 // HYDRA_OBJECTOR=<role>: that participant is told to object to the plan, so that a real principal has to answer and the majority decides.
 const objector=process.env.HYDRA_OBJECTOR;
 // HYDRA_OBJECT_IN=review: the objection comes in the review of the implementation instead, with the tests passing.
 const objectInReview=process.env.HYDRA_OBJECT_IN==='review';
 if(objector)text+=objectInReview?` Isto é também um ensaio do protocolo de objeções: na revisão da implementação, o participante ${objector} corre os testes e entrega submit_review com decision changes, uma única vez, com uma razão concreta sobre o que ficou por verificar, mesmo que os testes passem. Os outros decidem por si, e o principal responde como entender.`:` Isto é também um ensaio do protocolo de objeções: o participante ${objector} vota changes na proposta de plano, uma única vez, com uma razão concreta sobre o que o plano deixa por verificar; depois disso aprova normalmente. Os outros decidem por si, e o principal responde como entender.`;
 // HYDRA_CLOSE_GRACE_MS: how long a turn may go on after its work is on record, short enough to make real clients go through the interruption.
 if(process.env.HYDRA_CLOSE_GRACE_MS)hub.claudex.closeGraceMs=Number(process.env.HYDRA_CLOSE_GRACE_MS);
 // HYDRA_VENV=1: the principal generates a virtualenv, which must keep working in the project after the copy is gone.
 if(process.env.HYDRA_VENV==='1')text+=' Cria também um ambiente Python na pasta .venv com python3 -m venv .venv, e confirma nos testes que .venv/bin/pip --version funciona.';
 let injected=false;const advance=hub.claudex.advanceWorkflow.bind(hub.claudex);
 hub.claudex.advanceWorkflow=async r=>{if(process.env.HYDRA_INJECT_FAILURE==='1'&&!injected&&r.workflow.phase==='implementing'&&r.workflow.implementation&&r.roles.every(k=>!['starting','running','waiting'].includes(hub.claudex.native(r,k).status))){await writeFile(hub.claudex.workdir(r)+'/sum.mjs','export const sum = (a,b) => a * b;\n');injected=true;console.log(JSON.stringify({injectedFailure:true,scope:'synthetic fixture only; exercise failed tests and automatic correction'}));}return advance(r);};
 // HYDRA_WORKSPACE=copy: the task works in a private copy. HYDRA_INPLACE=1: it starts from a conversation that already exists.
 // HYDRA_PAUSE_IN=<phase>[,<phase>…]: one pause and resume in each. HYDRA_USER_EDIT=1: the user edits another file just before the conclusion.
 const word='ROMA-'+Date.now()%1000;let where={cwd};
 if(process.env.HYDRA_INPLACE==='1'){
  const first=await hub.create({provider:author,cwd,model:members[author].model,effort:members[author].effort,sandbox:author==='codex'?'read-only':'plan'}),native=clients[author].conversation(first.id);
  await hub.send(first.id,`Ensaio da HYDRAQ. A palavra desta conversa é ${word}: lembra-te dela. Responde só com OK, sem usar ferramentas.`,'primeiro',{});
  const end=Date.now()+4*60000;while(['starting','running','waiting'].includes(native.status)&&Date.now()<end)await new Promise(r=>setTimeout(r,300));
  checks.push({name:'primeiro turno na pasta do projeto',ok:native.status==='completed',error:native.error});where={conversationId:first.id};
 }
 const initial=await readFile(cwd+'/sum.mjs','utf8');const pauseIn=new Set((process.env.HYDRA_PAUSE_IN||'').split(',').filter(Boolean)),pausedIn=new Set();let realChanged=false,paused=false,userEdit=false,roundAtEdit=0,removed=false;
 const created=await hub.claudex.create({requestId:'live-'+Date.now(),...where,roles:Object.keys(clients),members,author,text,guards:{turns:16,minutes:12},...(process.env.HYDRA_WORKSPACE?{workspace:process.env.HYDRA_WORKSPACE}:{})});task=hub.claudex.record(created.task.id);
 // HYDRA_AGY_SILENCE_MS: a short silence limit for agy, so that a real long step makes the watchdog pause; the trial then resumes, up to twice.
 if(process.env.HYDRA_AGY_SILENCE_MS)hub.claudex.agySilenceMs=Number(process.env.HYDRA_AGY_SILENCE_MS);
 const stuckPauses=[];
 const deadline=Date.now()+(Number(process.env.HYDRA_MINUTES)||12)*60000;let signature='';
 for(;;){
 while(hub.claudex.active(task)&&Date.now()<deadline){
  const state={status:task.status,phase:task.workflow.phase,seq:task.seq,turns:Object.fromEntries(task.roles.map(k=>[k,task.members[k].turns])),native:Object.fromEntries(task.roles.map(k=>[k,{status:hub.claudex.native(task,k).status,error:hub.claudex.native(task,k).error}])),votes:task.workflow.votes,tests:task.workflow.tests.map(t=>({role:t.role,status:t.status,command:t.command,error:t.error,output:t.status==='failed'?t.output:undefined}))};
  const next=JSON.stringify(state);if(next!==signature){signature=next;console.log(next);await writeFile(out+'/progress.json',JSON.stringify({directory,task:hub.claudex.detail(task.id)},null,2));}
  // While it is being applied the file changes before the application is recorded: that is the moment it is allowed to.
  if(task.workspace&&!task.workspace.applied&&!task.workspace.applying&&await readFile(cwd+'/sum.mjs','utf8')!==initial)realChanged=true;
  if(pauseIn.has(task.workflow.phase)&&!pausedIn.has(task.workflow.phase)&&task.status==='discussing'&&hub.claudex.native(task,author).status==='running'){
   paused=true;pausedIn.add(task.workflow.phase);console.log(JSON.stringify({pause:task.workflow.phase}));await hub.claudex.pause(task.id);
   const end=Date.now()+120000;for(;;){try{await hub.claudex.resume(task.id);break;}catch(error){if(Date.now()>end)throw error;await new Promise(r=>setTimeout(r,500));}}
   console.log(JSON.stringify({resumed:task.workflow.phase}));
  }
  // HYDRA_REMOVE=<role>: with the task in HYDRA_REMOVE_IN (validating by default), the user takes that participant out and goes on with the others.
  if(process.env.HYDRA_REMOVE&&!removed&&task.workflow.phase===(process.env.HYDRA_REMOVE_IN||'validating')&&task.status==='discussing'&&hub.claudex.native(task,process.env.HYDRA_REMOVE).status==='running'){
   removed=true;await hub.claudex.pause(task.id);console.log(JSON.stringify({removing:process.env.HYDRA_REMOVE,phase:task.workflow.phase}));
   const end=Date.now()+120000;for(;;){try{await hub.claudex.removeParticipant(task.id,{role:process.env.HYDRA_REMOVE,confirm:true});break;}catch(error){if(Date.now()>end||!/Aguarda/.test(error.message))throw error;await new Promise(r=>setTimeout(r,500));}}
   for(;;){try{await hub.claudex.resume(task.id);break;}catch(error){if(Date.now()>end)throw error;await new Promise(r=>setTimeout(r,500));}}
   console.log(JSON.stringify({resumedWith:task.roles}));
  }
  if(process.env.HYDRA_USER_EDIT==='1'&&!userEdit&&task.workflow.phase==='finalizing'){userEdit=true;roundAtEdit=task.workflow.round;await writeFile(cwd+'/nota-do-utilizador.txt','editado durante a tarefa\n');console.log(JSON.stringify({userEdit:true}));}
  if(hub.snapshot().approvals.length)throw Error('Decisão nativa pendente: '+JSON.stringify(hub.snapshot().approvals.map(a=>({method:a.method,params:a.params}))));
  await new Promise(r=>setTimeout(r,300));
 }
 if(process.env.HYDRA_AGY_SILENCE_MS&&task.status==='paused'&&task.pause?.kind==='stuck'&&stuckPauses.length<2&&Date.now()<deadline){
  stuckPauses.push({role:task.pause.stuck,phase:task.workflow.phase,reason:task.pause.reason});console.log(JSON.stringify({stuck:task.pause.stuck,phase:task.workflow.phase}));
  const end=Date.now()+120000;for(;;){try{await hub.claudex.resume(task.id);break;}catch(error){if(Date.now()>end)throw error;await new Promise(r=>setTimeout(r,500));}}
  continue;
 }
 break;
 }
 if(process.env.HYDRA_INJECT_FAILURE==='1')checks.push({name:'falha injetada identificada e corrigida em nova ronda',ok:injected&&task.workflow.round>=2&&task.workflow.tests.some(t=>t.status==='failed')&&task.workflow.tests.filter(t=>t.round===task.workflow.round).every(t=>t.status==='passed')});
 checks.push({name:'concluiu automaticamente',ok:task.status==='completed',error:task.error});
 const code=await readFile(cwd+'/sum.mjs','utf8');
 if(process.env.HYDRA_WORKSPACE==='copy'&&task.workspace){
  checks.push({name:'o projeto real só mudou depois de aprovado',ok:!realChanged});
  checks.push({name:'versão testada aplicada e pasta privada removida',ok:Boolean(task.workspace.applied)&&Boolean(task.workspace.removed)&&!await access(task.workspace.folder).then(()=>true,()=>false),detail:task.workspace.applied});
  checks.push({name:'as conversas voltaram à pasta do projeto',ok:task.roles.every(k=>hub.claudex.native(task,k).cwd===cwd&&!hub.claudex.native(task,k).workspaceOrigin)});
  if(process.env.HYDRA_PAUSE_IN)checks.push({name:'pausa e retoma reais na cópia',ok:paused});
  if(process.env.HYDRA_VENV==='1'){let pip='';try{pip=execFileSync(cwd+'/.venv/bin/pip',['--version'],{encoding:'utf8'});}catch(error){pip='ERRO '+error.message;}checks.push({name:'o .venv criado na cópia funciona no projeto',ok:pip.includes(cwd+'/.venv'),detail:pip.slice(0,200)});}
  if(process.env.HYDRA_USER_EDIT==='1')checks.push({name:'a edição do utilizador voltou aos testes e ficou no projeto',ok:userEdit&&task.workflow.round>roundAtEdit&&await readFile(cwd+'/nota-do-utilizador.txt','utf8').then(v=>v.includes('editado'),()=>false),detail:{roundAtEdit,round:task.workflow.round}});
  // In place the conversations are given back afterwards, and that renews Codex's connection: wait for it, as the page does.
  if(where.conversationId){const end=Date.now()+60000;while(!task.released&&Date.now()<end)await new Promise(r=>setTimeout(r,200));checks.push({name:'a conversa foi devolvida',ok:Boolean(task.released)});}
  // The first turn of these sessions happened in a folder that no longer exists.
  for(const role of task.roles){
   const c=hub.claudex.native(task,role),id='depois-'+role,before=c.messages.length;
   await clients[role].send(c.id,'Sem usar ferramentas: como se chama o ficheiro que esta tarefa corrigiu'+(where.conversationId&&role===author?', e qual é a palavra desta conversa':'')+'? Responde só com isso.',id,{sandbox:role==='codex'?'read-only':'plan',model:c.model,effort:c.effort});
   const end=Date.now()+4*60000;while(['starting','running','waiting'].includes(c.status)&&Date.now()<end)await new Promise(r=>setTimeout(r,300));
   const answer=c.messages.slice(before).filter(m=>m.role==='assistant').map(m=>m.text).join('\n');
   checks.push({name:role+': a sessão continua no projeto depois da tarefa',ok:c.status==='completed'&&answer.includes('sum')&&(!(where.conversationId&&role===author)||answer.includes(word)),detail:{status:c.status,error:c.error,answer:answer.slice(0,200)}});
  }
 }
 checks.push({name:scenario==='plan'?'planeamento sem escrita':'correção aplicada',ok:scenario==='plan'?code.includes('a - b'):code.includes('a + b')});
 checks.push({name:'apenas principal recebeu escrita',ok:Object.entries(clients).every(([role,c])=>c.conversations.flatMap(c=>c.turns).every(t=>!t.hydraWrite||role===author))});
 if(scenario!=='plan'){
  const short=task.dispatches.filter(d=>d.fullPrompt===false&&d.status==='sent');
  checks.push({name:'as continuações usam o prompt curto',ok:short.length>0,detail:{curtas:short.length,completas:task.dispatches.filter(d=>d.fullPrompt).length}});
  const finalizing=task.dispatches.filter(d=>d.phase==='finalizing');
  checks.push({name:'na conclusão os revisores só acordam para votar',ok:task.roles.filter(k=>k!==author).every(k=>finalizing.filter(d=>d.role===k).every(d=>d.candidateId)),detail:finalizing.map(d=>[d.role,Boolean(d.candidateId)])});
 }
 if(process.env.HYDRA_AGY_SILENCE_MS)checks.push({name:'a vigilância pausou por silêncio, disse quem, e a retoma continuou',ok:stuckPauses.length>0&&stuckPauses.every(p=>p.role&&/está há/.test(p.reason)),detail:stuckPauses});
 if(pauseIn.size)checks.push({name:'pausou e retomou em cada fase pedida',ok:[...pauseIn].every(phase=>pausedIn.has(phase)),detail:{pedidas:[...pauseIn],feitas:[...pausedIn]}});
 if(process.env.HYDRA_CLOSE_GRACE_MS){
  const ended=task.dispatches.filter(d=>d.ended==='watchdog');
  checks.push({name:'turnos terminados pela vigilância, sem pausar',ok:ended.length>0&&!task.pause,detail:ended.map(d=>[d.role,d.phase])});
 }
 if(process.env.HYDRA_REMOVE){
  checks.push({name:'o retirado saiu e os outros decidiram',ok:removed&&!task.roles.includes(process.env.HYDRA_REMOVE)&&task.removedParticipants?.[0]?.role===process.env.HYDRA_REMOVE&&/2\/2/.test(task.result?.label||''),detail:task.result?.label});
  checks.push({name:'a conclusão diz quem saiu',ok:/foi retirado da tarefa pelo utilizador/.test(task.result?.text||'')});
  const gone=clients[process.env.HYDRA_REMOVE].conversations.find(c=>c.id===task.removedParticipants?.[0]?.conversationId);
  checks.push({name:'a conversa dele voltou ao normal',ok:gone&&gone.claudexTask===undefined&&gone.cwd===cwd,detail:{status:gone?.status,cwd:gone?.cwd}});
 }
 if(objector){
  const answered=[...task.candidates.map(c=>c.objection),...task.workflow.rounds.map(x=>x.objection)].filter(Boolean);
  checks.push({name:objector+' objetou e o principal respondeu',ok:answered.some(o=>o.against.some(x=>x.role===objector)&&o.response),detail:answered.map(o=>({against:o.against,response:o.response}))});
  checks.push({name:'a resposta do principal está no histórico',ok:task.messages.some(m=>m.type==='objection-response'&&m.from===author)});
  checks.push({name:'a conclusão traz o registo da objeção',ok:/Objeção de /.test(task.result?.text||'')||answered.every(o=>o.response?.decision==='revise')});
 }
 if(scenario!=='plan'){
  checks.push({name:'todos leram as alterações pelo servidor',ok:task.roles.every(role=>task.workflow.changesRead?.[role]===task.workflow.round),detail:task.workflow.changes});
  checks.push({name:'a comparação mostra sum.mjs',ok:(task.workflow.changes?.summary?.files||0)>=1,detail:task.workflow.changes?.summary});
 }
 if(scenario!=='plan')checks.push({name:'testes reais de todos passaram',ok:task.roles.every(role=>task.workflow.tests.some(t=>t.role===role&&t.status==='passed'))});
 if(realistic){
  const round=task.workflow.tests.filter(t=>t.round===task.workflow.round);
  checks.push({name:'npm test e pytest correm nos testes',ok:['npm test','pytest'].every(tool=>round.some(t=>t.command.includes(tool)&&t.status==='passed')),detail:round.map(t=>[t.role,t.status,t.command.slice(0,80),t.changedFiles])});
  checks.push({name:'nenhum teste falhou por alterar código',ok:task.workflow.tests.every(t=>!t.sourceChanged)});
  checks.push({name:'.env não aparece nas saídas dos testes',ok:!JSON.stringify(task.workflow.tests).includes(fakeSecret)});
  checks.push({name:'.gitignore e testes do projeto intactos',ok:(await readFile(cwd+'/.gitignore','utf8')).includes('node_modules')&&execFileSync('git',['log','--oneline'],{cwd,encoding:'utf8'}).trim().split('\n').length===1});
 }
}catch(error){checks.push({name:'execução sem erro',ok:false,error:error.message});console.error(error.message);}
finally{
 if(task)await writeFile(out+'/detail.json',JSON.stringify(hub.claudex.detail(task.id),null,2));
 server?.closeStreams();if(server)await new Promise(r=>server.close(r));await hub.close();
 await writeFile(out+'/summary.json',JSON.stringify({directory,checks},null,2));console.log(JSON.stringify({directory,checks,out}));if(checks.some(c=>!c.ok))process.exitCode=1;
}
