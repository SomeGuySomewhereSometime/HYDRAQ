import {chmod,copyFile,lstat,lutimes,mkdir,open,readFile,readdir,readlink,realpath,rename,rm,statfs,symlink,utimes,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {execFile,spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {certifiedEntries,environmentRecord,gitSafely,isReservedPath,overlaps,removePrivate,reservedChanges,reservedState} from './hydra-validation.mjs';
import {resolveNamedPath} from './path-resolution.mjs';

// A task can work in a private copy of the project, and the project then receives only what was tested. The copy has no
// sockets, no hard links to anything else and its own Git data, so what a program runs there cannot reach the real project.
const WORKER=fileURLToPath(new URL('./hydra-workspace-worker.mjs',import.meta.url));
// Rebuilt by the tools that use them, and often the largest thing in a project. Other caches are copied: tools may need them without a network.
const LEFT_OUT=['/.git','.hydraq','/Library','/Temp'],WORKER_LIMIT=20*60000;
const run=(command,args)=>new Promise(resolve=>execFile(command,args,{maxBuffer:1<<26},(error,stdout,stderr)=>resolve({code:error?(error.code??1):0,stdout,stderr})));
const copyTree=async(from,to,extra=[])=>{
 const result=await run('rsync',['-a','--no-specials','--no-devices',...extra,from+'/',to+'/']);
 // 24: a file vanished while copying. Whatever the user did meanwhile is seen later, by comparing with the state taken before.
 if(result.code===0||result.code===24)return;
 throw Error(result.code==='ENOENT'?'falta o programa rsync.':'a cópia ficou incompleta: '+result.stderr.trim().slice(-300));
};
export const workspaceFolder=(directory,id,project)=>{const own=path.join(directory,'workspaces',id);return overlaps(own,project)?path.join(os.homedir(),'.local','state','hydraq','workspaces',id):own;};
/** Same format as the certified entries, without reading a large file into memory. */
export async function sign(file){
 const info=await lstat(file).catch(()=>null);if(!info)return null;
 const mode=info.mode&0o777;
 if(info.isSymbolicLink())return `${mode}:link:${await readlink(file)}`;
 if(info.isDirectory())return 'folder';
 if(!info.isFile())return 'other';
 const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
 return `${mode}:file:${hash.digest('hex')}`;
}
/** Whether a file is as planned. A file that goes away may have a folder in its place. */
export const reached=(now,after)=>now===after||(after===null&&now==='folder');
/** No folder on the way may be a link: neither Git nor a walk of the project ever gives a path through one. */
export async function safeParents(root,file){
 let current=root;
 for(const part of path.dirname(file).split(path.sep)){
  if(part==='.')continue;
  current=path.join(current,part);
  const info=await lstat(current).catch(()=>null);
  if(!info)return true;
  if(info.isSymbolicLink())return false;
 }
 return true;
}
export async function syncFolder(folder){const handle=await open(folder,'r');try{await handle.sync();}finally{await handle.close();}}
const saveFile=async(file,text)=>{
 const temporary=file+'.'+randomUUID();const handle=await open(temporary,'wx',0o600);
 try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
 await rename(temporary,file);await syncFolder(path.dirname(file));
};
/** Git data of its own: no hooks, a clean configuration that runs nothing, and no pointer to the real folder of a worktree.
 *  History is linked rather than copied, because Git never rewrites those files and the sandboxes keep .git read-only. */
async function privateGit(project,copy){
 const target=path.join(copy,'.git');await rm(target,{recursive:true,force:true});
 if(!await lstat(path.join(project,'.git')).catch(()=>null))return;
 const git=args=>run('git',[...gitSafely,'-C',project,...args]);
 const gitDir=(await git(['rev-parse','--absolute-git-dir'])).stdout.trim(),common=(await git(['rev-parse','--path-format=absolute','--git-common-dir'])).stdout.trim();
 if(!gitDir||!common)return;
 await mkdir(target,{mode:0o700});
 await copyTree(common,target,['--exclude=/hooks','--exclude=/config','--exclude=/config.worktree','--exclude=/worktrees','--exclude=/objects','--exclude=/lfs','--exclude=*.lock','--exclude=/fsmonitor--daemon*']);
 const objects=path.join(common,'objects');
 await copyTree(objects,path.join(target,'objects'),['--link-dest='+objects]).catch(()=>copyTree(objects,path.join(target,'objects')));
 if(gitDir!==common)for(const name of ['HEAD','index','ORIG_HEAD','MERGE_HEAD','CHERRY_PICK_HEAD','REBASE_HEAD'])await copyFile(path.join(gitDir,name),path.join(target,name)).catch(()=>{});
 const keep=(await git(['config','--local','--get-regexp','^(core\\.(repositoryformatversion|filemode|ignorecase|precomposeunicode|sparsecheckout|sparsecheckoutcone)|extensions\\..*)$'])).stdout.split('\n').filter(Boolean).map(line=>{const at=line.indexOf(' ');return at<0?[line,'']:[line.slice(0,at),line.slice(at+1)];}).filter(([key])=>key!=='extensions.worktreeconfig');
 const file=path.join(target,'config'),set=(key,value)=>run('git',['config','--file',file,key,value]);
 await set('core.bare','false');await set('core.checkStat','minimal');await set('core.trustctime','false');await set('core.logAllRefUpdates','false');
 for(const [key,value] of keep)await set(key,value);
}
/** What counts in a folder right now. Nothing in it says what a file was, so both sides are compared with themselves later. */
async function capture(cwd,own){
 const entries=await certifiedEntries(cwd),listing={},record=await environmentRecord(cwd,entries,undefined,listing),inner=own&&path.relative(cwd,own);
 if(inner&&inner!=='..'&&!inner.startsWith('..'+path.sep)&&!path.isAbsolute(inner))for(const map of [entries,listing])for(const file of Object.keys(map))if(file===inner||file.startsWith(inner+path.sep))delete map[file];
 return {entries,listing,...record};
}
const baseFile=folder=>path.join(folder,'base.json');
const readBase=async folder=>JSON.parse(await readFile(baseFile(folder),'utf8'));
const roomFor=async(folder,bytes,what)=>{const info=await statfs(folder);if(Number(info.bavail)*Number(info.bsize)<bytes)throw Error(`não há espaço em disco para ${what}: são precisos ${Math.ceil(bytes/1e6)} MB.`);};
const projectSize=async(project,own)=>{
 let total=0;
 const visit=async folder=>{
  for(const entry of await readdir(folder,{withFileTypes:true}).catch(()=>[])){
   const file=path.join(folder,entry.name);
   if(entry.name==='.hydraq'||(own&&overlaps(file,own)&&file.length>=own.length))continue;
   if(entry.isDirectory()){if(folder===project&&['Library','Temp'].includes(entry.name))continue;await visit(file);}
   else if(entry.isFile())total+=(await lstat(file).catch(()=>({size:0}))).size;
  }
 };
 await visit(project);return total;
};
/** Refuses with a reason rather than leaving a partial copy: there is no fallback to writing in the project. */
export async function createWorkspace({project,folder:wanted,own=null}){
 let folder=wanted;
 try{
  if(overlaps(path.join(folder,'projeto'),project))throw Error('a pasta privada não pode ficar dentro do projeto.');
  await mkdir(folder,{recursive:true,mode:0o700});await chmod(folder,0o700);
  // The real path: the clients run in it, and a command's folder must exist under that name inside the sandbox.
  folder=await realpath(folder);
  const copy=path.join(folder,'projeto');
  if(overlaps(copy,project))throw Error('a pasta privada não pode ficar dentro do projeto.');
  await roomFor(folder,(await projectSize(project,own))*1.1+100e6,'a cópia privada');
  // Taken before copying: an edit made meanwhile then counts as a change to the project, which is the safe side.
  const origin=await capture(project,own),reserved=await reservedState(project,own);
  const inner=own&&path.relative(project,own),leftOut=[...LEFT_OUT,...(inner&&!inner.startsWith('..')&&!path.isAbsolute(inner)?['/'+inner]:[])];
  await mkdir(copy,{mode:0o700});await copyTree(project,copy,leftOut.map(name=>'--exclude='+name));
  await privateGit(project,copy);
  const base={origin,reserved,copy:await capture(copy,null)};
  await saveFile(baseFile(folder),JSON.stringify(base));
  return {mode:'copy',folder,copy,origin:project,createdAt:new Date().toISOString()};
 }catch(error){await removePrivate(folder).catch(()=>{});throw error;}
}
export const removeWorkspace=folder=>removePrivate(folder);
const different=(a,b,skip=new Set())=>[...new Set([...Object.keys(a),...Object.keys(b)])].filter(key=>a[key]!==b[key]&&!skip.has(key));
/** What the project gained or lost since the copy was made, apart from the files in `skip`. */
function edited(base,now,skip){
 return {source:different(base.entries,now.entries,skip),environment:different(base.listing,now.listing,skip)};
}
/** The confined writer. Only the project and the journal are writable, so a folder turned into a link cannot lead the writes out. */
function runWorker(planFile,mode,root,journal,environment={}){
 return new Promise(resolve=>{
  const hidden=['.git','.hydraq'].flatMap(name=>['--ro-bind-try',path.join(root,name),path.join(root,name)]);
  const env=Object.entries(environment).flatMap(([key,value])=>['--setenv',key,String(value)]);
  const child=spawn('bwrap',['--unshare-all','--die-with-parent','--new-session','--ro-bind','/','/','--dev','/dev','--proc','/proc','--bind',root,root,...hidden,'--bind',journal,journal,'--clearenv',...env,'--',process.execPath,WORKER,planFile,mode],{stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);
  // The coordinator waits for this, so it must end: what was written stays recorded in the journal.
  const timer=setTimeout(()=>child.kill('SIGKILL'),WORKER_LIMIT);
  child.once('error',error=>{clearTimeout(timer);resolve({ok:false,kind:'environment',reason:error.message});});
  child.once('close',code=>{
   clearTimeout(timer);
   try{const result=JSON.parse(out.trim().split('\n').at(-1));resolve({...result,code});}
   catch{resolve({ok:false,kind:'environment',code,reason:(err||out).trim().slice(-300)||`código ${code}`});}
  });
 });
}
const journalOf=folder=>{const journal=path.join(folder,'aplicacao');return {journal,planFile:path.join(journal,'plano.json')};};
const clearJournal=async journal=>{await removePrivate(journal);await syncFolder(path.dirname(journal)).catch(()=>{});};
const readPlan=planFile=>readFile(planFile,'utf8').then(JSON.parse,()=>null);
/** What a journal belongs to: the code, the dependencies and the other files of one approved version. */
const versionOf=validated=>[validated.hash,validated.dependencies,validated.other].join(':');
/** Only "not found" says a folder is gone. It may still be a disk that is not connected, so the user decides what it means. */
export const folderGone=folder=>lstat(folder).then(()=>false,error=>error.code==='ENOENT');
/** Whether the project may be half-way through receiving a version. While this holds, nothing that recovery needs can be removed. */
export async function applicationPending(folder,wasPending=false){
 try{await lstat(journalOf(folder).planFile);return true;}
 catch(error){
  // An unreadable journal is not evidence that recovery finished.
  if(error.code!=='ENOENT')return true;
  if(!wasPending)return false;
  // A missing folder may be a disconnected disk or a temporary move. Keep the last known reservation.
  // An accessible folder with no plan also covers a failure before the first write, or a completed undo.
  return lstat(folder).then(info=>!info.isDirectory(),()=>true);
 }
}
/** State of each file the plan touches, as it is now. */
async function planState(root,plan){
 const unsafe=[],foreign=[],applied=[];
 for(const change of plan.changes){
  if(!await safeParents(root,change.file)){unsafe.push(change.file);continue;}
  const now=await sign(path.join(root,change.file));
  if(reached(now,change.after))applied.push(change.file);
  else if(now!==change.before&&!(change.before==='folder'&&now===null))foreign.push(change.file);
 }
 return {unsafe,foreign,applied};
}
const listed=(files,limit=10)=>files.slice(0,limit).join(', ')+(files.length>limit?` e mais ${files.length-limit}`:'');
const keptNote=kept=>kept?.length?' Ficaram guardadas as duas versões; a tua está em '+kept.slice(0,5).map(item=>item.aside||item).join(', ')+'.':'';
/** A failed pass is a conflict only if a file stands in the way. Anything else is the environment, and retrying is safe. */
const passProblem=result=>result.kind==='environment'?{status:'failed',files:[],partial:true,reason:'Não foi possível aplicar: '+result.reason}:{status:'conflict',files:result.file?[result.file]:[],partial:true,kept:result.kept,reason:result.reason+keptNote(result.kept?[result.kept]:[])};
/** Tidies what a stop left half-done, then says whether every file of the plan is where this plan could have put it. */
async function settlePlan(root,plan,planFile,journal,environment){
 const settled=await runWorker(planFile,'settle',root,journal,environment);
 if(!settled.ok)return passProblem(settled);
 if(settled.kept?.length)return {status:'conflict',files:settled.kept.map(item=>item.file),partial:true,kept:settled.kept,reason:'Há ficheiros que mudaram com a aplicação a meio: '+listed(settled.kept.map(item=>item.file))+'.'+keptNote(settled.kept)};
 const {unsafe,foreign}=await planState(root,plan);
 if(unsafe.length)return {status:'conflict',files:unsafe,partial:true,reason:'Uma pasta do caminho passou a ser uma ligação: '+listed(unsafe)+'. A aplicação ficou a meio e não continua até isso ser resolvido.'};
 if(foreign.length)return {status:'conflict',files:foreign,partial:true,reason:'Estes ficheiros mudaram com a aplicação a meio: '+listed(foreign)+'. Repõe-nos para continuar.'};
 // The old locations have now been settled. Subsequent writes, even for an older journal, use the safe root locations.
 if(!plan.rootAsides){plan.rootAsides=true;await saveFile(planFile,JSON.stringify(plan));}
 return null;
}
async function rollback(root,plan,planFile,journal,environment){
 const undone=await runWorker(planFile,'rollback',root,journal,environment);
 if(!undone.ok){const problem=passProblem(undone);return {...problem,reason:'Não foi possível desfazer a aplicação a meio: '+problem.reason};}
 await clearJournal(journal);return null;
}
/** Takes back what a stopped application already wrote, as long as that cannot overwrite anything that changed since. */
export async function undoApplication({workspace,environment={}}){
 const {folder,origin:root}=workspace,{journal,planFile}=journalOf(folder),plan=await readPlan(planFile);
 if(!plan)return {status:'none',files:[]};
 const blocked=await settlePlan(root,plan,planFile,journal,environment);if(blocked)return blocked;
 const failed=await rollback(root,plan,planFile,journal,environment);if(failed)return failed;
 return {status:'undone',files:plan.changes.map(change=>change.file)};
}
async function finish(root,plan,own,base,planFile,journal,environment){
 const result=await runWorker(planFile,'forward',root,journal,environment);
 if(!result.ok)return passProblem(result);
 for(const change of plan.changes)if(!reached(await sign(path.join(root,change.file)),change.after))return {status:'conflict',files:[change.file],partial:true,reason:'O resultado não ficou como foi testado: '+change.file+'.'};
 const skip=new Set(plan.changes.map(change=>change.file)),now=await capture(root,own),late=edited(base.origin,now,skip);
 await clearJournal(journal);
 return {status:'applied',files:plan.allFiles||[...skip],drift:[...late.source,...late.environment].filter(key=>!key.startsWith('\0'))};
}
/** What in these changes Git would use. A reserved link leads somewhere: what is there, also among the changes, is what would run, so it is named too. */
async function reservedFiles(pending,state,copy,root){
 const found=new Set(pending.filter(change=>isReservedPath(change.file,state)).map(change=>change.file)),queue=[...found],byName=new Map(pending.map(change=>[change.file,change]));
 const relative=file=>{const place=[copy,root].find(folder=>file===folder||file.startsWith(folder+path.sep));return place===undefined?null:path.relative(place,file);};
 // Resolve the candidate project, including absolute links already rewritten to the origin. Looking there on disk would
 // see yesterday's links (or no link yet), and lose a remaining suffix such as alias/sub/program behind a new alias.
 const resolveCandidate=async file=>{
  let current=path.parse(copy).root,pendingPath=path.join(copy,file).slice(current.length).split(path.sep),steps=0;const links=[];
  while(pendingPath.length){
   const part=pendingPath.shift();if(!part||part==='.')continue;if(part==='..'){current=path.dirname(current);continue;}
   const next=path.join(current,part),inner=relative(next),change=inner===null?null:byName.get(inner),source=change?.source||(inner===null?next:path.join(copy,inner));
   const info=change?.after===null?null:await lstat(source).catch(error=>{if(['ENOENT','ENOTDIR','ENAMETOOLONG','EACCES'].includes(error.code))return null;throw error;});
   if(!info?.isSymbolicLink()){current=next;continue;}
   if(++steps>40)throw Object.assign(Error('A ligação é circular ou tem demasiados passos: '+next),{code:'ELOOP'});
   if(inner!==null)links.push(inner);
   const value=await readlink(source);if(path.isAbsolute(value))current=path.parse(value).root;
   pendingPath=value.split(path.sep).concat(pendingPath);
  }
  return {target:relative(current),links};
 };
 while(queue.length){
  const file=queue.pop();
  if(!byName.get(file)?.after?.includes(':link:'))continue;
  const resolved=await resolveCandidate(file).catch(()=>null);if(!resolved)continue;
  const {target,links}=resolved;
  for(const {file:other} of pending)if(!found.has(other)&&(links.includes(other)||(target!==null&&(other===target||!target||other.startsWith(target+path.sep))))){found.add(other);queue.push(other);}
 }
 return found;
}
/** Brings to the project what was tested. Every path through here looks at the project as it is now: a journal says what was planned, not what still holds.
 *  `validated` is the frozen version the reviews approved. `accepted` is what the user confirmed after a "reserved" answer: each file with the exact
 *  result confirmed, so it says nothing about a later change to the same path. */
export async function applyWorkspace({workspace,validated,own=null,accepted={},environment={},strict=false}){
 const {folder,copy,origin:root}=workspace,base=await readBase(folder),{journal,planFile}=journalOf(folder),known=await readPlan(planFile),version=versionOf(validated);
 // A returned conversation cannot re-enter the review cycle: manual delivery only accepts the unchanged project.
 if(strict){
  if(known)return {status:'conflict',files:[],partial:true,reason:'Há uma aplicação por concluir. Desfaz primeiro antes de aplicar a cópia guardada.'};
  const current=await capture(root,own),editedHere=edited(base.origin,current,new Set());
  if(editedHere.source.length||editedHere.environment.length)return {status:'conflict',files:[...new Set([...editedHere.source,...editedHere.environment])].filter(file=>!file.startsWith('\0')),reason:'O projeto mudou desde a versão testada. Nada foi escrito; inicia uma nova tarefa para rever e testar a junção.'};
 }
 if(known){
  const blocked=await settlePlan(root,known,planFile,journal,environment);if(blocked)return blocked;
  // A journal only ever finishes the version it was made for: a newer approval starts over from the project as it was.
  let undo=known.version!==version;
  if(!undo){
   const skip=new Set(known.changes.map(change=>change.file)),now=await capture(root,own),late=edited(base.origin,now,skip),state=await reservedState(root,own);
   const moved=reservedChanges(base.reserved,state).filter(key=>!skip.has(key)&&accepted[key]!==(state[key]??null));
   // The rest of the project moved during the interruption, so finishing would give a version nobody tested.
   undo=late.source.length>0||late.environment.length>0||moved.length>0;
   if(!undo)return finish(root,known,own,base,planFile,journal,environment);
  }
  const failed=await rollback(root,known,planFile,journal,environment);if(failed)return failed;
 }
 const tested=JSON.parse(await readFile(validated.directory+'.json','utf8')).entries,copyNow={},changes=new Map();
 await environmentRecord(copy,tested,undefined,copyNow);
 const inCopy=async file=>{const now=await sign(path.join(copy,file));return now==='folder'?null:now;};
 for(const file of different(base.copy.entries,tested))changes.set(file,{file,source:tested[file]?path.join(validated.directory,file):path.join(copy,file),after:tested[file]??await inCopy(file),staged:!tested[file]});
 for(const file of different(base.copy.listing,copyNow)){
  if(file.startsWith('\0')||changes.has(file))continue;
  changes.set(file,{file,source:path.join(copy,file),after:await inCopy(file),staged:true});
 }
 // A file that left the certified set and is the same on both sides, or an edit identical to the project's, is nothing to do.
 const pending=[];for(const change of changes.values()){const now=await sign(path.join(root,change.file));if(change.after!=='other'&&!reached(now,change.after))pending.push({...change,before:now});}
 const names=new Set(pending.map(change=>change.file));
 // What Git would run with the user's rights is not changed by a diff without the user seeing it.
 const state=await reservedState(root,own),inUse=await reservedFiles(pending,state,copy,root),risky=pending.filter(change=>inUse.has(change.file)&&accepted[change.file]!==change.after),moved=reservedChanges(base.reserved,state).filter(key=>accepted[key]!==(state[key]??null));
 if(risky.length)return {status:'reserved',files:risky.map(change=>change.file),confirm:Object.fromEntries(risky.map(change=>[change.file,change.after])),reason:'O resultado altera ficheiros que a configuração do Git usa: '+listed(risky.map(change=>change.file))+'.'};
 if(moved.length)return {status:'reserved',files:moved,confirm:Object.fromEntries(moved.map(key=>[key,state[key]??null])),reason:'A configuração do Git do projeto mudou desde o início da tarefa: '+listed(moved)+'.'};
 const now=await capture(root,own),changedHere=edited(base.origin,now,new Set()),touched=[...changedHere.source,...changedHere.environment];
 const clash=touched.filter(file=>names.has(file));
 if(clash.length)return {status:'conflict',files:clash,reason:'Tu e o principal alteraram os mesmos ficheiros: '+listed(clash)+'. Nada foi escrito.'};
 const elsewhere=touched.filter(file=>!changes.has(file));
 if(elsewhere.length)return {status:'integrate',files:elsewhere.filter(file=>!file.startsWith('\0')),environment:changedHere.environment.length>0,reason:'O projeto mudou fora do que a tarefa alterou; o resultado tem de ser validado com essas alterações.'};
 for(const {file,before} of pending){
  if(!await safeParents(root,file))return {status:'conflict',files:[file],reason:'Uma pasta do caminho aponta para outro lado: '+file+'. Nada foi escrito.'};
  // A socket or a pipe of the project: opening one to keep a copy of it could block for ever.
  if(before==='other')return {status:'conflict',files:[file],reason:'O projeto tem aqui algo que não é um ficheiro: '+file+'. Nada foi escrito.'};
 }
 if(!pending.length)return {status:'applied',files:[...changes.keys()],drift:[]};
 // prepareVersion gives what is tested the project's path, so this should never be true. If it is, it must not arrive.
 const probe=await copyProbe(copy,folder),stale=[];for(const {file,after,source} of pending)if(after!==null&&await holdsCopyPath(source,probe,root,path.join(copy,file)))stale.push(file);
 if(stale.length)return {status:'conflict',files:stale,reason:'Estes ficheiros têm gravado o caminho da cópia privada e deixariam de funcionar no projeto: '+listed(stale)+'. Nada foi escrito.'};
 // Removals first, the deepest first, so that a file can take the place of a folder and the other way around.
 const order=[...pending.filter(change=>change.after===null).sort((a,b)=>b.file.length-a.file.length),...pending.filter(change=>change.after!==null).sort((a,b)=>a.file.length-b.file.length)];
 // No plan on disk means nothing was written with it: what a stop left of an earlier preparation is of no use.
 await removePrivate(journal);await mkdir(path.join(journal,'copia'),{recursive:true,mode:0o700});await mkdir(path.join(journal,'novo'),{mode:0o700});
 let bytes=0;for(const change of order){const here=await lstat(change.source).catch(()=>null);if(here?.isFile())bytes+=here.size*(change.staged?2:1);const was=await lstat(path.join(root,change.file)).catch(()=>null);if(was?.isFile())bytes+=was.size;}
 await roomFor(journal,bytes+10e6,'aplicar o resultado');
 const keepFile=async(from,to)=>{const info=await lstat(from);if(info.isSymbolicLink())await symlink(await readlink(from),to);else{await copyFile(from,to);await chmod(to,info.mode&0o777);await utimes(to,info.atime,info.mtime);}};
 const plan={root,version,rootAsides:true,token:randomUUID().replaceAll('-',''),allFiles:[...changes.keys()],created:[],changes:[]};
 for(const [index,change] of order.entries()){
  const target=path.join(root,change.file),keep=path.join(journal,'copia',String(index)),hadFile=change.before!==null&&change.before!=='folder';
  if(hadFile)await keepFile(target,keep);
  // Dependencies live in the copy, which is not frozen: what goes into the plan is fixed here, and checked against what was approved.
  let source=change.source;
  if(change.staged&&change.after!==null){source=path.join(journal,'novo',String(index));await keepFile(change.source,source);if(await sign(source)!==change.after)throw Error('A cópia privada mudou durante a preparação: '+change.file);}
  const {staged:_,...entry}=change;plan.changes.push({...entry,source,keep:hadFile?keep:null});
  for(let parent=path.dirname(change.file);parent!=='.'&&change.after!==null;parent=path.dirname(parent))if(!(await lstat(path.join(root,parent)).catch(()=>null))?.isDirectory()&&!plan.created.includes(parent))plan.created.push(parent);
 }
 await syncFolder(path.join(journal,'copia'));await syncFolder(path.join(journal,'novo'));
 await saveFile(planFile,JSON.stringify(plan));
 return finish(root,plan,own,base,planFile,journal,environment);
}
/** Brings into the copy what changed in the project, so that the next round tests the two together. Looks afresh, and moves the base on only for the
 *  files it copied and checked: an edit it could not bring stays visible, and the next look asks for another round. */
export async function integrateWorkspace({workspace,own=null}){
 const {folder,copy,origin:root}=workspace,base=await readBase(folder),now=await capture(root,own),copyNow=await capture(copy,null);
 const changedHere=edited(base.origin,now,new Set()),mine=new Set(edited(base.copy,copyNow,new Set()).source.concat(edited(base.copy,copyNow,new Set()).environment));
 const files=[...new Set([...changedHere.source,...changedHere.environment])].filter(file=>!file.startsWith('\0')),clash=[];
 for(const file of files)if(mine.has(file)&&await sign(path.join(root,file))!==await sign(path.join(copy,file)))clash.push(file);
 if(clash.length)return {status:'conflict',files:clash,reason:'Tu e o principal alteraram os mesmos ficheiros: '+listed(clash)+'. Nada foi escrito.'};
 const token=randomUUID(),done=[],pending=[];
 const stillThe=async file=>{
  if(now.entries[file]!==undefined)return await sign(path.join(root,file))===now.entries[file];
  const info=await lstat(path.join(root,file)).catch(()=>null);
  if(now.listing[file]!==undefined)return Boolean(info)&&`${info.size}:${info.mtimeMs}:${info.ctimeMs}`===now.listing[file];
  return !info;
 };
 for(const file of files){
  const from=path.join(root,file),to=path.join(copy,file),temp=to+'.hydraq-integrar-'+token;
  if(!await safeParents(copy,file))throw Error('Uma pasta da cópia aponta para outro lado: '+file);
  const gone=now.entries[file]===undefined&&now.listing[file]===undefined;
  if(gone){if(await stillThe(file)){await rm(to,{force:true});done.push(file);}else pending.push(file);continue;}
  const info=await lstat(from).catch(()=>null);
  if(!info||!(info.isSymbolicLink()||info.isFile())){pending.push(file);continue;}
  await mkdir(path.dirname(to),{recursive:true});
  if(info.isSymbolicLink()){await symlink(await readlink(from),temp);await lutimes(temp,info.atime,info.mtime);}
  else{await copyFile(from,temp);await chmod(temp,info.mode&0o777);await utimes(temp,info.atime,info.mtime);}
  // Only if the original is what was looked at, and what arrived is that.
  if(await stillThe(file)&&await sign(temp)===await sign(from)){await rm(to,{force:true,recursive:false}).catch(()=>{});await rename(temp,to);done.push(file);}
  else{await rm(temp,{force:true});pending.push(file);}
 }
 await privateGit(root,copy);
 const fresh=await capture(copy,null);
 for(const file of done){
  for(const group of ['entries','listing']){
   if(now[group][file]===undefined)delete base.origin[group][file];else base.origin[group][file]=now[group][file];
   if(fresh[group][file]===undefined)delete base.copy[group][file];else base.copy[group][file]=fresh[group][file];
  }
 }
 // Links to folders outside the project are the same files on both sides.
 for(const [side,record] of [[base.origin,now],[base.copy,fresh]]){
  for(const key of Object.keys(side.listing))if(key.startsWith('\0')&&record.listing[key]===undefined)delete side.listing[key];
  for(const key of Object.keys(record.listing))if(key.startsWith('\0'))side.listing[key]=record.listing[key];
 }
 await saveFile(baseFile(folder),JSON.stringify(base));
 return {status:'integrated',files:done,pending};
}
const REWRITE_LIMIT=1024*1024*1024;
/** Whether a file holds the copy's path, read in pieces so that one split between two reads is still found. */
async function scanFor(file,{needles,pattern}){
 const reach=Math.max(4096,...needles.map(needle=>Buffer.byteLength(needle)*2));let found=false,binary=false,variant=false,tail=Buffer.alloc(0);
 for await(const chunk of createReadStream(file)){
  if(chunk.includes(0))binary=true;
  const window=tail.length?Buffer.concat([tail,chunk]):chunk;
  if(needles.some(needle=>window.includes(needle)))found=true;
  if(pattern.test(window.toString('latin1')))variant=true;
  tail=window.subarray(Math.max(0,window.length-reach));
 }
 return {found,binary,variant};
}
const asBytes=text=>Buffer.from(text).toString('latin1').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** How the copy's path can appear: exactly, which can be rewritten, or in another spelling, which is only recognised: with /./ or //, or as the task's own identifier. */
async function copyProbe(copy,folder){
 const needles=[...new Set([copy,await realpath(copy).catch(()=>copy)])],loose='/+(?:\\./+)*';
 const spellings=needles.map(needle=>needle.split(path.sep).filter(Boolean).map(asBytes).join(loose)),id=path.basename(folder);
 if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))spellings.push(id);
 return {needles,pattern:new RegExp(spellings.join('|'))};
}
/** Resolve the link itself too, not just the copy's name. Relative links stay relative to the same place in the project. */
async function projectLink(file,target,{needles},origin){
 const withinCopy=value=>needles.some(needle=>value===needle||value.startsWith(needle+path.sep));let throughCopy=false,resolved;
 // A relative link means the same wherever the project is, unless its text climbs out of the copy to come back in. Climbing out and staying out is
 // the user's business: in the project it reaches the project's neighbour.
 if(!path.isAbsolute(target)){
  let current=path.dirname(file),left=false;
  for(const part of target.split(path.sep)){current=path.join(current,part);if(!withinCopy(current))left=true;else if(left)throughCopy=true;}
  if(!left)return null;
 }
 let started=false,left=false;
 try{resolved=await resolveNamedPath(target,path.dirname(file),null,step=>{
  if(path.isAbsolute(target)){if(withinCopy(step))throughCopy=true;}
  else if(!started){if(step===path.dirname(file))started=true;}
  else if(!withinCopy(step))left=true;else if(left)throughCopy=true;
 });}
 catch(error){
  if(error.code!=='ELOOP')throw error;
  // A loop goes nowhere either way; it just must not keep the copy's name.
  const needle=needles.find(item=>target.includes(item));return needle?target.split(needle).join(origin):null;
 }
 for(const needle of needles)if(resolved===needle||resolved.startsWith(needle+path.sep)){
  const mapped=path.isAbsolute(target)?origin+resolved.slice(needle.length):path.relative(path.dirname(file),resolved)||'.';
  return mapped===target?null:mapped;
 }
 // A link through the copy can end outside it (for example .venv/bin/python). Flatten it too: the intermediate
 // private entry will disappear, even though the terminal target is permanent.
 if(throughCopy&&resolved!==target)return resolved;
 return null;
}
/** The copy's path in what is about to reach the project: it would stop working the moment the copy is gone. */
async function holdsCopyPath(file,probe,origin,location=file){
 const info=await lstat(file).catch(()=>null);if(!info)return false;
 if(info.isSymbolicLink())return await projectLink(location,await readlink(file),probe,origin)!==null;
 if(!info.isFile())return false;
 const {found,variant}=await scanFor(file,probe);return found||variant;
}
/** A program run in the copy may write the copy's path into what it generates: a virtualenv, a link. That path means nothing once the copy is gone, so the
 *  files this task changed are given the project's path before they are frozen, and it is the result that gets tested. The path is unique to this copy,
 *  so nothing else can match. Text is rewritten; a binary cannot be, and is reported. */
export async function prepareVersion({workspace}){
 const {folder,copy,origin}=workspace,base=await readBase(folder),now=await capture(copy,null),probe=await copyProbe(copy,folder),{needles}=probe;
 const files=[...new Set([...different(base.copy.entries,now.entries),...different(base.copy.listing,now.listing)])].filter(file=>!file.startsWith('\0')),rewritten=[],problems=[];
 for(const file of files){
  const full=path.join(copy,file),info=await lstat(full).catch(()=>null);if(!info)continue;
  const temp=full+'.hydraq-preparar';
  if(info.isSymbolicLink()){
   const target=await projectLink(full,await readlink(full),probe,origin);
   if(target){await rm(temp,{force:true});await symlink(target,temp);await rename(temp,full);rewritten.push(file);}
   continue;
  }
  if(!info.isFile())continue;
  const {found,binary,variant}=await scanFor(full,probe);
  if(!found&&!variant)continue;
  if(!found||binary||info.size>REWRITE_LIMIT){problems.push(file);continue;}
  let text=await readFile(full,'latin1');
  for(const needle of [...needles].sort((a,b)=>b.length-a.length))text=text.split(Buffer.from(needle).toString('latin1')).join(Buffer.from(origin).toString('latin1'));
  await rm(temp,{force:true});await writeFile(temp,text,'latin1');await chmod(temp,info.mode&0o777);await rename(temp,full);rewritten.push(file);
  // Exact occurrences are gone; another spelling in the same file is not something to guess at.
  if((await scanFor(full,probe)).variant)problems.push(file);
 }
 return {rewritten,problems};
}
