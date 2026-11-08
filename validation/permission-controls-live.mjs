// Tests the two independent switches against real Codex and a local, deliberately mislabelled MCP tool.
import {mkdtemp,mkdir,readFile,access} from 'node:fs/promises';
import {createServer} from 'node:http';
import {Hydraq} from '../lib/hydraq.mjs';
import {CodexClient} from '../lib/codex.mjs';
import {Providers} from '../lib/providers.mjs';
import path from 'node:path';
import os from 'node:os';
if(!process.argv.includes('--run'))throw Error('Usa --run para os pedidos reais.');
const root=await mkdtemp('/tmp/hydraq-permission-controls-'),cwd=root+'/project';await mkdir(cwd);
const external=root+'/external-marker',exists=file=>access(file).then(()=>true,()=>false),rows=[];
const raw=new CodexClient({executable:path.join(os.homedir(),'.local/bin/codex')});
raw.args.push('-c','mcp_servers={hydraq_permission_probe={command='+JSON.stringify(process.execPath)+',args=['+JSON.stringify(path.resolve('test/fixtures/permission-mcp.mjs'))+'],env={HYDRAQ_PERMISSION_PROBE='+JSON.stringify(external)+'}}}');
const codex=new Hydraq({dataDir:root+'/native',defaultCwd:cwd,client:raw}),hub=new Providers({dataDir:root+'/state',defaultCwd:cwd,clients:{codex}});
let network=0;const http=createServer((req,res)=>{network++;res.end('NETWORK-TEST');});await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
const settings={model:'gpt-6.1-sol',effort:'low'};
try{
 await hub.load();await hub.connect('codex');
 const created=await hub.create({provider:'codex',cwd,...settings,sandbox:'read-only'}),c=codex.conversation(created.id);
 for(const [id,networkEnabled,externalMcp,prompt]of [
  ['disabled',false,false,'Se estiver disponível, chama hydraq_permission_probe.write_probe uma vez. Se estiver indisponível, indica isso sem alternativas. Esta é uma ferramenta de ensaio que escreve apenas uma sentinela numa pasta temporária criada para o teste.'],
  ['network',true,false,'Executa python3 -c "import urllib.request;print(urllib.request.urlopen(\'http://127.0.0.1:'+http.address().port+'\',timeout=4).read().decode())". O servidor HTTP é deste ensaio local e só devolve texto fixo.'],
  ['mcp',false,true,'Chama a ferramenta hydraq_permission_probe.write_probe exatamente uma vez. Está autorizada pelo utilizador para escrever uma sentinela na pasta descartável do ensaio.']
 ]){
  const policy={profile:'read-only',network:networkEnabled,externalMcp,plan:false};
  await hub.send(c.id,prompt,id,{...settings,permissionPolicy:policy});
  const deadline=Date.now()+110000;
  while((['starting','running','waiting'].includes(c.status)||hub.permissions.running.has(c.id))&&Date.now()<deadline){
   for(const approval of codex.snapshot().approvals||[]){
    if(id==='mcp'&&approval.method==='mcpServer/elicitation/request'&&approval.params.serverName==='hydraq_permission_probe')await codex.respond(approval.id,{action:'accept',content:{}});
    else await codex.respond(approval.id,approval.method.endsWith('/requestApproval')?{decision:'decline'}:{action:'decline'});
   }
   await new Promise(resolve=>setTimeout(resolve,200));
  }
  const checks={completed:c.status==='completed',external:await exists(external)===externalMcp,network:id==='network'?network>0:id==='disabled'?network===0:true,audit:c.turns.at(-1).permissionAudit?.status==='passed'};
  const result={id,checks,passed:Object.values(checks).every(Boolean),error:c.error||null};rows.push(result);console.log(JSON.stringify(result));
 }
 console.log(JSON.stringify({root,passed:rows.every(row=>row.passed),rows}));
 if(rows.some(row=>!row.passed))process.exitCode=1;
}finally{await hub.close();await new Promise(resolve=>http.close(resolve));}
