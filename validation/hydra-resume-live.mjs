// Real subscriptions; fresh sessions and a synthetic project, never production histories.
// A task from an existing conversation: the server closes while the principal writes and starts again, then the task is
// paused and resumed in review and in the conclusion. It must finish with one round and give the conversation back.
// node validation/hydra-resume-live.mjs --run [evidence-directory]
// HYDRA_ROLES, HYDRA_AUTHOR and HYDRA_*_MODEL choose participants.
import {mkdtemp,mkdir,writeFile,readFile,access,rm} from 'node:fs/promises';
import path from 'node:path';
import {Providers} from '../lib/providers.mjs';
import {Hydraq} from '../lib/hydraq.mjs';
import {ClaudeCode} from '../lib/claude.mjs';
import {Antigravity} from '../lib/antigravity.mjs';
import {createHttpServer} from '../lib/http.mjs';
import {hydraReturnNote} from '../lib/claudex.mjs';
if(!process.argv.includes('--run'))throw Error('Usa --run: este ensaio faz chamadas reais.');
for(const [id,bin] of Object.entries({CODEX:'codex',CLAUDE:'claude',AGY:'agy'})){const file='/home/sauron/.local/bin/'+bin;if(await access(file).then(()=>true,()=>false))process.env['HYDRAQ_'+id+'_BIN']=file;}
const directory=await mkdtemp('/tmp/hydra-resume-live-'),cwd=directory+'/project',out=path.resolve(process.argv[3]||'output/hydra-resume-live');
await mkdir(cwd);await mkdir(out,{recursive:true});
await writeFile(cwd+'/sum.mjs','export const sum = (a,b) => a - b;\n');
await writeFile(cwd+'/sum.test.mjs',"import test from 'node:test'; import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; test('sum',()=>{assert.equal(sum(2,3),5);assert.equal(sum(-2,1),-1);});\n");
const roles=(process.env.HYDRA_ROLES||'claude,antigravity').split(','),author=process.env.HYDRA_AUTHOR||roles[0];
const desired={codex:process.env.HYDRA_CODEX_MODEL||'gpt-6.1-sol',claude:process.env.HYDRA_CLAUDE_MODEL||'sonnet',antigravity:process.env.HYDRA_AGY_MODEL||'gemini-3.8-flash'};
const build={codex:()=>new Hydraq({dataDir:directory+'/codex',defaultCwd:cwd}),claude:()=>new ClaudeCode({dataDir:directory+'/claude',defaultCwd:cwd,questions:true}),antigravity:()=>new Antigravity({dataDir:directory+'/antigravity',defaultCwd:cwd})};
const checks=[],check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),...(detail===undefined?{}:{detail})});console.log((ok?'OK   ':'FAIL ')+name+(ok||detail===undefined?'':' — '+JSON.stringify(detail).slice(0,400)));};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let hub,server,clients,task,cx,conversationId;
async function start(){
 clients=Object.fromEntries(roles.map(k=>[k,build[k]()]));
 hub=new Providers({dataDir:directory+'/hub',defaultCwd:cwd,clients,git:async()=>[]});await hub.load();await Promise.all(Object.values(clients).map(c=>c.connect()));cx=hub.claudex;
 server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});await new Promise(r=>server.listen(0,'127.0.0.1',r));
}
async function stop(){server.closeStreams();await new Promise(r=>server.close(r));await hub.close();}
async function answerQuestions(){
 for(const a of hub.snapshot().approvals||[]){
  if(!['claude/askUserQuestion','tool/requestUserInput'].includes(a.method))throw Error('Decisão nativa pendente: '+JSON.stringify({method:a.method,params:a.params}));
  await hub.respond(a.id,{decision:'accept',answers:Object.fromEntries(a.params.questions.map(q=>[q.id||q.question,'Sem preferência; decide de acordo com o pedido.']))});
 }
}
async function until(fn,ms){const end=Date.now()+ms;while(!fn()){if(!cx.active(task)||Date.now()>end)return fn();await answerQuestions();await pause(300);}return true;}
const settled=async()=>{const end=Date.now()+60000;while((cx.pauseDrains.has(task.id)||cx.jobs.has(task.id)||task.pause?.interruptionPending||roles.some(k=>['starting','running','waiting'].includes(cx.native(task,k).status)))&&Date.now()<end)await pause(100);};
const describe=()=>({status:task.status,phase:task.workflow.phase,round:task.workflow.round,turns:Object.fromEntries(roles.map(k=>[k,task.members[k].turns])),error:task.error});
try{
 await start();
 const members=Object.fromEntries(roles.map(role=>{const c=clients[role],m=c.models.find(m=>m.id===desired[role]);if(!m)throw Error(role+': modelo indisponível '+desired[role]);return [role,{model:m.id,effort:m.efforts.includes('low')?'low':m.defaultEffort}];}));
 console.log(JSON.stringify({directory,members,author}));
 conversationId=(await hub.create({provider:author,cwd,...members[author],sandbox:author==='codex'?'workspace-write':'workspace-write'})).id;
 const created=await cx.create({requestId:'live-'+Date.now(),conversationId,roles,members,author,text:'Corrige sum.mjs para que sum some dois números. Implementa essa correção sem alterar os testes existentes e confirma com node --test sum.test.mjs. Faz o trabalho com calma, primeiro lendo os dois ficheiros.',guards:{turns:24,minutes:15}});
 task=cx.record(created.task.id);

 check('principal a escrever',await until(()=>task.workflow.phase==='implementing'&&cx.native(task,author).status==='running',5*60000),describe());
 await pause(2000);
 const plan=task.workflow.approvedPlan?.id,threads=Object.fromEntries(roles.map(k=>[k,cx.native(task,k).threadId]));
 await stop();
 check('fechar o servidor pausa a tarefa',task.status==='paused'&&task.pause?.kind==='restart',describe());

 await start();task=cx.record(task.id);await pause(1500);
 check('depois de arrancar, a tarefa continua em pausa e a conversa não foi devolvida',task.status==='paused'&&!task.released&&cx.holds(conversationId),describe());
 check('nada foi reenviado sozinho',roles.every(k=>!['starting','running','waiting'].includes(cx.native(task,k).status)),roles.map(k=>cx.native(task,k).status));
 await cx.resume(task.id);
 check('retoma na implementação, com o mesmo plano',task.workflow.phase==='implementing'&&task.workflow.approvedPlan?.id===plan,describe());
 check('mesmas sessões nativas',roles.every(k=>cx.native(task,k).threadId===threads[k]));

 if(await until(()=>task.workflow.phase==='validating'&&roles.some(k=>cx.native(task,k).status==='running'),5*60000)){
  await pause(1500);const round=task.workflow.round;
  await cx.pause(task.id);await settled();await cx.resume(task.id);
  check('retoma na revisão na mesma ronda',task.workflow.phase==='validating'&&task.workflow.round===round,describe());
 }else check('chegou à revisão',false,describe());

 if(await until(()=>task.workflow.phase==='finalizing'&&roles.some(k=>cx.native(task,k).status==='running'),6*60000)){
  await pause(1500);const round=task.workflow.round,tests=task.workflow.tests.length,writes=clients[author].conversations.flatMap(c=>c.turns).filter(t=>t.hydraWrite).length;
  await cx.pause(task.id);await settled();await cx.resume(task.id);
  check('retoma na conclusão sem repetir testes nem escrita',task.workflow.phase==='finalizing'&&task.workflow.round===round&&task.workflow.tests.length===tests,describe());
  await until(()=>task.status==='completed',6*60000);
  check('o principal não voltou a escrever',clients[author].conversations.flatMap(c=>c.turns).filter(t=>t.hydraWrite).length===writes);
 }else check('chegou à conclusão',false,describe());

 check('tarefa concluída',task.status==='completed',describe());
 check('correção aplicada',(await readFile(cwd+'/sum.mjs','utf8')).includes('a + b'));
 check('uma só ronda',task.workflow.round===1,describe());
 const last=task.workflow.tests.filter(t=>t.round===task.workflow.round&&!t.supersededBy&&t.status!=='interrupted');
 check('testes da ronda passaram',roles.every(k=>last.some(t=>t.role===k&&t.status==='passed'))&&last.every(t=>t.status==='passed'),last.map(t=>[t.role,t.status,t.command]));
 // Status comes first: with Codex, giving the conversation back also renews its connection.
 for(let i=0;i<120&&!task.released;i++)await pause(500);
 check('conversa devolvida',Boolean(task.released)&&!cx.holds(conversationId));
 const back=clients[author].conversation(conversationId).hydraReturn;check('sem aviso de código por validar',back&&!back.unvalidated&&!/validou/.test(hydraReturnNote(back)),back);
}catch(error){check('execução sem erro',false,error.message);console.error(error);}
finally{
 if(task)await writeFile(out+'/detail.json',JSON.stringify(cx.detail(task.id),null,2));
 const usage=task?describe().turns:null;
 await stop().catch(()=>{});
 await writeFile(out+'/summary.json',JSON.stringify({roles,author,usage,checks},null,2));
 console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).map(c=>c.name),usage,out}));
 await rm(directory,{recursive:true,force:true}).catch(()=>{});
 if(checks.some(c=>!c.ok))process.exitCode=1;
 process.exit();
}
