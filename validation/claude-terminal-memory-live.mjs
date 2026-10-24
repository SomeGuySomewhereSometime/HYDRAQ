// Two tiny real subscription requests, isolated Claude config/history and HYDRAQ state.
import {mkdtemp,mkdir,copyFile,chmod,writeFile,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {unlinkSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ClaudeCode} from '../lib/claude.mjs';
import {Providers} from '../lib/providers.mjs';
import {createHttpServer} from '../lib/http.mjs';

const directory=await mkdtemp('/tmp/hydraq-claude-mcp-live-'),home=path.join(directory,'claude-home');
await mkdir(home,{mode:0o700});
process.once('exit',()=>{try{unlinkSync(path.join(home,'.credentials.json'));}catch{}});
try{await copyFile(path.join(os.homedir(),'.claude/.credentials.json'),path.join(home,'.credentials.json'));await chmod(path.join(home,'.credentials.json'),0o600);}catch(error){throw Error('Não foi possível preparar autenticação Claude isolada: '+error.code);}
// A refresh inside the copy could rotate the person's own token: only run with a comfortably valid one.
{const expires=JSON.parse(readFileSync(path.join(home,'.credentials.json'),'utf8')).claudeAiOauth?.expiresAt;if(!(expires>Date.now()+30*60*1000))throw Error('O token Claude expira em menos de 30 minutos; tenta depois de o renovar no cliente normal.');}
const claude=new ClaudeCode({dataDir:directory+'/state/claude',defaultCwd:directory,env:{...process.env,CLAUDE_CONFIG_DIR:home}});
claude.settingsArgs=()=>['--settings',JSON.stringify({disableAllHooks:true,crossSessionInbound:'refuse'})];
const hub=new Providers({dataDir:directory+'/state',defaultCwd:directory,clients:{claude},git:async()=>null});
await hub.load();const server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const result={directory,mode:'original-cli-resume-print-not-interactive-tui'};
try{
 await hub.connect('claude');
 const project=await hub.createProject({name:'Memória terminal isolada',root:directory,revision:0});
 await hub.context.save(project.id,{revision:0,text:'O marcador de validação deste projeto é CLAUDE_MCP_7319.'});
 const chat=await hub.create({provider:'claude',projectId:project.id,revision:hub.projects.data.revision,model:'haiku',effort:'low',sandbox:'plan'}),c=claude.conversation(chat.id);
 await hub.send(c.id,'Responde apenas SEED_OK. Não uses ferramentas nem alteres ficheiros.','seed');
 const deadline=Date.now()+90000;while(['starting','running','waiting'].includes(c.status)){if(Date.now()>deadline)throw Error('Seed timeout');await new Promise(r=>setTimeout(r,100));}
 if(c.status!=='completed')throw Error(c.error||c.status);result.seed=c.messages.at(-1)?.text;
 await hub.claudeTerminal.open(c.id,{launch:false});
 // Only the authorization the delivered command carries: no extra --allowedTools here.
 const args=[...await hub.claudeTerminal.argv(c),'-p','--output-format','json','--max-turns','4','--settings',JSON.stringify({disableAllHooks:true,crossSessionInbound:'refuse'}),'--disallowedTools','Write','Edit','Bash','Agent','--','Consulta get_project_memory no MCP HYDRAQ deste projeto e responde apenas com o marcador que lá encontrares. Não uses outras ferramentas nem alteres ficheiros.'];
 const child=spawn(claude.executable,args,{env:claude.env,cwd:directory,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 const timer=setTimeout(()=>child.kill('SIGTERM'),90000);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});clearTimeout(timer);
 await writeFile(directory+'/native-result.json',stdout,{mode:0o600});
 if(code!==0)throw Error('Claude original terminou com código '+code+'; stderr '+stderr.slice(-500));
 const response=JSON.parse(stdout);result.nativeResult=response.result;result.nativeSession=response.session_id;result.sameSession=response.session_id===c.threadId;result.pendingReads=c.terminal.contextReads?.length||0;
 const imported=await hub.claudeTerminal.release(c.id);result.imported=imported.imported;result.attachedReads=c.turns.filter(t=>t.source==='terminal').flatMap(t=>t.contextReads||[]).length;result.unattributedReads=c.unattributedContextReads?.length||0;
 result.ok=result.sameSession&&result.nativeResult?.includes('CLAUDE_MCP_7319')&&result.pendingReads>0&&result.imported>0;
 if(!result.ok)process.exitCode=1;
}catch(error){result.error=error.message;process.exitCode=1;}
finally{server.closeStreams();server.close();await hub.close();await unlink(path.join(home,'.credentials.json')).catch(()=>{});await writeFile(directory+'/result.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));}
