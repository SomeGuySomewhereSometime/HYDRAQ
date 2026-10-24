import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile,unlink,lstat,rename,open} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {groupOf} from './handoff.mjs';
import {processIdentity,sameProcess} from './process-owner.mjs';

const busy=new Set(['starting','running','waiting','uncertain']);
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
export class OpenCodeTerminal {
  constructor(hub){this.hub=hub;this.pending=new Set();}
  get client(){return this.hub.clients.opencode;}
  terminals(){return this.client?.conversations.filter(c=>c.terminal)||[];}
  snapshot(){return {available:Boolean(this.client?.sync)&&process.platform==='linux',pending:[...this.pending]};}
  scopes(){return this.terminals().map(c=>({...this.hub.scopeFor(c,'opencode'),kind:'terminal',reason:'OpenCode original no terminal'}));}
  assertControl(id){const c=this.hub.conversations().find(c=>c.id===id);if(c&&this.terminals().some(t=>groupOf(t)===groupOf(c)))throw Object.assign(Error('Esta conversa está no OpenCode original. Fecha o terminal e usa «Continuar na HYDRAQ».'),{status:409});}
  changed(){this.hub.emit('state',this.hub.snapshot());}
  async lock(c){
    try{const value=JSON.parse(await readFile(c.terminal.file+'.lock','utf8'));return sameProcess(value.pid,value.identity);}
    catch(error){if(error.code==='ENOENT')return false;throw Error('Não foi possível confirmar que o terminal OpenCode está fechado.');}
  }
  async info(c){
    if(await this.lock(c))return {conversationId:c.id,warning:'O terminal OpenCode já está aberto.'};
    const nativeEnv=await this.client.runtime.terminalEnvironment();
    const env=Object.fromEntries(Object.entries(nativeEnv).filter(([name])=>/^(?:PATH|HOME|USER|LOGNAME|LANG|LC_\w+|TZ|SHELL|TMPDIR|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME|OPENCODE_DB|OPENCODE_SERVER_PASSWORD|OPENCODE_DISABLE_FREE_MODELS)$/.test(name)));
    // Password is inherited by the CLI through this private file, never included in argv or snapshots.
    const temp=c.terminal.file+'.'+randomUUID()+'.tmp';
    try{await writeFile(temp,JSON.stringify({leaseId:c.terminal.leaseId,ownerPid:process.pid,ownerIdentity:processIdentity(),executable:this.client.executable,args:[...this.client.prefixArgs,'--server',this.client.runtime.url,'--session',c.threadId,c.cwd],cwd:c.cwd,env}),{mode:0o600,flag:'wx'});await rename(temp,c.terminal.file);}finally{await unlink(temp).catch(()=>{});}
    const helper=fileURLToPath(new URL('./opencode-terminal-launch.mjs',import.meta.url));
    return {conversationId:c.id,command:[process.execPath,helper,c.terminal.file].map(quote).join(' ')};
  }
  async open(id,{launch=true}={}){
    if(this.hub.closing)throw Error('A HYDRAQ está a encerrar.');
    const client=this.client,c=client.conversation(id);
    if(c.terminal)return this.info(c);
    if(this.pending.has(id))throw Error('A passagem já está a ser preparada.');
    this.hub.nativeSessions.assertControl(id);this.hub.assertTerminal?.(id);
    if(!c.threadId||busy.has(c.status))throw Error('Conclui primeiro um pedido nesta conversa OpenCode.');
    const key='opencode-terminal:'+id,scope=this.hub.scopeFor(c,'opencode');this.hub.assertFree(scope);
    this.pending.add(id);this.hub.reservations.set(key,{...scope,reason:'A preparar OpenCode original'});this.changed();
    try{
      await this.hub.projects.assertUsable(groupOf(c),this.hub.conversations().filter(m=>groupOf(m)===groupOf(c)));
      await client.refreshModels(c.cwd,{force:true});await client.sync(c);
      if(busy.has(c.status)||client.approvals.size)throw Error('A sessão OpenCode ainda tem trabalho ou decisões pendentes.');
      const context=await this.hub.contextMcp.issue(c);await client.prepare(c,c,context);
      c.terminal={leaseId:randomUUID(),sessionId:c.threadId,since:new Date().toISOString(),mcpProjectId:this.hub.projects.group(groupOf(c))?.projectId||null,file:path.join(client.runtime.directory,'terminal-'+c.id+'.json')};
      let info;
      try{info=await this.info(c);await client.persist();}catch(error){delete c.terminal;throw error;}
      client.recount();client.changed();
      if(launch){
        try{const child=spawn('x-terminal-emulator',['-e',process.execPath,fileURLToPath(new URL('./opencode-terminal-launch.mjs',import.meta.url)),c.terminal.file],{cwd:c.cwd,stdio:'ignore',detached:true});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();}
        catch{info.warning='Não foi possível abrir uma janela. Copia o comando para o teu terminal.';}
      }
      return info;
    }finally{this.pending.delete(id);this.hub.reservations.delete(key);this.changed();}
  }
  async release(id){
    const c=this.client.conversation(id);if(!c.terminal)return {released:true};
    if(await this.lock(c))throw Error('Fecha primeiro o OpenCode no terminal.');
    // Lock the admission gate while revoking the manual command, including a concurrent launcher.
    let owned=false;
    try{const gate=await open(c.terminal.file+'.lock','wx',0o600);owned=true;await gate.writeFile(JSON.stringify({pid:process.pid,identity:processIdentity()}));await gate.close();}
    catch(error){if(error.code!=='EEXIST')throw error;if(await this.lock(c))throw Error('Fecha primeiro o OpenCode no terminal.');}
    c.terminal.returning=true;
    try{
      await this.hub.contextMcp.drain(c.id);await this.client.sync(c);
      if(busy.has(c.status)||[...this.client.approvals.values()].some(a=>a.conversationId===id))throw Error('O OpenCode ainda tem trabalho ou decisões pendentes.');
      const file=c.terminal.file,reads=c.terminal.contextReads||[];
      if(reads.length)(c.unattributedContextReads||=[]).push(...reads.map(r=>({...r,attribution:'unattributed',reason:'Consulta no terminal OpenCode; pedido não associado.'})));
      // Revoke the command before releasing the reservation; a stale copy cannot reopen the session.
      await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
      await unlink(file+'.lock').catch(error=>{if(error.code!=='ENOENT')throw error;});
      delete c.terminal;this.hub.contextMcp.resumeExpiry(c.id);this.client.recount();await this.client.persist();this.client.changed();return {released:true};
    }catch(error){if(c.terminal){delete c.terminal.returning;if(owned)await unlink(c.terminal.file+'.lock').catch(()=>{});}throw error;}
  }
}
