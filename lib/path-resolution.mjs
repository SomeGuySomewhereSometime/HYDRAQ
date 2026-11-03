import {lstat,readlink} from 'node:fs/promises';
import path from 'node:path';

/** Resolves links component by component, retaining a missing tail. In particular, link/.. means the parent of the
 *  link's target, not the parent of the link. onLink also records aliases whose eventual target does not exist yet. */
export async function resolveNamedPath(target,base=process.cwd(),onLink=null,onStep=null){
 const absolute=path.isAbsolute(target)?target:base+path.sep+target;
 let current=path.parse(absolute).root,pending=absolute.slice(current.length).split(path.sep),links=0;
 while(pending.length){
  const part=pending.shift();
  if(!part||part==='.')continue;
  if(part==='..'){current=path.dirname(current);continue;}
  const next=path.join(current,part);await onStep?.(next);
  // Any of these just means nothing is there to follow. A value of the Git configuration need not even look like a path.
  const info=await lstat(next).catch(error=>{if(['ENOENT','ENOTDIR','ENAMETOOLONG','EACCES'].includes(error.code))return null;throw error;});
  if(info?.isSymbolicLink()){
   if(++links>40)throw Object.assign(Error('A ligação é circular ou tem demasiados passos: '+next),{code:'ELOOP'});
   await onLink?.(next);
   const value=await readlink(next).catch(()=>null);
   if(value===null){current=next;continue;}
   if(path.isAbsolute(value))current=path.parse(value).root;
   pending=value.split(path.sep).concat(pending);
  }else current=next;
 }
 return current;
}
