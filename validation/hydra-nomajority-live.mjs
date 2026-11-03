// Real subscriptions; fresh sessions and a synthetic project, never production histories.
// A pair where one participant is told to refuse every version of the plan: with two, that is never a majority. After three
// versions the task must pause for the user, with nothing written, instead of going round until the guards.
// node validation/hydra-nomajority-live.mjs --run [evidence-directory]
// HYDRA_CLAUDE_MODEL, HYDRA_AGY_MODEL and HYDRA_EFFORT choose the models; the principal is Claude, the one refusing agy.
import {mkdtemp,mkdir,writeFile,readFile,access} from 'node:fs/promises';
import path from 'node:path';
import {Providers} from '../lib/providers.mjs';
import {ClaudeCode} from '../lib/claude.mjs';
import {Antigravity} from '../lib/antigravity.mjs';
import {createHttpServer} from '../lib/http.mjs';
if(!process.argv.includes('--run'))throw Error('Usa --run: este ensaio faz chamadas reais.');
for(const [id,bin] of Object.entries({CLAUDE:'claude',AGY:'agy'})){const file='/home/sauron/.local/bin/'+bin;if(await access(file).then(()=>true,()=>false))process.env['HYDRAQ_'+id+'_BIN']=file;}
const directory=await mkdtemp('/tmp/hydra-nomajority-live-'),cwd=directory+'/project',out=path.resolve(process.argv[3]||'output/hydra-nomajority-live');
await mkdir(cwd);await mkdir(out,{recursive:true});
const original='export const sum = (a,b) => a - b;\n';
await writeFile(cwd+'/sum.mjs',original);
await writeFile(cwd+'/sum.test.mjs',"import test from 'node:test'; import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; test('sum',()=>{assert.equal(sum(2,3),5);});\n");
const clients={claude:new ClaudeCode({dataDir:directory+'/claude',defaultCwd:cwd,questions:true}),antigravity:new Antigravity({dataDir:directory+'/antigravity',defaultCwd:cwd})};
const roles=['claude','antigravity'],author='claude';
const hub=new Providers({dataDir:directory+'/hub',defaultCwd:cwd,clients,git:async()=>[]}),cx=hub.claudex;
const checks=[],check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),...(detail===undefined?{}:{detail})});console.log((ok?'OK   ':'FAIL ')+name+(ok||detail===undefined?'':' — '+JSON.stringify(detail).slice(0,800)));};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let server,task;
async function answerQuestions(){for(const a of hub.snapshot().approvals||[]){if(!['claude/askUserQuestion','tool/requestUserInput'].includes(a.method))throw Error('Decisão nativa pendente: '+a.method);await hub.respond(a.id,{decision:'accept',answers:Object.fromEntries(a.params.questions.map(q=>[q.id||q.question,'Sem preferência; segue o pedido.']))});}}
try{
 await hub.load();await Promise.all(Object.values(clients).map(c=>c.connect()));
 const desired={claude:process.env.HYDRA_CLAUDE_MODEL||'opus',antigravity:process.env.HYDRA_AGY_MODEL||'gemini-3.8-flash'},wanted=process.env.HYDRA_EFFORT;
 const members=Object.fromEntries(roles.map(role=>{const m=clients[role].models.find(m=>m.id===desired[role]);if(!m)throw Error(role+': modelo indisponível '+desired[role]);return [role,{model:m.id,effort:wanted&&m.efforts.includes(wanted)?wanted:m.efforts.includes('low')?'low':m.defaultEffort}];}));
 console.log(JSON.stringify({directory,members,author}));
 server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const text='Corrige sum.mjs para que sum some dois números e confirma com node --test sum.test.mjs. Isto é um ensaio do protocolo de maioria: o participante antigravity vota changes em review_final em todas as versões do plano, cada vez com uma razão concreta, mesmo que concorde com elas. O principal revê a proposta como entender.';
 const created=await cx.create({requestId:'live-'+Date.now(),cwd,roles,members,author,text,guards:{turns:20,minutes:14}});task=cx.record(created.task.id);
 const end=Date.now()+14*60000;let signature='';
 while(cx.active(task)&&Date.now()<end){const state=JSON.stringify({status:task.status,phase:task.workflow.phase,versions:task.candidates.length,votes:Object.fromEntries(Object.entries(task.workflow.votes).map(([k,v])=>[k,v.decision]))});if(state!==signature){signature=state;console.log(state);}await answerQuestions();await pause(400);}
 const versions=task.candidates.filter(c=>c.phase==='planning');
 check('a tarefa pausou para o utilizador por falta de maioria',task.status==='paused'&&task.pause?.kind==='no-majority',{status:task.status,pause:task.pause?.kind,reason:task.pause?.reason?.slice(0,300),error:task.error});
 check('foram três versões do plano, todas recusadas pelo antigravity',versions.length===3&&versions.every(c=>c.votes?.antigravity&&c.votes.antigravity.decision!=='approve'),versions.map(c=>({votes:c.votes&&Object.fromEntries(Object.entries(c.votes).map(([k,v])=>[k,v.decision+': '+v.reason.slice(0,120)]))})));
 check('o motivo explica e mostra as objeções',/Três versões sem maioria/.test(task.pause?.reason||'')&&/antigravity/.test(task.pause?.reason||''));
 check('nada foi implementado',task.workflow.phase==='planning'&&!task.workflow.writeStarted&&await readFile(cwd+'/sum.mjs','utf8')===original&&Object.values(clients).every(c=>c.conversations.flatMap(c=>c.turns).every(t=>!t.hydraWrite)));
 await cx.stop(task.id);
 check('parar depois da pausa termina a tarefa',task.status==='interrupted',{status:task.status});
}catch(error){check('execução sem erro',false,error.message);console.error(error);}
finally{
 if(task)await writeFile(out+'/detail.json',JSON.stringify(cx.detail(task.id),null,2));
 server?.closeStreams();if(server)await new Promise(r=>server.close(r));await hub.close();
 await writeFile(out+'/summary.json',JSON.stringify({directory,roles,author,checks},null,2));console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).length,out}));if(checks.some(c=>!c.ok))process.exitCode=1;
}
