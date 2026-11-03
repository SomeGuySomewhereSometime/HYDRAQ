// Real subscriptions; fresh sessions and a synthetic project, never production histories.
// The principal, Claude, asks the user a native question while it implements. The answer goes through the coordinator to
// every participant and adds a requirement the approved plan does not have: the model decides by itself whether to ask
// for a new plan or to fold it in. The trial records which, and checks the answer reached everyone and the task ended right.
// node validation/hydra-question-live.mjs --run [evidence-directory]
// HYDRA_ROLES (default claude,antigravity), HYDRA_CLAUDE_MODEL (default opus) and HYDRA_AGY_MODEL choose participants.
import {mkdtemp,mkdir,writeFile,readFile,access} from 'node:fs/promises';
import path from 'node:path';
import {Providers} from '../lib/providers.mjs';
import {Hydraq} from '../lib/hydraq.mjs';
import {ClaudeCode} from '../lib/claude.mjs';
import {Antigravity} from '../lib/antigravity.mjs';
import {createHttpServer} from '../lib/http.mjs';
if(!process.argv.includes('--run'))throw Error('Usa --run: este ensaio faz chamadas reais.');
for(const [id,bin] of Object.entries({CODEX:'codex',CLAUDE:'claude',AGY:'agy'})){const file='/home/sauron/.local/bin/'+bin;if(await access(file).then(()=>true,()=>false))process.env['HYDRAQ_'+id+'_BIN']=file;}
const directory=await mkdtemp('/tmp/hydra-question-live-'),cwd=directory+'/project',out=path.resolve(process.argv[3]||'output/hydra-question-live');
await mkdir(cwd);await mkdir(out,{recursive:true});
await writeFile(cwd+'/sum.mjs','export const sum = (a,b) => a - b;\n');
await writeFile(cwd+'/sum.test.mjs',"import test from 'node:test'; import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; test('sum',()=>{assert.equal(sum(2,3),5);assert.equal(sum(-2,1),-1);});\n");
const allClients={codex:new Hydraq({dataDir:directory+'/codex',defaultCwd:cwd}),claude:new ClaudeCode({dataDir:directory+'/claude',defaultCwd:cwd,questions:true}),antigravity:new Antigravity({dataDir:directory+'/antigravity',defaultCwd:cwd})};
const roles=(process.env.HYDRA_ROLES||'claude,antigravity').split(','),clients=Object.fromEntries(roles.map(k=>[k,allClients[k]])),author='claude';
const hub=new Providers({dataDir:directory+'/hub',defaultCwd:cwd,clients,git:async()=>[]}),cx=hub.claudex;
const checks=[],check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),...(detail===undefined?{}:{detail})});console.log((ok?'OK   ':'FAIL ')+name+(ok||detail===undefined?'':' — '+JSON.stringify(detail)));};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const ANSWER='Sim: acrescenta também em sum.mjs a função exportada sub(a,b), que subtrai, com um teste em sum.test.mjs. Isto muda o plano aprovado.';
let server,task,asked=null,early=[];
/** The principal's question during implementation gets the answer that adds a requirement; any other question a neutral one. */
async function answerQuestions(){
 for(const a of hub.snapshot().approvals||[]){
  if(!['claude/askUserQuestion','tool/requestUserInput'].includes(a.method))throw Error('Decisão nativa pendente: '+JSON.stringify({method:a.method,params:a.params}));
  const writing=task&&['implementing','fixing'].includes(task.workflow.phase)&&a.conversationId===task.members[author].conversationId&&!asked;
  if(writing)asked={phase:task.workflow.phase,questions:a.params.questions.map(q=>q.question),at:new Date().toISOString()};else early.push({phase:task?.workflow.phase,questions:a.params.questions.map(q=>q.question)});
  await hub.respond(a.id,{decision:'accept',answers:Object.fromEntries(a.params.questions.map(q=>[q.id||q.question,writing?ANSWER:'Sem preferência; segue o pedido.']))});
 }
}
async function until(fn,ms){const end=Date.now()+ms;while(!fn()){if(!cx.active(task)||Date.now()>end)return fn();await answerQuestions();await pause(300);}return true;}
try{
 await hub.load();await Promise.all(Object.values(clients).map(c=>c.connect()));
 const desired={codex:process.env.HYDRA_CODEX_MODEL||'gpt-6.1-sol',claude:process.env.HYDRA_CLAUDE_MODEL||'opus',antigravity:process.env.HYDRA_AGY_MODEL||'gemini-3.8-flash'};
 const members=Object.fromEntries(roles.map(role=>{const c=clients[role],m=c.models.find(m=>m.id===desired[role]);if(!m)throw Error(role+': modelo indisponível '+desired[role]);return [role,{model:m.id,effort:m.efforts.includes('low')?'low':m.defaultEffort}];}));
 console.log(JSON.stringify({directory,members,author}));
 server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const text='Corrige sum.mjs para que sum some dois números, sem alterar os testes existentes, e confirma com node --test sum.test.mjs. Ensaio do protocolo de perguntas: depois de o plano estar aprovado, já na implementação e antes de alterar sum.mjs, o principal pergunta-me com a ferramenta nativa de perguntas ao utilizador se quero mais alguma coisa. Não faças esta pergunta no planeamento.';
 const created=await cx.create({requestId:'live-'+Date.now(),cwd,roles,members,author,text,guards:{turns:24,minutes:16}});task=cx.record(created.task.id);
 const done=await until(()=>task.status==='completed',15*60000);
 check('o principal perguntou durante a implementação',Boolean(asked),{asked,early});
 const answer=task.messages.find(m=>m.type==='answer');
 check('a resposta chegou à tarefa pelo coordenador',answer&&answer.from==='user'&&JSON.parse(answer.text).answers&&Object.values(JSON.parse(answer.text).answers).some(v=>String(v.answers?.[0]??v).includes('sub(a,b)')),answer&&{seq:answer.seq,text:answer.text.slice(0,300)});
 const replans=task.workflow.replans||[];
 check('o modelo decidiu por si: novo plano ou incorporação',true,{replaneou:replans.map(x=>({role:x.role,answerSeq:x.answerSeq,reason:x.reason.slice(0,200)})),incorporou:!replans.length});
 check('a tarefa concluiu',done,{status:task.status,phase:task.workflow.phase,error:task.error,pause:task.pause?.kind});
 const code=await readFile(cwd+'/sum.mjs','utf8');
 check('a correção e o requisito da resposta estão no projeto',/a \+ b/.test(code)&&/sub/.test(code),code);
 const last=task.workflow.tests.filter(t=>t.round===task.workflow.round);
 check('testes da última ronda passaram para todos',roles.every(k=>last.some(t=>t.role===k&&t.status==='passed'))&&last.every(t=>t.status==='passed'),last.map(t=>[t.role,t.status,t.command]));
 check('cada participante leu a resposta antes de decidir',roles.every(k=>(task.read[k]?.seq||0)>=(answer?.seq||Infinity)||task.dispatches.some(d=>d.role===k&&d.seq>=(answer?.seq||Infinity)&&d.status==='sent')),Object.fromEntries(roles.map(k=>[k,task.read[k]?.seq])));
 check('só o principal recebeu escrita',Object.entries(clients).every(([role,c])=>c.conversations.flatMap(c=>c.turns).every(t=>!t.hydraWrite||role===author)));
}catch(error){check('execução sem erro',false,error.message);console.error(error);}
finally{
 if(task)await writeFile(out+'/detail.json',JSON.stringify(cx.detail(task.id),null,2));
 server?.closeStreams();if(server)await new Promise(r=>server.close(r));await hub.close();
 await writeFile(out+'/summary.json',JSON.stringify({directory,roles,author,checks},null,2));console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).length,out}));if(checks.some(c=>!c.ok))process.exitCode=1;
}
