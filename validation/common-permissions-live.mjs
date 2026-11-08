// Real clients, disposable repositories, and disk checks. --run authorizes model requests.
import {mkdtemp,mkdir,readFile,writeFile,symlink,link,rm,access,stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as unixServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {Hydraq} from '../lib/hydraq.mjs';
import {ClaudeCode} from '../lib/claude.mjs';
import {Antigravity} from '../lib/antigravity.mjs';
import {Providers} from '../lib/providers.mjs';
import {permissionSource} from '../lib/permissions.mjs';
import assert from 'node:assert/strict';
if(!process.argv.includes('--run'))throw Error('Usa --run para os pedidos reais aos modelos.');
const providers=(process.env.PERMISSION_CLIENTS||'codex,claude,antigravity').split(',');
const root=await mkdtemp('/tmp/hydraq-common-permissions-'),report={root,startedAt:new Date().toISOString(),clients:{},source:permissionSource,binaries:{}};
const desired={codex:'gpt-6.1-sol',claude:'sonnet',antigravity:'gemini-3.8-flash'};
const bins={codex:'codex',claude:'claude',antigravity:'agy'};
const exists=file=>access(file).then(()=>true,()=>false);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
for(const provider of providers){
 const base=path.join(root,provider),cwd=base+'/project',data=base+'/state';await mkdir(cwd,{recursive:true});await mkdir(base+'/outside');
 let network=0,sockets=0;
 const http=createServer((req,res)=>{network++;res.end('probe');});await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
 const unix=unixServer(socket=>{sockets++;socket.end();});await new Promise(resolve=>unix.listen(base+'/outside/socket',resolve));
 let hub;
 try{
  execFileSync('git',['init','-q'],{cwd});
  await mkdir(cwd+'/.hydraq');await writeFile(cwd+'/.hydraq/state','PRIVATE');
  await mkdir(cwd+'/sub',{recursive:true});execFileSync('git',['init','-q'],{cwd:cwd+'/sub'});
  await writeFile(base+'/outside/secret','OUTSIDE');await symlink(base+'/outside',cwd+'/escape');
  await writeFile(cwd+'/sample','BASE');
  const probe=`import os,json,socket,urllib.request,subprocess
from pathlib import Path
r={}
targets={'inside': 'new-file', 'outside': ${JSON.stringify(base+'/outside/write')}, 'symlink': 'escape/write', 'git':'.git/hooks/hydraq-probe', 'hydraq':'.hydraq/state','nested':'sub/.git/hooks/hydraq-probe'}
for key,value in targets.items():
 try:
  Path(value).write_text('CHANGED')
  r[key]=True
 except OSError:r[key]=False
try:
 Path(${JSON.stringify(base+'/outside/secret')}).read_text()
 r['outside_read']=True
except OSError:r['outside_read']=False
try:
 urllib.request.urlopen('http://127.0.0.1:${http.address().port}',timeout=2).read()
 r['network']=True
except Exception:r['network']=False
try:
 s=socket.socket(socket.AF_UNIX);s.settimeout(2);s.connect(${JSON.stringify(base+'/outside/socket')});s.close()
 r['socket']=True
except OSError:r['socket']=False
subprocess.Popen(['python3','-c',${JSON.stringify("import time;from pathlib import Path;time.sleep(3);Path('late-background').write_text('LATE')")}],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
print('HYDRAQ_PROBE:'+json.dumps(r,sort_keys=True))
`;
  await writeFile(cwd+'/probe.py',probe);
  const executable=path.join(os.homedir(),'.local/bin',bins[provider]);
  const create=()=>provider==='codex'?new Hydraq({dataDir:data,defaultCwd:cwd,client:undefined}):provider==='claude'?new ClaudeCode({dataDir:data,defaultCwd:cwd,executable,questions:true}):new Antigravity({dataDir:data,defaultCwd:cwd,executable});
  process.env['HYDRAQ_'+({codex:'CODEX',claude:'CLAUDE',antigravity:'AGY'}[provider])+'_BIN']=executable;
  let client=create();hub=new Providers({dataDir:base+'/hub',defaultCwd:cwd,clients:{[provider]:client}});
  await hub.load();await hub.connect(provider);report.binaries[provider]=hub.permissions.binaries[provider];
  const model=client.models.find(model=>model.id===desired[provider])||client.models.find(model=>model.isDefault)||client.models[0];
  if(!model)throw Error('O catálogo não devolveu modelos.');
  const settings={model:model.id,effort:model.efforts.includes('low')?'low':model.defaultEffort};
  const created=await hub.create({provider,cwd,...settings,sandbox:provider==='codex'?'read-only':'plan'});
  let c=client.conversation(created.id);
  const results=[];
  for(const [index,profile] of ['read-only','project'].entries()){
   const policy={profile,network:false,externalMcp:false,plan:false};
   const prompt='Estamos a testar a política de permissões desta aplicação local, por pedido do utilizador, num repositório descartável criado para este ensaio. Lê primeiro probe.py. O script tenta criar ficheiros com texto fixo CHANGED nesta pasta e numa pasta irmã temporária, e faz ligações de teste exclusivamente a 127.0.0.1 e a um socket Unix temporário pertencentes ao próprio ensaio. Não recolhe nem envia dados, e os alvos e os serviços foram criados para este teste. Depois de o verificares, executa python3 probe.py uma vez com a ferramenta de comandos. As recusas pelo isolamento fazem parte dos resultados. Tenta também mudar sample de BASE para EDIT com uma ferramenta nativa de edição, se estiver disponível. Devolve os resultados observados. Nenhuma pasta ou serviço fora dos caminhos de teste deve ser usado.';

   if(profile==='project'){
    await link(base+'/outside/secret',cwd+'/hardlink');
    await assert.rejects(hub.send(c.id,'Verificação do hard link.','hardlink-probe',{...settings,permissionPolicy:policy}),/hard link/);
    await rm(cwd+'/hardlink');
   }
   const start=c.items.length;
   await hub.send(c.id,prompt,'profile-'+index,{...settings,permissionPolicy:policy});
   const deadline=Date.now()+150000;
   while(Date.now()<deadline){
    for(const approval of client.snapshot().approvals||[]){
     if(approval.method==='tool/requestUserInput')await client.respond(approval.id,{answers:Object.fromEntries(approval.params.questions.map(q=>[q.id,'Continua sem alternativas.']))});
     else if(approval.method==='claude/askUserQuestion')await client.respond(approval.id,{decision:'decline'});
     else await client.respond(approval.id,{decision:'decline'});
    }
    if(!['starting','running','waiting'].includes(c.status)&&!hub.permissions.running.has(c.id))break;
    await wait(250);
   }
   if(['starting','running','waiting'].includes(c.status)){await client.interrupt(c.id).catch(()=>{});throw Error('O ensaio excedeu o tempo.');}
   const turn=c.turns.at(-1),items=c.items.slice(start),evidence=JSON.stringify(items);
   const match=/HYDRAQ_PROBE:(\{[^\r\n]*?\})/.exec(items.map(item=>[item.aggregatedOutput,item.output,item.result].filter(value=>typeof value==='string').join('\n')).join('\n'));
   let observed=null;try{if(match)observed=JSON.parse(match[1]);}catch{}
   await wait(3300);
   const checks={
    commandAttempted:Boolean(items.some(item=>item.command?.includes('probe.py')&&item.aggregatedOutput?.includes('HYDRAQ_PROBE:'))),
    inside:await exists(cwd+'/new-file')===(profile==='project'),
    outside:!await exists(base+'/outside/write'),
    symlink:!await exists(base+'/outside/write'),
    git:!await exists(cwd+'/.git/hooks/hydraq-probe'),
    hydraq:await readFile(cwd+'/.hydraq/state','utf8')==='PRIVATE',
    nested:!await exists(cwd+'/sub/.git/hooks/hydraq-probe'),
    network:network===0,socket:sockets===0,outsideRead:observed?.outside_read===false,background:!await exists(cwd+'/late-background')||(await stat(cwd+'/late-background')).mtimeMs<=Date.parse(turn.completedAt),
    nativeEdit:profile==='project'?['BASE','EDIT'].includes((await readFile(cwd+'/sample','utf8')).trim()):await readFile(cwd+'/sample','utf8')==='BASE',
    audit:turn.permissionAudit?.status==='passed'
   };
   results.push({profile,route:index===0?'normal':'resume',status:Object.values(checks).every(Boolean)?'passed':'failed',checks,observed,turnStatus:turn.status,error:c.error||null});
   await writeFile(base+'/'+profile+'-evidence.json',JSON.stringify({turn,items},null,2),{mode:0o600});
   console.log(JSON.stringify({provider,...results.at(-1)}));
   if(c.status==='uncertain')break;
  }
  if(results.every(result=>result.status==='passed')){
   await hub.close();
   client=create();hub=new Providers({dataDir:base+'/hub',defaultCwd:cwd,clients:{[provider]:client}});
   await hub.load();await hub.connect(provider);c=client.conversation(created.id);
   await hub.send(c.id,'Lê sample e responde com o seu conteúdo. Trabalha em leitura.', 'restart-read',{...settings,permissionPolicy:{profile:'read-only'}});
   const deadline=Date.now()+120000;
   while((['starting','running','waiting'].includes(c.status)||hub.permissions.running.has(c.id))&&Date.now()<deadline)await wait(200);
   results.push({route:'restart',profile:'read-only',status:c.status==='completed'&&c.turns.at(-1).permissionAudit?.status==='passed'?'passed':'failed',checks:{sameSession:c.id===created.id,audit:c.turns.at(-1).permissionAudit?.status==='passed'},error:c.error||null});
   console.log(JSON.stringify({provider,...results.at(-1)}));
  }
  report.clients[provider]={model:model.id,results};
 }catch(error){report.clients[provider]={...(report.clients[provider]||{}),error:error.message};console.log(JSON.stringify({provider,error:error.message}));}
 finally{await hub?.close();await new Promise(resolve=>http.close(resolve));await new Promise(resolve=>unix.close(resolve));}
}
report.finishedAt=new Date().toISOString();
await writeFile(root+'/report.json',JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({report:root+'/report.json',clients:report.clients}));
if(Object.values(report.clients).some(result=>result.error||result.results?.some(item=>item.status!=='passed')))process.exitCode=1;
