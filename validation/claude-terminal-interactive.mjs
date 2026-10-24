// Isolated HYDRAQ (Claude only) for the interactive terminal check driven by claude-terminal-interactive.py.
// First run: project, memory, one real seed request and the terminal hand-off. Later runs reopen the same
// state, as after a restart, and change the memory marker. Commands on stdin: `release`, `quit`.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {ClaudeCode} from '../lib/claude.mjs';
import {Providers} from '../lib/providers.mjs';
import {createHttpServer} from '../lib/http.mjs';

const [directory,sandbox='workspace-write',marker]=process.argv.slice(2);
if(!directory||!path.isAbsolute(directory)||!marker)throw Error('Uso: node claude-terminal-interactive.mjs <pasta> <workspace-write|plan> <marcador>');
const home=path.join(directory,'claude-home'),project=path.join(directory,'project'),saved=path.join(directory,'conversation.json');
const print=value=>process.stdout.write(JSON.stringify(value)+'\n');
await mkdir(project,{recursive:true});
const claude=new ClaudeCode({dataDir:path.join(directory,'state/claude'),defaultCwd:project,env:{...process.env,CLAUDE_CONFIG_DIR:home}});
const hub=new Providers({dataDir:path.join(directory,'state'),defaultCwd:project,clients:{claude},git:async()=>null});
await hub.load();
const server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let closing=false;
const close=async code=>{if(closing)return;closing=true;server.closeStreams();server.close();await hub.close();process.exit(code);};
process.on('SIGTERM',()=>close(0));
try{
  await hub.connect('claude');await hub.contextMcp.restoring;
  const remember=async projectId=>{const {memory}=await hub.context.view(projectId);await hub.context.save(projectId,{revision:memory.revision,text:`O marcador de validação deste projeto é ${marker}.`});};
  let c;
  try{c=claude.conversation(JSON.parse(await readFile(saved,'utf8')).id);}catch{}
  if(!c){
    const created=await hub.createProject({name:'Terminal interativo isolado',root:project,revision:0});
    await remember(created.id);
    const chat=await hub.create({provider:'claude',projectId:created.id,revision:hub.projects.data.revision,model:'haiku',effort:'low',sandbox});c=claude.conversation(chat.id);
    await hub.send(c.id,'Responde apenas SEED_OK. Não uses ferramentas nem alteres ficheiros.','seed');
    const deadline=Date.now()+120000;while(['starting','running','waiting'].includes(c.status)){if(Date.now()>deadline)throw Error('Seed sem resposta.');await new Promise(r=>setTimeout(r,100));}
    if(c.status!=='completed')throw Error(c.error||c.status);
    await writeFile(saved,JSON.stringify({id:c.id}),{mode:0o600});
    const info=await hub.claudeTerminal.open(c.id,{launch:false});
    print({event:'ready',run:'first',command:info.command,sessionId:c.threadId,server:c.terminal.mcpServer,seed:c.messages.at(-1)?.text});
  }else{
    await remember(hub.projects.group(c.group||c.id).projectId);
    const lease=hub.contextMcp.sessions.get(c.id),stored=lease?JSON.parse(await readFile(lease.file,'utf8')):null;
    print({event:'ready',run:'restart',restored:Boolean(lease&&stored?.token===lease.token),sameFile:lease?.file===hub.contextMcp.leaseFile(c.terminal.mcpProjectId,c.id),terminal:Boolean(c.terminal),pendingReads:c.terminal?.contextReads?.length||0});
  }
  createInterface({input:process.stdin}).on('line',async line=>{
    try{
      if(line==='quit')return close(0);
      if(line!=='release')return;
      const result=await hub.claudeTerminal.release(c.id);
      const turns=c.turns.filter(turn=>turn.source==='terminal');
      print({event:'released',imported:result.imported,warning:result.warning,sessionId:c.threadId,
        turns:turns.map(turn=>({status:turn.status,prompt:c.messages.find(m=>m.turnId===turn.id&&m.role==='user')?.text?.slice(0,120),reads:(turn.contextReads||[]).map(r=>({tool:r.tool,association:r.association,nativeToolCallId:r.nativeToolCallId||null}))})),
        unattributed:(c.unattributedContextReads||[]).map(r=>r.tool),terminalCleared:!c.terminal});
    }catch(error){print({event:'error',message:error.message,code:error.code||null});}
  });
}catch(error){print({event:'error',message:error.message});await close(1);}
