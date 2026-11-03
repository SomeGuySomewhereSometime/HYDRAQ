import {mkdir,writeFile,rename,readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
/** Store a faithful private Markdown copy. Native paths are metadata, never arbitrary file reads. */
export class CursorPlanFiles {
 constructor(directory){this.directory=path.join(directory,'plan-files');this.queue=Promise.resolve();}
 file(id){if(!uuid(id))throw Error('Identificador de plano inválido.');return path.join(this.directory,id+'.md');}
 save(document){
  const {id,text}=document,file=this.file(id);
  const task=this.queue.then(async()=>{
   await mkdir(this.directory,{recursive:true,mode:0o700});
   const directory=await lstat(this.directory);if(!directory.isDirectory()||directory.isSymbolicLink())throw Error('Pasta dos planos inválida.');
   for(const candidate of [file,file+'.tmp']){try{if((await lstat(candidate)).isSymbolicLink())throw Error('Ficheiro de plano inválido.');}catch(error){if(error.code!=='ENOENT')throw error;}}
   await writeFile(file+'.tmp',text,{mode:0o600});await rename(file+'.tmp',file);
  });this.queue=task.catch(()=>{});return task;
 }
 async read(id){await this.queue;const file=this.file(id),directory=await lstat(this.directory),info=await lstat(file);if(directory.isSymbolicLink()||!directory.isDirectory()||!info.isFile()||info.isSymbolicLink())throw Error('Ficheiro de plano inválido.');return {text:await readFile(file,'utf8'),path:file};}
}
