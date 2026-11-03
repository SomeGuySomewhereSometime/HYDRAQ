// Real subscriptions; fresh sessions and a synthetic project, never production histories.
// A clarification invalidates the approved plan while the principal writes. The coordinator stops the turns and every
// participant must go on using the task's MCP tools, in the same sessions, for the new plan.
// node validation/hydra-replan-live.mjs --run [evidence-directory]
// HYDRA_ROLES, HYDRA_AUTHOR and HYDRA_*_MODEL choose participants; HYDRA_STOP_AFTER_POSITIONS=1 stops after the new positions.
import {mkdtemp,mkdir,writeFile,readFile,access} from 'node:fs/promises';
import path from 'node:path';
import {Providers} from '../lib/providers.mjs';
import {Hydraq} from '../lib/hydraq.mjs';
import {ClaudeCode} from '../lib/claude.mjs';
import {Antigravity} from '../lib/antigravity.mjs';
import {createHttpServer} from '../lib/http.mjs';
if(!process.argv.includes('--run'))throw Error('Usa --run: este ensaio faz chamadas reais.');
for(const [id,bin] of Object.entries({CODEX:'codex',CLAUDE:'claude',AGY:'agy'})){const file='/home/sauron/.local/bin/'+bin;if(await access(file).then(()=>true,()=>false))process.env['HYDRAQ_'+id+'_BIN']=file;}
const directory=await mkdtemp('/tmp/hydra-replan-live-'),cwd=directory+'/project',out=path.resolve(process.argv[3]||'output/hydra-replan-live');
await mkdir(cwd);await mkdir(out,{recursive:true});
await writeFile(cwd+'/sum.mjs','export const sum = (a,b) => a - b;\n');
await writeFile(cwd+'/sum.test.mjs',"import test from 'node:test'; import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; test('sum',()=>{assert.equal(sum(2,3),5);assert.equal(sum(-2,1),-1);});\n");
const allClients={codex:new Hydraq({dataDir:directory+'/codex',defaultCwd:cwd}),claude:new ClaudeCode({dataDir:directory+'/claude',defaultCwd:cwd,questions:true}),antigravity:new Antigravity({dataDir:directory+'/antigravity',defaultCwd:cwd})};
const roles=(process.env.HYDRA_ROLES||'codex,claude,antigravity').split(','),clients=Object.fromEntries(roles.map(k=>[k,allClients[k]])),author=process.env.HYDRA_AUTHOR||roles.at(-1);
const hub=new Providers({dataDir:directory+'/hub',defaultCwd:cwd,clients,git:async()=>[]}),cx=hub.claudex,stopEarly=process.env.HYDRA_STOP_AFTER_POSITIONS==='1';
const checks=[],check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),...(detail===undefined?{}:{detail})});console.log((ok?'OK   ':'FAIL ')+name+(ok||detail===undefined?'':' — '+JSON.stringify(detail)));};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let server,task;
/** Native questions a model happens to ask get a neutral answer, so the trial does not stall. */
async function answerQuestions(){
 for(const a of hub.snapshot().approvals||[]){
  if(!['claude/askUserQuestion','tool/requestUserInput'].includes(a.method))throw Error('Decisão nativa pendente: '+JSON.stringify({method:a.method,params:a.params}));
  await hub.respond(a.id,{decision:'accept',answers:Object.fromEntries(a.params.questions.map(q=>[q.id||q.question,'Sem preferência; decide de acordo com o pedido.']))});
 }
}
const toolFailures=role=>cx.native(task,role).items.filter(i=>i.type==='mcpToolCall'&&(i.status==='failed'||i.error)).map(i=>({tool:i.tool,status:i.status,error:String(i.error?.message||i.error||'').slice(0,200)}));
/** Waits while answering native questions; false when the task left the running states first. */
async function until(fn,ms){const end=Date.now()+ms;while(!fn()){if(!cx.active(task)||Date.now()>end)return fn();await answerQuestions();await pause(300);}return true;}
try{
 await hub.load();await Promise.all(Object.values(clients).map(c=>c.connect()));
 const desired={codex:process.env.HYDRA_CODEX_MODEL||'gpt-6.1-sol',claude:process.env.HYDRA_CLAUDE_MODEL||'sonnet',antigravity:process.env.HYDRA_AGY_MODEL||'gemini-3.8-flash'};
 const members=Object.fromEntries(roles.map(role=>{const c=clients[role],m=c.models.find(m=>m.id===desired[role]);if(!m)throw Error(role+': modelo indisponível '+desired[role]);return [role,{model:m.id,effort:m.efforts.includes('low')?'low':m.defaultEffort}];}));
 console.log(JSON.stringify({directory,members,author}));
 server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const text='Corrige sum.mjs para que sum some dois números. Implementa essa correção sem alterar os testes existentes e confirma com node --test sum.test.mjs.';
 const created=await cx.create({requestId:'live-'+Date.now(),cwd,roles,members,author,text,guards:{turns:20,minutes:14}});task=cx.record(created.task.id);
 check('plano aprovado e principal a escrever',await until(()=>task.workflow.phase==='implementing'&&cx.native(task,author).status==='running',5*60000),{status:task.status,phase:task.workflow.phase,error:task.error});
 if(task.workflow.phase==='implementing'){
  const before=Object.fromEntries(roles.filter(k=>k!=='antigravity').map(k=>[k,cx.leases&&[...cx.leases.values()].find(l=>l.taskId===task.id&&l.role===k)?.config.file]));
  await cx.answer(task.id,{requestId:'answer:live-1',provider:author,questions:[{id:'requisito',question:'Há algum requisito novo?',header:'Requisito'}],decision:'accept',answers:{requisito:'Sim. Além da correção, acrescenta em sum.mjs a função exportada sub(a,b), que subtrai. Isto muda o plano aprovado.'}});
  const answer=task.messages.findLast(m=>m.type==='answer'),token=[...cx.leases].find(([,l])=>l.taskId===task.id&&l.role===author)[0];
  await cx.tool(token,'request_replan',{answerSeq:answer.seq,reason:'O esclarecimento acrescenta a função sub, que o plano aprovado não prevê.'});
  check('replaneamento concluído com os turnos parados',await until(()=>task.workflow.replans?.[0]?.status==='completed',90000),{status:task.status,replan:task.workflow.replan,error:task.error});
  const after=Object.fromEntries(Object.keys(before).map(k=>[k,[...cx.leases.values()].find(l=>l.taskId===task.id&&l.role===k)?.config.file]));
  check('ligação MCP dos participantes mantida',Object.keys(before).every(k=>before[k]===after[k]),{before,after});
  const positioned=await until(()=>roles.every(k=>task.positions[k]),5*60000);
  for(const role of roles)check(role+' usou as ferramentas da tarefa depois do replaneamento',Boolean(task.positions[role]),{status:cx.native(task,role).status,failures:toolFailures(role).slice(-4),taskStatus:task.status,error:task.error});
  check('autorização reclassificada por todos',!positioned||roles.every(k=>task.workflow.intents[k]),task.workflow.intents);
  if(positioned&&!stopEarly){
   await until(()=>task.status==='completed',11*60000);
   check('tarefa concluída depois do replaneamento',task.status==='completed',{status:task.status,phase:task.workflow.phase,error:task.error});
   const code=await readFile(cwd+'/sum.mjs','utf8');check('novo requisito implementado',/a \+ b/.test(code)&&/sub/.test(code),code);
   const last=task.workflow.tests.filter(t=>t.round===task.workflow.round);check('testes da última ronda passaram para todos',roles.every(k=>last.some(t=>t.role===k&&t.status==='passed'))&&last.every(t=>t.status==='passed'),last.map(t=>[t.role,t.status,t.command]));
   check('só o principal recebeu escrita',Object.entries(clients).every(([role,c])=>c.conversations.flatMap(c=>c.turns).every(t=>!t.hydraWrite||role===author)));
  }
 }
}catch(error){check('execução sem erro',false,error.message);console.error(error);}
finally{
 if(task)await writeFile(out+'/detail.json',JSON.stringify(cx.detail(task.id),null,2));
 const usage=task?Object.fromEntries(roles.map(k=>[k,{turns:task.members[k].turns,toolFailures:toolFailures(k).length}])):null;
 server?.closeStreams();if(server)await new Promise(r=>server.close(r));await hub.close();
 await writeFile(out+'/summary.json',JSON.stringify({directory,roles,author,usage,checks},null,2));console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).length,usage,out}));if(checks.some(c=>!c.ok))process.exitCode=1;
}
