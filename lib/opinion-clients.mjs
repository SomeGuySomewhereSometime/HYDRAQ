import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {Hydraq} from './hydraq.mjs';
import {CodexClient} from './codex.mjs';
import {ClaudeCode} from './claude.mjs';
import {Antigravity} from './antigravity.mjs';
import {Cursor} from './cursor.mjs';
import {OpenCode} from './opencode.mjs';
import {OpenCodeRuntime} from './opencode-runtime.mjs';

// Plan mode is accepted as non-writing for this feature, per the user's instruction.
export const OPINION_CAPABILITIES=Object.fromEntries(['codex','claude','antigravity','cursor','opencode'].map(provider=>[provider,{available:true,detail:provider==='codex'?'Só leitura nativa':provider==='claude'?'Planear nativo com ferramentas habituais':'Modo Planear nativo'}]));
export const opinionSandbox = job => job.allowWrite === true ? 'workspace-write' : job.provider === 'codex' ? 'read-only' : 'plan';
export async function createOpinionClient({hub,job,directory,cwd,supervisor}) {
 const source=hub.clients[job.provider];if(!source)throw Error('Cliente indisponível.');
 const native=path.join(directory,'native');await mkdir(native,{recursive:true,mode:0o700});let client;
 if(job.provider==='codex'){
  const raw=source.client,wrapped=supervisor.wrap(raw.executable,[...raw.args],job.unit);
  client=new Hydraq({dataDir:native,defaultCwd:cwd,client:new CodexClient({...wrapped,env:raw.env})});
 }else if(job.provider==='claude')client=new ClaudeCode({dataDir:native,defaultCwd:cwd,executable:source.executable,prefixArgs:[...source.prefixArgs],env:source.env});
 else if(job.provider==='antigravity')client=new Antigravity({dataDir:native,defaultCwd:cwd,executable:source.executable,prefixArgs:[...source.prefixArgs],env:source.env,settingsFile:source.settingsFile,hooksFile:source.hooksFile,guardDirectory:source.guardDirectory,guardNode:source.guardNode});
 else if(job.provider==='cursor')client=new Cursor({dataDir:native,defaultCwd:cwd,executable:source.executable,prefixArgs:[...source.prefixArgs],env:source.env,credentialFile:source.credentialFile});
 else if(job.provider==='opencode'){
  const runtime=new OpenCodeRuntime({directory:path.join(native,'private'),executable:source.executable,args:[...source.prefixArgs],env:source.env});
  client=new OpenCode({dataDir:native,defaultCwd:cwd,executable:source.executable,prefixArgs:[...source.prefixArgs],env:source.env,runtime});
 }else throw Error('Cliente de opinião desconhecido.');
 try{
  await client.load();await client.connect();
  if(!['codex','opencode'].includes(job.provider)){const wrapped=supervisor.wrap(client.executable,client.prefixArgs,job.unit);client.executable=wrapped.executable;client.prefixArgs=wrapped.args;}
  return {client,cwd,sandbox:opinionSandbox(job)};
 }catch(error){await client.close().catch(()=>{});throw error;}
}
