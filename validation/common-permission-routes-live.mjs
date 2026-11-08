// Client sessions remain in a disposable HYDRAQ instance. --run makes real model requests.
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Providers} from '../lib/providers.mjs';
import {createHttpServer} from '../lib/http.mjs';
import {permissionSource} from '../lib/permissions.mjs';
if(!process.argv.includes('--run'))throw Error('Usa --run para os pedidos aos clientes reais.');
for(const [id,bin]of Object.entries({CODEX:'codex',CLAUDE:'claude',AGY:'agy',CURSOR:'cursor-agent'}))process.env['HYDRAQ_'+id+'_BIN']=path.join(os.homedir(),'.local/bin',bin);
process.env.HYDRAQ_NORMAL_DELEGATION='1';process.env.HYDRAQ_NORMAL_DELEGATION_LIMIT='1';
const root=await mkdtemp('/tmp/hydraq-permission-routes-'),cwd=root+'/project';
await mkdir(cwd);await writeFile(cwd+'/sample','ROUTE-PROBE');
const hub=new Providers({dataDir:root+'/state',defaultCwd:cwd}),rows=[];
const report={root,source:permissionSource,clients:{},binaries:{}};
const policy={profile:'read-only',network:false,externalMcp:false,plan:false};
let server;
const wait=async(predicate,ms=140000)=>{
 const end=Date.now()+ms;
 while(!predicate()){
  if(Date.now()>end)throw Error('O percurso excedeu o tempo.');
  for(const [id,client]of Object.entries(hub.clients))for(const approval of client.snapshot().approvals||[]){
   if(approval.method==='tool/requestUserInput')await client.respond(approval.id,{answers:Object.fromEntries(approval.params.questions.map(q=>[q.id,'Continua em leitura.']))});
   else if(approval.method==='claude/askUserQuestion')await client.respond(approval.id,{decision:'decline'});
   else await client.respond(approval.id,{decision:'decline'});
  }
  await new Promise(resolve=>setTimeout(resolve,250));
 }
};
function capture(provider,route,c){
 const turn=c.turns.at(-1),checks={completed:turn.status==='completed',policy:turn.permissionPolicy?.profile==='read-only',audit:turn.permissionAudit?.status==='passed'};
 const row={provider,route,profile:'read-only',status:Object.values(checks).every(Boolean)?'passed':'failed',checks,error:c.error||null};
 rows.push(row);console.log(JSON.stringify(row));return row;
}
try{
 await hub.load();report.binaries=hub.permissions.binaries;
 server=createHttpServer({hydraq:hub,publicDir:path.resolve('public')});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 await Promise.all(['codex','claude','antigravity'].map(id=>hub.connect(id)));
 const wanted={codex:'gpt-6.1-sol',claude:'sonnet',antigravity:'gemini-3.8-flash'};
 const settings=Object.fromEntries(Object.keys(wanted).map(id=>{
  const model=hub.clients[id].models.find(m=>m.id===wanted[id]);if(!model)throw Error('Modelo indisponível: '+id);
  return [id,{provider:id,model:model.id,effort:model.efforts.includes('low')?'low':model.defaultEffort}];
 }));
 const c=await hub.create({...settings.codex,cwd,sandbox:'read-only'});
 const {dual}=await hub.startDual(c.id,{participants:[settings.claude,settings.antigravity]});
 await hub.sendDual(dual.id,{text:'Lê sample com uma ferramenta de comandos e responde com o seu conteúdo, em leitura.',requestId:'multi-live',target:'all',multiVersion:2,revision:dual.revision||0,permissionPolicy:policy});
 await wait(()=>Object.values(dual.members).every(m=>{
  const c=hub.clients[m.provider].conversation(m.conversationId);
  return c.status==='completed'&&!hub.permissions.running.has(c.id);
 }));
 for(const m of Object.values(dual.members))capture(m.provider,'multi',hub.clients[m.provider].conversation(m.conversationId));
 await hub.endDual(dual.id);
 let current=hub.clients.codex.conversation(c.id);
 for(const target of ['claude','antigravity','codex']){
  const result=await hub.send(current.id,'Lê sample com a ferramenta de comandos e responde com o seu conteúdo.','switch-'+target,{...settings[target],provider:target,handoffMode:'quick',permissionPolicy:policy});
  const destination=hub.clients[target].conversation(result.conversationId);
  await wait(()=>destination.status==='completed'&&!hub.permissions.running.has(destination.id)&&!hub.handoff);
  capture(target,'switch',destination);current=destination;
 }
 const delegated=await hub.send(current.id,'Usa delegate_read_only exatamente uma vez para pedir ao Claude que leia sample e devolva o conteúdo. Depois consulta o resultado e responde com o que recebeste. O pedido é só de leitura.','delegation-live',{...settings.codex,permissionPolicy:policy});
 await wait(()=>!['starting','running','waiting'].includes(current.status)&&!hub.permissions.running.has(current.id),180000);
 await wait(()=>!hub.opinions.tasks.size);
 const jobs=hub.opinions.batches.filter(b=>b.kind==='delegation').flatMap(b=>b.jobs);
 const job=jobs.at(-1);
 const delegationChecks={completed:job?.status==='completed',inherited:job?.permissionPolicy?.profile==='read-only',parent:current.turns.at(-1)?.permissionPolicy?.profile==='read-only'};
 const dr={provider:job?.provider||'claude',route:'delegation',profile:'read-only',status:Object.values(delegationChecks).every(Boolean)?'passed':'failed',checks:delegationChecks,error:job?.error||current.error||null};
 rows.push(dr);console.log(JSON.stringify(dr));
 const {task}=await hub.claudex.create({cwd,text:'Analisa em leitura o ficheiro sample e apresenta uma conclusão curta que inclua o seu conteúdo. Não implementes. O principal propõe a conclusão quando todos tiverem terminado a leitura.',requestId:'hydra-live',roles:['codex','claude','antigravity'],members:settings,author:'codex',workflow:2,requestMode:'read-only',permissionPolicy:policy,guards:{turns:6,minutes:3}});
 await wait(()=>['completed','paused','no-agreement','interrupted'].includes(hub.claudex.record(task.id).status),200000);
 const r=hub.claudex.record(task.id);
 for(const role of r.roles){
  const c=hub.claudex.native(r,role),turn=c.turns.findLast(t=>t.internal==='claudex');
  await wait(()=>!hub.permissions.running.has(c.id),10000);
  const checks={completed:r.status==='completed',policy:turn.permissionPolicy?.profile==='read-only',audit:turn.permissionAudit?.status==='passed'};
  const row={provider:role,route:'hydra',profile:'read-only',status:Object.values(checks).every(Boolean)?'passed':'failed',checks,error:r.error||c.error||null};
  rows.push(row);console.log(JSON.stringify(row));
 }
} catch(error) {report.error=error.message;console.log(JSON.stringify({error:error.message}));}
finally {
 for(const row of rows){report.clients[row.provider]??={results:[]};report.clients[row.provider].results.push(row);}
 report.finishedAt=new Date().toISOString();await writeFile(root+'/report.json',JSON.stringify(report,null,2),{mode:0o600});
 await hub.close();server?.closeStreams();await new Promise(resolve=>server?server.close(resolve):resolve());
 console.log(JSON.stringify({report:root+'/report.json',rows:rows.length,error:report.error||null}));
}
if(report.error||rows.some(r=>r.status!=='passed'))process.exitCode=1;
