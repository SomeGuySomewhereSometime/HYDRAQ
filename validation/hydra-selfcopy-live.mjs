// Real subscriptions; fresh sessions; the project is a copy of HYDRAQ itself (266 files, 12 MB, with Git), never the real repository.
// The task fixes a real gap in it: the test-command filter does not know /usr/bin/env as a launcher. It works in a private copy,
// so the project only changes once reviewed; afterwards the project's own tests run outside the task to check the result.
// node validation/hydra-selfcopy-live.mjs --run [evidence-directory]
// HYDRA_ROLES (default claude,antigravity), HYDRA_AUTHOR (default claude) and HYDRA_*_MODEL choose participants.
import {mkdtemp,mkdir,writeFile,readFile,access,copyFile} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {Providers} from '../lib/providers.mjs';
import {Hydraq} from '../lib/hydraq.mjs';
import {ClaudeCode} from '../lib/claude.mjs';
import {Antigravity} from '../lib/antigravity.mjs';
import {createHttpServer} from '../lib/http.mjs';
if(!process.argv.includes('--run'))throw Error('Usa --run: este ensaio faz chamadas reais.');
for(const [id,bin] of Object.entries({CODEX:'codex',CLAUDE:'claude',AGY:'agy'})){const file='/home/sauron/.local/bin/'+bin;if(await access(file).then(()=>true,()=>false))process.env['HYDRAQ_'+id+'_BIN']=file;}
const repo=path.resolve(new URL('..',import.meta.url).pathname),directory=await mkdtemp('/tmp/hydra-selfcopy-live-'),cwd=directory+'/hydraq',out=path.resolve(process.argv[3]||'output/hydra-selfcopy-live');
await mkdir(out,{recursive:true});
// What Git would keep of the working tree, without the evidence folders.
const files=execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:repo,encoding:'utf8'}).split('\0').filter(f=>f&&!f.startsWith('output/'));
for(const file of files){await mkdir(path.dirname(path.join(cwd,file)),{recursive:true});await copyFile(path.join(repo,file),path.join(cwd,file));}
const git=(...args)=>execFileSync('git',['-c','user.name=Ensaio','-c','user.email=ensaio@hydraq.invalid',...args],{cwd,stdio:'pipe'});
git('init','-q');git('add','-A');git('commit','-qm','Cópia da HYDRAQ para o ensaio');
const target=path.join(cwd,'lib/hydra-validation.mjs'),fingerprint=async()=>createHash('sha256').update(await readFile(target)).digest('hex'),before=await fingerprint();
const allClients={codex:new Hydraq({dataDir:directory+'/codex',defaultCwd:cwd}),claude:new ClaudeCode({dataDir:directory+'/claude',defaultCwd:cwd,questions:true}),antigravity:new Antigravity({dataDir:directory+'/antigravity',defaultCwd:cwd})};
const roles=(process.env.HYDRA_ROLES||'claude,antigravity').split(','),clients=Object.fromEntries(roles.map(k=>[k,allClients[k]])),author=process.env.HYDRA_AUTHOR||'claude';
const hub=new Providers({dataDir:directory+'/hub',defaultCwd:cwd,clients,git:async()=>[]}),cx=hub.claudex;
const checks=[],check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),...(detail===undefined?{}:{detail})});console.log((ok?'OK   ':'FAIL ')+name+(ok||detail===undefined?'':' — '+JSON.stringify(detail).slice(0,1500)));};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let server,task,changedEarly=false;
async function answerQuestions(){for(const a of hub.snapshot().approvals||[]){if(!['claude/askUserQuestion','tool/requestUserInput'].includes(a.method))throw Error('Decisão nativa pendente: '+JSON.stringify({method:a.method}));await hub.respond(a.id,{decision:'accept',answers:Object.fromEntries(a.params.questions.map(q=>[q.id||q.question,'Sem preferência; segue o pedido.']))});}}
try{
 await hub.load();await Promise.all(Object.values(clients).map(c=>c.connect()));
 const desired={codex:process.env.HYDRA_CODEX_MODEL||'gpt-6.1-sol',claude:process.env.HYDRA_CLAUDE_MODEL||'opus',antigravity:process.env.HYDRA_AGY_MODEL||'gemini-3.8-flash'};
 const members=Object.fromEntries(roles.map(role=>{const c=clients[role],m=c.models.find(m=>m.id===desired[role]);if(!m)throw Error(role+': modelo indisponível '+desired[role]);return [role,{model:m.id,effort:m.efforts.includes('low')?'low':m.defaultEffort}];}));
 console.log(JSON.stringify({directory,files:files.length,members,author}));
 server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const text="Em lib/hydra-validation.mjs, testCommandProblem não reconhece /usr/bin/env como prefixo: `/usr/bin/env bash -c 'test 1 = 2; echo t'` é aceite, embora `env bash -c '…'` seja recusado. Corrige isso, de forma mínima, para que um prefixo dado pelo caminho completo (/usr/bin/env, /bin/env, /usr/bin/timeout e semelhantes) seja tratado como o mesmo programa pelo nome. Acrescenta casos ao teste 'shells dentro do comando, wait, trap e ! a meio não escondem falhas' em test/hydra-validation.test.mjs e confirma com node --test test/hydra-validation.test.mjs. Não alteres mais nada.";
 const created=await cx.create({requestId:'live-'+Date.now(),cwd,roles,members,author,text,workspace:'copy',guards:{turns:30,minutes:30}});task=cx.record(created.task.id);
 const end=Date.now()+30*60000;let signature='';
 while(cx.active(task)&&Date.now()<end){
  const state=JSON.stringify({status:task.status,phase:task.workflow.phase,round:task.workflow.round,turns:Object.fromEntries(task.roles.map(k=>[k,task.members[k].turns]))});if(state!==signature){signature=state;console.log(state);}
  if(!task.workspace?.applied&&!task.workspace?.applying&&await fingerprint()!==before)changedEarly=true;
  await answerQuestions();await pause(500);
 }
 check('a tarefa concluiu',task.status==='completed',{status:task.status,phase:task.workflow.phase,error:task.error,pause:task.pause?.kind});
 check('o projeto só mudou depois de aprovado',!changedEarly);
 check('a versão testada foi aplicada',Boolean(task.workspace?.applied)&&await fingerprint()!==before,task.workspace?.applied);
 const last=task.workflow.tests.filter(t=>t.round===task.workflow.round);
 check('testes da última ronda passaram para todos',roles.every(k=>last.some(t=>t.role===k&&t.status==='passed'))&&last.every(t=>t.status==='passed'),last.map(t=>[t.role,t.status,t.command.slice(0,100)]));
 check('todos leram as alterações pelo servidor',roles.every(k=>task.workflow.changesRead?.[k]===task.workflow.round),task.workflow.changes?.summary);
 // The result, checked with the project's own code and tests, outside the task.
 const fixed=spawnSync(process.execPath,['--input-type=module','-e',"const {testCommandProblem}=await import(process.argv[1]);console.log(JSON.stringify([\"/usr/bin/env bash -c 'test 1 = 2; echo t'\",\"bash -c 'npm test'\",\"/usr/bin/env node --test\"].map(c=>testCommandProblem(c))));",target],{encoding:'utf8'});
 let verdicts=null;try{verdicts=JSON.parse(fixed.stdout.trim());}catch{}
 check('/usr/bin/env bash -c com vários comandos passa a ser recusado',verdicts&&verdicts[0]&&!verdicts[1]&&!verdicts[2],{verdicts,stderr:fixed.stderr.slice(-400)});
 const own=spawnSync(process.execPath,['--test','test/hydra-validation.test.mjs'],{cwd,encoding:'utf8',timeout:300000});
 check('os testes do próprio projeto passam fora da tarefa',own.status===0,own.stdout.split('\n').filter(l=>/^# (pass|fail)|^not ok/.test(l)));
 const diff=execFileSync('git',['diff','--stat'],{cwd,encoding:'utf8'}).trim();
 check('só mudaram os dois ficheiros pedidos',diff.split('\n').slice(0,-1).every(l=>/lib\/hydra-validation\.mjs|test\/hydra-validation\.test\.mjs/.test(l)),diff);
 await writeFile(out+'/diff.patch',execFileSync('git',['diff'],{cwd,encoding:'utf8'}));
}catch(error){check('execução sem erro',false,error.message);console.error(error);}
finally{
 if(task)await writeFile(out+'/detail.json',JSON.stringify(cx.detail(task.id),null,2));
 server?.closeStreams();if(server)await new Promise(r=>server.close(r));await hub.close();
 await writeFile(out+'/summary.json',JSON.stringify({directory,roles,author,checks},null,2));console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).length,out}));if(checks.some(c=>!c.ok))process.exitCode=1;
}
