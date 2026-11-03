// Runs inside bwrap with only the project and the journal writable. Prints one line of JSON with the result.
import {access,chmod,constants,copyFile,link,lstat,lutimes,mkdir,open,readFile,readlink,rename,rm,rmdir,symlink,unlink,utimes,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {reached,safeParents,sign,syncFolder} from './hydra-workspace.mjs';

const [,,planFile,mode]=process.argv,plan=JSON.parse(await readFile(planFile,'utf8')),root=plan.root;
// Only for the tests: stops or waits at a chosen point of a chosen pass, as a shutdown or another program would.
const env=process.env,testMode=env.HYDRAQ_APPLY_STOP_MODE||'forward',stopAfter=env.HYDRAQ_APPLY_STOP_AFTER===undefined?null:Number(env.HYDRAQ_APPLY_STOP_AFTER),stopAt=env.HYDRAQ_APPLY_STOP_AT||null,holdAt=env.HYDRAQ_APPLY_HOLD_AT||null;
let written=0,held=false;
const report=value=>{console.log(JSON.stringify(value));process.exit(0);};
const stop=(file,reason,kept)=>report({ok:false,kind:'conflict',file,reason,...(kept?{kept}:{})});
const point=async name=>{
 if(mode!==testMode)return;
 if(stopAt===name&&written>=(stopAfter??0))process.exit(77);
 if(holdAt===name&&!held){
  held=true;const folder=path.dirname(planFile);await writeFile(path.join(folder,'parado'),'');
  for(const end=Date.now()+30000;Date.now()<end;await new Promise(r=>setTimeout(r,10)))if(await access(path.join(folder,'continua')).then(()=>true,()=>false))return;
 }
};
const syncFile=async file=>{const handle=await open(file,'r+');try{await handle.sync();}finally{await handle.close();}};
// Names with this run's token are ours alone: no file of the project can be taken for them.
const temporary=(file,index)=>path.join(path.dirname(path.join(root,file)),`.hydraq-aplicar-${plan.token}-${index}`);
// New plans keep these at the project's root, on its filesystem: removing a parent folder must not remove the
// last name of an inode an editor still has open. Old journals retain their original locations for recovery.
const asideOf=(file,index)=>plan.rootAsides?path.join(root,`.hydraq-aplicar-${plan.token}-${index}-antes`):temporary(file,index)+'-antes';
const tidy=async file=>{for(let folder=path.dirname(file);folder!=='.';folder=path.dirname(folder))try{await rmdir(path.join(root,folder));await syncFolder(path.dirname(path.join(root,folder)));}catch{return;}};
const present=file=>lstat(file).then(()=>true,()=>false);
// Its folder may meanwhile have turned into a file, which is one more way of it not being there.
const discard=file=>rm(file,{force:true}).catch(error=>{if(error.code!=='ENOTDIR')throw error;});
/** Puts back what was moved aside. `link` never replaces: if something took its place meanwhile, both stay. */
async function restore(aside,target){
 try{await link(aside,target);}catch(error){if(error.code==='EEXIST')return false;throw error;}
 await unlink(aside);await syncFolder(path.dirname(target));
 if(path.dirname(aside)!==path.dirname(target))await syncFolder(path.dirname(aside));
 return true;
}
/** Moves from what the plan expects to what it wants. What is at the destination at that very instant goes aside whole, and is only
 *  then compared: an edit made at any moment before this is never overwritten, and a new file is never replaced. */
async function swap(index,file,expected,wanted,source){
 const target=path.join(root,file),temp=temporary(file,index),aside=asideOf(file,index);
 if(wanted!==null){
  await mkdir(path.dirname(target),{recursive:true});
  await discard(temp);
  const info=await lstat(source);
  if(info.isSymbolicLink()){await symlink(await readlink(source),temp);await lutimes(temp,info.atime,info.mtime);}
  else{await copyFile(source,temp,constants.COPYFILE_EXCL);await chmod(temp,info.mode&0o777);await utimes(temp,info.atime,info.mtime);await syncFile(temp);}
  if(await sign(temp)!==wanted){await discard(temp);stop(file,'O ficheiro preparado não é o que foi testado: '+file+'.');}
  await syncFolder(path.dirname(target));
 }
 await point('temporary');
 if(expected!==null&&expected!=='folder'){
  try{await rename(target,aside);}catch(error){
   if(error.code!=='ENOENT')throw error;
   await discard(temp);stop(file,'O ficheiro desapareceu durante a aplicação: '+file+'.');
  }
  await syncFolder(path.dirname(target));
  if(path.dirname(aside)!==path.dirname(target))await syncFolder(path.dirname(aside));
  await point('aside');
  const found=await sign(aside);
  if(found!==expected){
   await discard(temp);
   const back=await restore(aside,target);
   stop(file,'O ficheiro mudou durante a aplicação e não foi substituído: '+file+'.',back?undefined:aside);
  }
 }
 // A removal ends here: its folder may have to give way to a file.
 if(wanted===null){
  if(mode==='forward')await tidy(file);
  return;
 }
 // A folder that is to give way, empty by now. If it is not, the link below refuses and nothing is lost.
 if((await lstat(target).catch(()=>null))?.isDirectory())await rmdir(target).catch(()=>{});
 try{await link(temp,target);}catch(error){
  await discard(temp);
  if(!['EEXIST','EISDIR','ENOTEMPTY'].includes(error.code))throw error;
  const kept=await present(aside)?aside:undefined;
  stop(file,'Apareceu aqui um ficheiro durante a aplicação, e foi mantido: '+file+'.',kept);
 }
 await point('linked');
 await unlink(temp);await syncFolder(path.dirname(target));
}
/** What was set aside stays until the end of the pass: a program still writing to it through an open file shows up here. */
async function closePass(entries){
 for(const {index,file,expected} of entries){
  const aside=asideOf(file,index);
  if(!await present(aside))continue;
  if(await sign(aside)!==expected)stop(file,'O ficheiro antigo mudou enquanto era substituído: '+file+'. Ficou guardado.',aside);
  await unlink(aside);await syncFolder(path.dirname(aside));
 }
}
try{
 if(mode==='settle'){
  // Whatever a stop left half-done. Nothing here decides anything: a file set aside goes back, or stays if it is not what was expected.
  const kept=[];
  for(const [index,{file,before,after}] of plan.changes.entries()){
   if(!await safeParents(root,file))continue;
   await discard(temporary(file,index));
   const aside=asideOf(file,index),target=path.join(root,file);
   if(!await present(aside))continue;
   const found=await sign(aside);
   if(found!==before&&found!==after){kept.push({file,aside});continue;}
   // With a removal (in either direction), absence is already a planned outcome. Its parent may now be a file.
   // The journal holds the fixed sources needed to undo it; do not try to restore a child through that parent.
   if(!await present(target)&&before!==null&&after!==null&&before!=='folder'){
    if(!await restore(aside,target))kept.push({file,aside});continue;
   }
   // Both a pass forward and one back set aside only what they expected to find.
   await unlink(aside);await syncFolder(path.dirname(aside));
  }
  report({ok:true,kept});
 }
 if(mode==='forward'){
  const touched=[];
  for(const [index,change] of plan.changes.entries()){
   const {file,before,after,source}=change;
   if(!await safeParents(root,file))stop(file,'Uma pasta do caminho passou a ser uma ligação: '+file+'.');
   const now=await sign(path.join(root,file));
   if(reached(now,after))continue;
   if(now!==before&&!(before==='folder'&&now===null))stop(file,'O ficheiro mudou durante a aplicação: '+file+'.');
   if(!stopAt&&stopAfter!==null&&mode===testMode&&written>=stopAfter)process.exit(77);
   await swap(index,file,now===null?null:before,after,source);
   touched.push({index,file,expected:before});written++;
  }
  await closePass(touched);
 }
 else if(mode==='rollback'){
  const touched=[];
  for(const [index,change] of [...plan.changes.entries()].reverse()){
   const {file,before,after,keep}=change,target=path.join(root,file);
   if(!await safeParents(root,file))stop(file,'Uma pasta do caminho passou a ser uma ligação: '+file+'.');
   const now=await sign(target);
   if(now===before||(before==='folder'&&now===null))continue;
   if(!reached(now,after))stop(file,'O ficheiro mudou: '+file+'.');
   if(!stopAt&&stopAfter!==null&&mode===testMode&&written>=stopAfter)process.exit(77);
   if(now==='folder')await rmdir(target);
   const had=now==='folder'?null:now;
   if(keep)await swap(index,file,had,before,keep);else if(had!==null)await swap(index,file,had,null,null);
   touched.push({index,file,expected:had});written++;
  }
  await closePass(touched);
  // Only the folders this plan created: an empty folder of the user's stays.
  for(const folder of [...plan.created].sort((a,b)=>b.length-a.length))await rmdir(path.join(root,folder)).catch(()=>{});
 }
 report({ok:true});
}catch(error){report({ok:false,kind:'environment',reason:error.message});}
