import {mkdir,readdir,lstat,realpath,readlink,open,statfs,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import path from 'node:path';
import {prepareVersion} from './hydra-workspace.mjs';
import {removePrivate} from './hydra-validation.mjs';

export const writersOf=r=>r.writers||[r.author];
export const writerOf=r=>r.workflow?.writer||r.author;
export function implementationPlan(r,value){
 const allowed=writersOf(r);if(value===undefined)return {steps:[{id:randomUUID(),role:allowed.includes(r.author)?r.author:allowed[0],instructions:'Implementar o plano aprovado.'}],fixer:allowed.includes(r.author)?r.author:allowed[0]};
 if(!value||!Array.isArray(value.steps)||!value.steps.length||value.steps.length>12||!allowed.includes(value.fixer))throw Error('Distribuição inválida: indica 1–12 etapas e um responsável pelas correções autorizado.');
 return {steps:value.steps.map(s=>{if(!s||!allowed.includes(s.role)||typeof s.instructions!=='string'||!s.instructions.trim()||s.instructions.length>4000)throw Error('Cada etapa requer um executor autorizado e instruções até 4000 caracteres.');return {id:randomUUID(),role:s.role,instructions:s.instructions.trim()};}),fixer:value.fixer};
}
// Content and links, including dependencies and ignored files. Copied files have independent inodes.
export async function stageManifest(root){
 root=await realpath(root);const entries={},walk=async relative=>{
  const folder=path.join(root,relative),actual=await realpath(folder);if(actual!==root&&!actual.startsWith(root+path.sep))throw Error('Uma pasta mudou para uma ligação durante o congelamento.');
  for(const e of (await readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   const file=path.join(relative,e.name),full=path.join(root,file),st=await lstat(full),mode=st.mode&0o777;
   if(st.isSymbolicLink())entries[file]=mode+':link:'+await readlink(full);
   else if(st.isDirectory()){entries[file]=mode+':dir';await walk(file);}
   else if(st.isFile()){
    const handle=await open(full,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256');
    try{const before=await handle.stat();if(!before.isFile())throw Error('Ficheiro mudou durante o congelamento.');for await(const bytes of handle.createReadStream({autoClose:false}))hash.update(bytes);const after=await handle.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('Ficheiro mudou durante o congelamento.');}finally{await handle.close();}
    const parent=await realpath(path.dirname(full));if(parent!==root&&!parent.startsWith(root+path.sep))throw Error('Uma pasta mudou durante o congelamento.');entries[file]=mode+':file:'+hash.digest('hex');
   }
  }
 };await walk('');return {entries,hash:createHash('sha256').update(JSON.stringify(entries)).digest('hex')};
}
async function clone(from,to){
 await mkdir(to,{recursive:true,mode:0o700});
 await new Promise((resolve,reject)=>execFile('rsync',['-a','--no-specials','--no-devices',from+'/',to+'/'],{maxBuffer:65536},(error,_stdout,stderr)=>error?reject(Error('A cópia da etapa ficou incompleta: '+stderr.slice(-300))):resolve()));
}
/** No actor receives the sealed folder. Old actors keep only their old writable path. */
export async function sealStage(workspace){
 const source=workspace.copy,folder=path.join(workspace.folder,'stages',randomUUID()),sealed=path.join(folder,'sealed'),next=path.join(folder,'project');
 await mkdir(folder,{recursive:true,mode:0o700});
 try{
  let bytes=0;const count=async dir=>{for(const e of await readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())await count(f);else if(e.isFile())bytes+=(await lstat(f)).size;}};await count(source);
  const space=await statfs(folder);if(Number(space.bavail)*Number(space.bsize)<bytes*2+100e6)throw Error('Não há espaço para congelar e preparar a etapa seguinte.');
  const before=await stageManifest(source);await clone(source,sealed);const frozen=await stageManifest(sealed),after=await stageManifest(source);
  if(before.hash!==after.hash||before.hash!==frozen.hash)throw Error('A etapa mudou enquanto era congelada; a passagem foi recusada.');
  await clone(sealed,next);if((await stageManifest(next)).hash!==frozen.hash)throw Error('A etapa seguinte não corresponde ao resultado congelado.');
  const previous=[...new Set([source,...(workspace.stages||[]).map(s=>s.source),workspace.origin])];
  const prepared=await prepareVersion({workspace:{...workspace,copy:next},fromCopies:previous,target:next,allFiles:true});
  if(prepared.problems.length)throw Error('Estes ficheiros conservam caminhos de etapas antigas e precisam de ser regenerados: '+prepared.problems.slice(0,10).join(', '));
  const ready=await stageManifest(next);await writeFile(folder+'/sealed.json',JSON.stringify({source,hash:frozen.hash,nextHash:ready.hash,rewritten:prepared.rewritten}),{mode:0o600});
  return {folder,source,sealed,copy:next,hash:frozen.hash,nextHash:ready.hash,at:new Date().toISOString()};
 }catch(e){await removePrivate(folder).catch(()=>{});throw e;}
}
