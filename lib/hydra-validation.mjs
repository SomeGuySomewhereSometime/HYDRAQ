import {chmod,constants,copyFile,lstat,mkdir,mkdtemp,readdir,readFile,readlink,realpath,rm,stat,statfs,symlink,utimes,writeFile} from 'node:fs/promises';
import {createReadStream,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import os from 'node:os';
import path from 'node:path';
import {homeBinaries,toolFolders,externalGitFolder} from './command-sandbox.mjs';
import {resolveNamedPath} from './path-resolution.mjs';

// What a review certifies: the project's source. Tests see it frozen, on top of the project itself, and write to a
// disposable layer. A version is that source plus what else its tests read: dependencies and other files outside the
// source. Caches and files that only reflect a running program stay out of it.
const EXTERNAL_LIMIT=200_000,OUTPUT_HEAD=8000,OUTPUT_TAIL=24000;
const PRIVATE=new Set(['.git','.hydraq']);
// Names that only tools use, whatever the depth.
const TOOL_CACHES=new Set(['__pycache__','.pytest_cache','.mypy_cache','.ruff_cache','.cache','.gradle','.turbo','.parcel-cache','.hypothesis','.nyc_output','.vitest','.swc','.vue-global-types','.sass-cache','.eslintcache','.stylelintcache','.ipynb_checkpoints','.coverage','htmlcov']);
// Also made by tools, but programs run what is inside: environments, generated clients and builds. They are not source, and a change to them is a new version.
const GENERATED_INPUTS=new Set(['.tox','.nox','.prisma','.dart_tool','.next','.nuxt','.svelte-kit','.astro','.expo','.angular','.vite']);
// Everyday words: only at the project's root do they name a cache, a build or dependencies. Elsewhere Git decides, and they may well be source code.
const ROOT_CACHES=new Set(['coverage','Library','Temp','Logs','obj']);
const ROOT_BUILDS=new Set(['dist','build','target','out','output']);
const ROOT_DEPENDENCIES=new Set(['venv','vendor']);
// An open editor or a running program rewrites these all the time, and tests do not depend on them.
const VOLATILE_FOLDERS=new Set(['.idea','.vs','.vscode','.fleet','.history']);
const ROOT_VOLATILE_FOLDERS=new Set(['UserSettings','tmp','temp','pids']);
const VOLATILE_FILES=/(\.(log(\.\d+)?|pid|swp|swo|tmp|sqlite3?|db|blend\d+)|-(journal|wal|shm)|~)$|^(#.*#|\.#.*|nohup\.out)$/;
// Results a test may leave behind in a project that does not ignore them yet.
const OUTPUT_FOLDERS=new Set(['bin','log','logs','tmp','temp','reports','test-results','test-reports','playwright-report','CMakeFiles','_build','.build']);
const OUTPUT_FILES=/\.(log|xml|html?|txt|lcov|out|csv|tsv|sqlite3?|db|png|jpe?g|gif|webm|mp4|map|tsbuildinfo|pid|tmp|o|a|so|dylib|dll|exe|pdb|class|jar|trx|prof)$/;
const parts=file=>file.split(path.sep);
const isSecret=name=>/^\.env($|rc$|[._-])/.test(name)&&!/^\.env\.(example|sample|template|dist|defaults)$/.test(name);
const isCache=file=>{const names=parts(file);return names.some(part=>TOOL_CACHES.has(part))||ROOT_CACHES.has(names[0])||names.at(-1)==='.DS_Store';};
const isGeneratedInput=file=>parts(file).some(part=>GENERATED_INPUTS.has(part));
const isDependency=file=>{const names=parts(file);return names.includes('node_modules')||names.includes('.venv')||ROOT_DEPENDENCIES.has(names[0]);};
const isGenerated=file=>isCache(file)||isDependency(file)||isGeneratedInput(file)||ROOT_BUILDS.has(parts(file)[0]);
const isVolatile=file=>{const names=parts(file);return names.some(part=>VOLATILE_FOLDERS.has(part))||ROOT_VOLATILE_FOLDERS.has(names[0])||VOLATILE_FILES.test(names.at(-1));};
const isOutput=file=>{const names=parts(file);return names.some(part=>OUTPUT_FOLDERS.has(part))||OUTPUT_FILES.test(names.at(-1));};
const notCertifiable=file=>parts(file).some(part=>PRIVATE.has(part)||isSecret(part));
export const overlaps=(a,b)=>{const x=path.resolve(a),y=path.resolve(b);return x===y||x.startsWith(y+path.sep)||y.startsWith(x+path.sep);};

const byName=(a,b)=>a.name<b.name?-1:a.name>b.name?1:0;
async function walk(root,relative,visit){
 const names=(await readdir(path.join(root,relative),{withFileTypes:true})).sort(byName);
 for(const entry of names){
  if(PRIVATE.has(entry.name))continue;
  const file=path.join(relative,entry.name);
  if(await visit(file,entry)!==false&&entry.isDirectory())await walk(root,file,visit);
 }
}
// Asking about a repository must never run what its configuration names: these calls happen outside any sandbox.
export const gitSafely=['-c','core.fsmonitor=false','-c','core.untrackedCache=false'];
const gitList=(cwd,args)=>new Promise(resolve=>execFile('git',[...gitSafely,'-C',cwd,'ls-files','-z',...args],{maxBuffer:1<<28},(error,stdout)=>resolve(error?null:stdout.split('\0').filter(Boolean))));
/** Which of these paths, existing or not, Git would ignore. Empty outside a repository. */
const gitIgnored=(cwd,files)=>new Promise(resolve=>{
 if(!files.length)return resolve(new Set());
 const child=execFile('git',[...gitSafely,'-C',cwd,'check-ignore','--no-index','--stdin','-z'],{maxBuffer:1<<28},(error,stdout)=>resolve(new Set(stdout.split('\0').filter(Boolean))));
 child.stdin.on('error',()=>{});child.stdin.end(files.join('\0'));
});
async function candidates(cwd){
 const tracked=await gitList(cwd,['-c']),untracked=tracked&&await gitList(cwd,['-o','--exclude-standard']);
 if(tracked&&untracked)return [...tracked,...untracked.filter(file=>!isGenerated(file)&&!isVolatile(file))];
 const found=[];
 await walk(cwd,'',(file,entry)=>{if(isGenerated(file)||isVolatile(file))return false;if(!entry.isDirectory())found.push(file);});
 return found;
}
async function signature(file){
 const info=await lstat(file),mode=info.mode&0o777;
 if(info.isSymbolicLink())return `${mode}:link:${await readlink(file)}`;
 // Read in pieces: a certified file can be larger than what a single read allows.
 const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
 return `${mode}:file:${hash.digest('hex')}`;
}
const manifestHash=entries=>createHash('sha256').update(JSON.stringify(Object.keys(entries).sort().map(file=>[file,entries[file]]))).digest('hex');
/** Certified files with their content and permissions. In a repository: what Git tracks, plus what it would track. */
async function certified(cwd){
 const entries={},root=await realpath(cwd),linked=new Map();
 // Git lists what its index holds, also under a folder since replaced by a link: following it would read files from anywhere.
 const throughLink=async file=>{
  const parent=path.dirname(file);if(parent==='.'||parent==='')return false;
  if(!linked.has(parent))linked.set(parent,await throughLink(parent)||Boolean((await lstat(path.join(cwd,parent)).catch(()=>null))?.isSymbolicLink()));
  return linked.get(parent);
 };
 const add=async file=>{
  if(notCertifiable(file)||entries[file]||await throughLink(file))return;
  const full=path.join(cwd,file),info=await lstat(full).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!info)return;
  if(info.isDirectory()){await walk(cwd,file,async(inner,entry)=>{if(!entry.isDirectory())await add(inner);});return;} // A Git submodule.
  if(!info.isFile()&&!info.isSymbolicLink())return;
  entries[file]=await signature(full);
  // A test reads through a link: what it points at inside the project is part of the same version.
  if(info.isSymbolicLink()){
   const target=await realpath(full).catch(()=>null),inner=target&&path.relative(root,target);
   if(inner&&inner!=='..'&&!inner.startsWith('..'+path.sep)&&!path.isAbsolute(inner))await add(inner);
  }
 };
 for(const file of await candidates(cwd))await add(file);
 return entries;
}
export const sourceFingerprint=async cwd=>manifestHash(await certified(cwd));
export const certifiedEntries=certified;
/** Everything tests depend on: results only count while all of this is the same as when they ran. */
export const runtimeSignature=()=>`${process.execPath}:${process.version}:${[...homeBinaries()].join(':')}`;
export async function currentVersion(cwd){
 const entries=await certified(cwd);
 return {hash:manifestHash(entries),...await environmentRecord(cwd,entries),runtime:runtimeSignature()};
}
export const sameVersion=(a,b)=>Boolean(a&&b&&a.hash===b.hash&&a.runtime===b.runtime&&a.dependencies===b.dependencies&&a.other===b.other);

/** Paths, sizes and dates of what is not certified and not a cache. */
export async function environmentRecord(cwd,entries,externalLimit=EXTERNAL_LIMIT,listing=null){
 const dependencies=createHash('sha256'),other=createHash('sha256'),root=await realpath(cwd),followed=new Set();let external=0;
 // What a link leaving the project points at cannot be frozen, and tests read it. Nothing confined can write there, so sizes and dates show a change made from outside.
 const follow=async(link,target)=>{
  if(!target||target===root||target.startsWith(root+path.sep)||followed.has(target))return;
  followed.add(target);
  const info=await stat(target).catch(()=>null);if(!info)return;
  if(!info.isDirectory()){dependencies.update(`${link}\0${target}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}\n`);if(listing)listing['\0'+link]=`${target}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;return;}
  const names=await readdir(target,{withFileTypes:true}).catch(()=>null);
  dependencies.update(`${link}\0${target}\0${names?'folder':'unreadable'}\n`);
  for(const entry of (names||[]).sort(byName)){
   if(++external>externalLimit)throw Error(`A ligação ${link} leva a mais de ${externalLimit} ficheiros fora do projeto, demasiados para validar. Copia para o projeto o que os testes precisam ou remove a ligação.`);
   if(PRIVATE.has(entry.name)||isSecret(entry.name)||TOOL_CACHES.has(entry.name)||VOLATILE_FOLDERS.has(entry.name)||VOLATILE_FILES.test(entry.name))continue;
   const inner=path.join(target,entry.name);
   await follow(path.join(link,entry.name),entry.isSymbolicLink()?await realpath(inner).catch(()=>null):inner);
  }
 };
 await walk(cwd,'',async(file,entry)=>{
  if(entry.isDirectory()||isSecret(entry.name))return;
  const full=path.join(cwd,file),dependency=isDependency(file)||isGeneratedInput(file);
  if(entry.isSymbolicLink())await follow(file,await realpath(full).catch(()=>null));
  if(entries[file]||isCache(file)||(!dependency&&isVolatile(file)))return;
  const info=await lstat(full).catch(()=>null);if(!info)return;
  // A date can be set back; the time of the last change to the file cannot.
  (dependency?dependencies:other).update(`${file}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}\n`);
  if(listing)listing[file]=`${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
 });
 return {dependencies:dependencies.digest('hex'),other:other.digest('hex')};
}
/** Files sharing their content with a name outside the project: a write to one changes the other, whatever the sandbox.
 *  Dependencies are left out because package managers link them to a shared store on purpose. */
export async function hardLinkedFiles(cwd){
 const inodes=new Map();
 await walk(cwd,'',async(file,entry)=>{
  if(!entry.isFile())return;
  const info=await lstat(path.join(cwd,file)).catch(()=>null);if(!info||info.nlink<2)return;
  const key=info.dev+':'+info.ino,known=inodes.get(key)||{nlink:info.nlink,files:[]};known.files.push(file);inodes.set(key,known);
 }).catch(error=>{if(error.code!=='ENOENT')throw error;});
 return [...inodes.values()].filter(known=>known.files.length<known.nlink).flatMap(known=>known.files).filter(file=>!isDependency(file)&&!isGeneratedInput(file)).sort();
}
const GIT_ACTIVE=['config','config.worktree','gitdir','commondir','hooks','info'];
const GIT_PLAIN=new Set([...GIT_ACTIVE,'objects','refs','logs','lfs','branches']);
const gitHooksPath=cwd=>new Promise(resolve=>execFile('git',[...gitSafely,'-C',cwd,'config','--type=path','--get','core.hooksPath'],{timeout:5000},(error,stdout)=>resolve(error?null:stdout.trim()||null)));
const pathHash=file=>createHash('sha256').update(file).digest('hex').slice(0,32);
// Settings that never name something to run. Any other value is looked at, because the list of what Git may run is long and grows.
const GIT_PLAIN_SETTINGS=/^(user|init|branch|color|advice)\./;
/** What a setting's value could name: the whole value, and its words as a shell would read them, also inside quotes. */
export function settingWords(value,depth=0){
 const text=value.replace(/^!/,'').trim(),words=[];let word='',quote=null,any=false;
 const end=()=>{if(any)words.push(word);word='';any=false;};
 for(let i=0;i<text.length;i++){
  const char=text[i];
  if(quote){if(char===quote)quote=null;else if(char==='\\'&&quote==='"'&&i+1<text.length)word+=text[++i];else word+=char;continue;}
  if(char==="'"||char==='"'){quote=char;any=true;}
  else if(char==='\\'&&i+1<text.length){word+=text[++i];any=true;}
  else if(/[\s;&|()<>]/.test(char))end();
  else{word+=char;any=true;}
 }
 end();
 const found=new Set([text,...words]);
 for(const part of words){const after=part.slice(part.indexOf('=')+1);if(after!==part)found.add(after);if(depth<2&&/[\s;&|]/.test(part))for(const inner of settingWords(part,depth+1))found.add(inner);}
 found.delete('');return [...found];
}
const RESERVED_FILES=20000,RESERVED_BYTES=16*1024*1024;
/** The repository's own settings as Git resolves them, through includes and links, with the file each one came from. */
const gitSettings=cwd=>new Promise(resolve=>execFile('git',[...gitSafely,'-C',cwd,'config','--list','--show-origin','--show-scope','-z'],{timeout:5000,maxBuffer:1<<24},(error,stdout)=>{
 if(error)return resolve(null);
 const fields=stdout.split('\0'),settings=[];
 for(let i=0;i+2<fields.length;i+=3){const end=fields[i+2].indexOf('\n');settings.push({scope:fields[i],origin:fields[i+1],key:end<0?fields[i+2]:fields[i+2].slice(0,end),value:end<0?'':fields[i+2].slice(end+1)});}
 resolve(settings);
}));
/** What no review sees and could run later with the user's rights: Git's settings and hooks, also those of its submodules and
 *  worktrees, through any link or include, wherever core.hooksPath points, and HYDRAQ's folders, at any depth. `own` is HYDRAQ's own data, which changes all the time. */
export async function reservedState(cwd,own=null){
 const state={},root=await realpath(cwd).catch(()=>cwd),opened=new Set(),repositories=[];let files=0;
 const record=async file=>{
  const full=path.resolve(cwd,file),info=await lstat(full).catch(()=>null);if(!info)return;
  if(info.isDirectory()){
   const real=await realpath(full).catch(()=>full);if(opened.has(real))return;opened.add(real);
   // A new file in here counts too, not only the ones there now.
   if(!path.isAbsolute(file))state[file+path.sep]='pasta';
   for(const name of (await readdir(full).catch(()=>[])).sort())await record(path.join(file,name));
   return;
  }
  if(++files>RESERVED_FILES){state['…']='demasiados ficheiros';return;}
  state[file]=info.isSymbolicLink()||(info.isFile()&&info.size<=RESERVED_BYTES)?await signature(full):info.isFile()?`${info.mode&0o777}:${info.size}:${info.mtimeMs}`:'other';
  // Git reads through a link: what counts is what it points at.
  if(info.isSymbolicLink())await recordTarget(full);
 };
 const within=real=>Boolean(real)&&real.startsWith(root+path.sep);
 const recordTarget=async(target,{directory=false}={})=>{
  const links=[],real=await resolveNamedPath(target,cwd,file=>links.push(file));
  // A changed alias can enable Git just as a new terminal file can. Keep each link, including a dangling one.
  for(const link of links)state[within(link)?path.relative(root,link):link]=await signature(link);
  const key=within(real)?path.relative(root,real):real,there=Boolean(await lstat(real).catch(()=>null));
  if(there)await record(key);
  // What does not exist came from a setting's value, which may well be a token. Only its hash is kept.
  else if(within(real)){state['\0ausente:'+pathHash(key)]=true;for(let folder=path.dirname(key);folder!=='.';folder=path.dirname(folder))state['\0caminho:'+pathHash(folder)]=true;}
  if(directory&&within(real))state[there?key+path.sep:'\0pasta:'+pathHash(key)]=there?'pasta':true;
 };
 const inside=async folder=>{
  for(const entry of await readdir(path.join(cwd,folder),{withFileTypes:true}).catch(()=>[]))if(entry.isDirectory()&&!GIT_PLAIN.has(entry.name)){const inner=path.join(folder,entry.name);await recordGit(inner);await inside(inner);}
 };
 const recordGit=async folder=>{for(const name of GIT_ACTIVE){const file=path.join(folder,name);await record(file);if(name==='hooks')await recordTarget(path.join(cwd,file),{directory:true});}for(const group of ['modules','worktrees'])await inside(path.join(folder,group));};
 const visit=async relative=>{
  for(const entry of await readdir(path.join(cwd,relative),{withFileTypes:true}).catch(()=>[])){
   const file=path.join(relative,entry.name);
   if(entry.name==='.git')repositories.push(relative);
   if(entry.name==='.git'&&entry.isDirectory()){state[file]='folder';await recordGit(file);}
   else if(PRIVATE.has(entry.name)){if(!own||!overlaps(path.join(cwd,file),own))await record(file),state[file]??='folder';}
   else if(entry.isDirectory())await visit(file);
  }
 };
 await visit('');
 for(const folder of [...new Set(['',...repositories])].slice(0,50)){
  const place=path.join(cwd,folder),settings=await gitSettings(place);if(!settings)continue;
  const own=[],here=await realpath(place).catch(()=>place);
  for(const {scope,origin,key,value} of settings){
   if(scope==='command')continue;
   // The user's own settings are theirs to change, unless they come from a file of the project.
   const file=origin.startsWith('file:')?path.resolve(place,origin.slice(5)):null,local=scope==='local'||scope==='worktree',inside=within(file&&await realpath(file).catch(()=>null));
   if(local||inside)own.push([key,value]);
   if(file&&(local||inside))await recordTarget(file);
   // A program inside the project can change without any setting changing, wherever the setting lives.
   if(!GIT_PLAIN_SETTINGS.test(key))for(const word of settingWords(value)){
    if(/^-|:\/\/|%/.test(word))continue; // Flags, addresses and patterns.
    const named=path.isAbsolute(word)?word:here+path.sep+word,links=[],real=await resolveNamedPath(named,here,file=>links.push(file)),info=await stat(real).catch(()=>null);
    const projectAlias=/[\/.]/.test(word)&&links.some(within);
    if(info){if(info.isFile()&&(within(real)||projectAlias))await recordTarget(named);}
    // Named but not there yet: creating it later is what makes Git run it. A bare word is looked up in PATH instead, so it needs to look like a file.
    else if((within(real)||projectAlias)&&/[\/.]/.test(word))await recordTarget(named);
   }
  }
  state[path.join(folder,'git config')]=createHash('sha256').update(JSON.stringify(own)).digest('hex');
  const hooks=await gitHooksPath(place);
  if(hooks)await recordTarget(path.isAbsolute(hooks)?hooks:here+path.sep+hooks,{directory:true});
 }
 return state;
}
// Paths that do not exist only serve isReservedPath: when one appears, it shows up under its own name.
export const reservedChanges=(before,after)=>[...new Set([...Object.keys(before),...Object.keys(after)])].filter(file=>before[file]!==after[file]&&!file.startsWith('\0')).sort();
/** Whether writing this file changes what Git would run: it is something Git uses, a new file where a setting points or in a folder of hooks, or a step on the way to one. */
export function isReservedPath(file,state){
 if(state[file]!==undefined||state['\0ausente:'+pathHash(file)]||state['\0caminho:'+pathHash(file)])return true;
 for(let folder=path.dirname(file);folder!=='.';folder=path.dirname(folder))if(state[folder+path.sep]!==undefined||state['\0pasta:'+pathHash(folder)])return true;
 return false;
}
const keepFolders=async(cwd,layer,folders)=>{
 for(const folder of [...folders].sort((a,b)=>b.length-a.length)){const info=await lstat(path.join(cwd,folder));await utimes(path.join(layer,folder),info.atime,info.mtime);await chmod(path.join(layer,folder),info.mode&0o777);}
};
const parentFolders=(file,folders)=>{for(let folder=path.dirname(file);folder!=='.';folder=path.dirname(folder))folders.add(folder);};
/** Freezing a version copies its source. Nothing limits its size except the room to hold it, looked at before any of it is read. */
async function roomToFreeze(cwd,directory){
 let bytes=0;for(const file of await candidates(cwd)){const info=await lstat(path.join(cwd,file)).catch(()=>null);if(info?.isFile())bytes+=info.size;}
 const info=await statfs(directory),free=Number(info.bavail)*Number(info.bsize),needed=bytes+100e6;
 if(free<needed)throw Error(`Não há espaço em disco para congelar o código desta versão: são precisos ${Math.ceil(needed/1e6)} MB e há ${Math.floor(free/1e6)} MB. Liberta espaço; se forem artefactos, acrescenta-os ao .gitignore.`);
}
async function freeze(cwd,frozen,entries){
 const folders=new Set();
 for(const file of Object.keys(entries)){
  const from=path.join(cwd,file),to=path.join(frozen,file),info=await lstat(from);
  await mkdir(path.dirname(to),{recursive:true,mode:0o700});
  parentFolders(file,folders);
  if(info.isSymbolicLink())await symlink(await readlink(from),to);
  // Same dates: tools such as Python keep trusting the caches they left in the project.
  else{await copyFile(from,to,constants.COPYFILE_FICLONE);await chmod(to,info.mode&0o777);await utimes(to,info.atime,info.mtime);}
 }
 await keepFolders(cwd,frozen,folders);
 await chmod(frozen,(await lstat(cwd)).mode&0o777);
}
/** A layer that covers what tests must not read, wherever it is and whenever it appeared: an empty file hides a file or a whole folder. */
async function maskPrivate(cwd,masks){
 const folders=new Set();
 const visit=async relative=>{
  for(const entry of await readdir(path.join(cwd,relative),{withFileTypes:true}).catch(()=>[])){
   const file=path.join(relative,entry.name);
   if(entry.name==='.git')continue;
   if(entry.name==='.hydraq'||(isSecret(entry.name)&&!entry.isDirectory())){
    await mkdir(path.dirname(path.join(masks,file)),{recursive:true,mode:0o700});await writeFile(path.join(masks,file),'',{mode:0o600});parentFolders(file,folders);
   }else if(entry.isDirectory())await visit(file);
  }
 };
 await visit('');await keepFolders(cwd,masks,folders);
}
/** Removes a private folder even when overlayfs left an inaccessible work directory in it. */
export async function removePrivate(directory){
 const open=async folder=>{
  await chmod(folder,0o700).catch(()=>{});
  for(const entry of await readdir(folder,{withFileTypes:true}).catch(()=>[]))if(entry.isDirectory())await open(path.join(folder,entry.name));
 };
 await open(directory);await rm(directory,{recursive:true,force:true});
}
/** Freezes the current version. The folder must stay outside the project, because overlay layers cannot overlap. */
export async function validationSnapshot(cwd,directory){
 if(overlaps(directory,cwd))throw Error('A pasta privada de testes precisa de ficar fora do projeto.');
 await mkdir(directory,{recursive:true,mode:0o700});await roomToFreeze(cwd,directory);
 const entries=await certified(cwd),hash=manifestHash(entries),frozen=await mkdtemp(path.join(directory,'source-'));
 try{
  await freeze(cwd,frozen,entries);
  const copy=Object.fromEntries(await Promise.all(Object.keys(entries).map(async file=>[file,await signature(path.join(frozen,file))])));
  if(hash!==await sourceFingerprint(cwd)||hash!==manifestHash(copy))throw Error('O projeto mudou durante a cópia de testes.');
  const record=await environmentRecord(cwd,entries);
  await writeFile(frozen+'.json',JSON.stringify({entries}),{mode:0o600});
  return {directory:frozen,hash,files:Object.keys(entries).length,...record,runtime:runtimeSignature()};
 }catch(error){await removePrivate(frozen);throw error;}
}
function tools(cwd){
 const home=os.homedir(),git=externalGitFolder(cwd),mounts=[...toolFolders(),...(git?[git]:[])].flatMap(folder=>['--ro-bind-try',folder,folder]);
 return {mounts,PATH:[path.dirname(process.execPath),...homeBinaries(),'/usr/local/bin','/usr/bin','/bin'].join(':'),rustup:path.join(home,'.rustup'),userBase:path.join(home,'.local')};
}
const privateFolders=['--tmpfs','/tmp','--tmpfs','/run','--tmpfs','/home','--tmpfs','/root'];
class Output{
 head='';tail='';total=0;decoder=new StringDecoder('utf8');
 add(data){
  const text=this.decoder.write(data);this.total+=text.length;
  const room=Math.max(0,OUTPUT_HEAD-this.head.length);this.head+=text.slice(0,room);this.tail=(this.tail+text.slice(room)).slice(-OUTPUT_TAIL);
 }
 get truncated(){return this.total>OUTPUT_HEAD+OUTPUT_TAIL;}
 toString(){return this.head+(this.truncated?`\n[… ${this.total-this.head.length-this.tail.length} caracteres omitidos …]\n`:'')+this.tail;}
}
/** Runs bwrap and kills it whole on timeout or cancellation. */
function launch(args,{timeoutMs,signal,input=null}){
 return new Promise(resolve=>{
  const output=new Output();let raw='',timedOut=false,settled=false;
  signal?.throwIfAborted?.();
  const child=spawn('bwrap',args,{stdio:[input===null?'ignore':'pipe','pipe','pipe'],detached:true});
  const stop=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
  const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
  signal?.addEventListener('abort',stop,{once:true});
  // The signal may have fired while the child was starting; a listener added afterwards would never run.
  if(signal?.aborted)stop();
  child.stdout.on('data',data=>{output.add(data);if(input!==null)raw+=data;});
  child.stderr.on('data',data=>output.add(data));
  if(input!==null){child.stdin.on('error',()=>{});child.stdin.end(input);}
  const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);resolve({...value,raw,output:output.toString(),truncated:output.truncated,timedOut,aborted:Boolean(signal?.aborted)});};
  child.once('error',error=>finish({exitCode:null,error:error.message,environment:true}));
  child.once('close',(code,killed)=>{stop();finish({exitCode:code,signal:killed});});
 });
}
// Same format as signature(). It runs in a view of the project with no process of the test left alive.
const VERIFY=`const fs=require("fs"),crypto=require("crypto");const {files,folders}=JSON.parse(fs.readFileSync(0,"utf8")),out={files:{},folders:{}};for(const f of files){try{const i=fs.lstatSync(f),m=i.mode&0o777;if(i.isSymbolicLink())out.files[f]=m+":link:"+fs.readlinkSync(f);else if(i.isFile()){const h=crypto.createHash("sha256"),d=fs.openSync(f,"r"),b=Buffer.allocUnsafe(1048576);let n;while((n=fs.readSync(d,b))>0)h.update(b.subarray(0,n));fs.closeSync(d);out.files[f]=m+":file:"+h.digest("hex");}else out.files[f]="other";}catch{out.files[f]=null;}}for(const f of folders){try{out.folders[f]=fs.readdirSync(f||".");}catch{out.folders[f]=[];}}process.stdout.write(JSON.stringify(out));`;
// Writes that cannot change what is being tested: caches, the test's own builds, Git's scratch copy and private files.
const disposable=file=>{
 const names=parts(file),last=names.at(-1);
 return isCache(file)||isGeneratedInput(file)||PRIVATE.has(last)||isSecret(last)||ROOT_BUILDS.has(names[0]);
};
/** What the test wrote, as its disposable layer records it, apart from the certified files. Folders are returned too. */
async function writtenByTest(upper){
 const folders=[''],files=[];
 const visit=async relative=>{
  await chmod(path.join(upper,relative),0o700).catch(()=>{});
  for(const entry of await readdir(path.join(upper,relative),{withFileTypes:true})){
   const file=path.join(relative,entry.name);
   if(disposable(file))continue;
   if(entry.isDirectory()){folders.push(file);await visit(file);}
   else if(!entry.isCharacterDevice())files.push(file); // Removals are found by comparing the folders.
  }
 };
 await visit('');
 return {folders,files};
}
const sameContent=async(a,b)=>{
 const [x,y]=await Promise.all([lstat(a),lstat(b)]);
 if((x.mode&0o777)!==(y.mode&0o777)||x.isSymbolicLink()!==y.isSymbolicLink()||x.isFile()!==y.isFile())return false;
 if(x.isSymbolicLink())return await readlink(a)===await readlink(b);
 return x.isFile()&&x.size===y.size&&await signature(a)===await signature(b);
};
async function changedFiles({snapshot,cwd,upper,entries,mounts}){
 const {folders,files}=await writtenByTest(upper);
 const seen=await launch(['--unshare-all','--die-with-parent','--new-session','--ro-bind','/','/',...privateFolders,...mounts,'--overlay-src',cwd,'--overlay-src',snapshot,'--overlay-src',upper,'--ro-overlay',cwd,'--proc','/proc','--dev','/dev','--chdir',cwd,'--clearenv','--',process.execPath,'-e',VERIFY],{timeoutMs:120000,input:JSON.stringify({files:Object.keys(entries),folders})});
 if(seen.exitCode!==0)throw Error(seen.output.trim().slice(-300)||'sem resposta');
 const after=JSON.parse(seen.raw),changed=new Set(Object.keys(entries).filter(file=>after.files[file]!==entries[file])),others=[];
 // What is neither certified nor a dependency is the project's own output, which a test may rewrite: a log, a test database, an ignored build.
 const added=[];
 for(const file of files){
  if(entries[file])continue;
  if(!await lstat(path.join(cwd,file)).catch(()=>null))added.push(file);
  else if(!await sameContent(path.join(upper,file),path.join(cwd,file)).catch(()=>false))(isDependency(file)?changed.add(file):others.push(file));
 }
 // A new file is a problem when it would become part of the source, or sits among the dependencies.
 const ignored=await gitIgnored(cwd,added);
 for(const file of added){
  if(isDependency(file))changed.add(file);
  else if(ignored.has(file)||isOutput(file))others.push(file);
  else changed.add(file);
 }
 // Files of the project that the test removed, also by replacing their folder.
 for(const folder of folders){
  const visible=new Set(after.folders[folder]);
  for(const name of await readdir(path.join(cwd,folder)).catch(()=>[])){
   const file=path.join(folder,name);
   if(!visible.has(name)&&!entries[file]&&!disposable(file))(isDependency(file)?changed.add(file):others.push(file));
  }
 }
 return {changed:[...changed].sort(),others:others.sort()};
}
// A failure anywhere in the command fails the test, also before a `;` or inside a pipe.
const TEST_SHELL=existsSync('/bin/bash')?['/bin/bash','-e','-o','pipefail','-c']:['/bin/sh','-e','-c'];
/** A command's parts, split at its control operators, outside quotes and substitutions. */
function shellParts(command){
 const parts=[];let word='',quote=null,depth=0,joiner='';
 const close=next=>{const value=word.replace(/^[({\s]+|[)}\s]+$/g,'');if(value)parts.push({joiner,next,text:value,grouped:/^\s*[({]/.test(word)});word='';if(value||!['&&','||','|'].includes(joiner))joiner=next;};
 for(let i=0;i<command.length;i++){
  const ch=command[i],two=command.slice(i,i+2);
  if(quote){word+=ch;if(ch==='\\'&&quote==='"')word+=command[++i]||'';else if(ch===quote)quote=null;continue;}
  if(ch==='\\'){word+=ch+(command[++i]||'');continue;}
  if(ch==="'"||ch==='"'){quote=ch;word+=ch;continue;}
  if(two==='$('){depth++;word+=two;i++;continue;}
  if(depth){if(ch==='(')depth++;else if(ch===')')depth--;word+=ch;continue;}
  if(ch==='#'&&(!word||/\s$/.test(word))){while(i<command.length&&command[i]!=='\n')i++;close(';');continue;}
  if(two==='||'||two==='&&'||two==='|&'){close(two==='|&'?'|':two);i++;continue;}
  if(ch==='&'&&(command[i-1]==='>'||command[i+1]==='>')){word+=ch;continue;}
  if(ch===';'||ch==='\n'||ch==='|'||ch==='&'){close(ch==='\n'?';':ch);continue;}
  word+=ch;
 }
 close('');return parts;
}
const SWALLOWS=/^(true|:|exit(\s+0)?|echo(\s.*)?|printf(\s.*)?)$/s;
const TESTS_NOTHING=/^(true|:|exit(\s+0)?|echo(\s.*)?|printf(\s.*)?|pwd|ls(\s.*)?|sleep(\s.*)?|date(\s.*)?|whoami|cat(\s.*)?|wc(\s.*)?|git\s+(diff|status|log|show)(\s.*)?)$/s;
// A shell started inside the command does not stop on errors. Passing them on through SHELLOPTS would change the project's own bash scripts too.
const LAUNCHER=/^(?:(?:timeout(?:\s+-\S+)*\s+\S+|nice(?:\s+-n\s*\S+)?|env(?:\s+-\S+)*(?:\s+\w+=\S*)*|command|exec|time)\s+)*/;
const NESTED=new Set(['bash','sh','dash','zsh','ksh','ash','eval']);
/** Literal argv words, without their outer quotes. Expansions cannot define a script we certify. */
function shellWords(value){
 const words=[];let word='',quote=null,started=false,literal=true;
 const close=()=>{if(started)words.push({value:word,literal});word='';started=false;literal=true;};
 for(let i=0;i<value.length;i++){
  const ch=value[i];
  if(quote==="'"){if(ch==="'")quote=null;else word+=ch;continue;}
  if(quote==='"'){if(ch==='"')quote=null;else if(ch==='\\'&&'"\\$`'.includes(value[i+1]))word+=value[++i];else{if(ch==='$'||ch==='`')literal=false;word+=ch;}continue;}
  if(/\s/.test(ch)){close();continue;}
  started=true;
  if(ch==="'"||ch==='"'){quote=ch;continue;}
  if(ch==='\\'){word+=value[++i]||'';continue;}
  if(ch==='$'||ch==='`')literal=false;
  word+=ch;
 }
 if(quote)literal=false;close();return words;
}
/** The script a nested shell or eval would run, checked like the command itself. */
function nestedProblem(text,depth){
 const words=shellWords(text.replace(LAUNCHER,'')),shell=path.basename(words[0]?.value||'');if(!NESTED.has(shell))return null;
 if(shell==='eval')return testCommandProblem(words.slice(1).map(word=>word.value).join(' '),depth+1);
 const unknown='não foi possível verificar as opções do shell; usa o comando direto ou um bash -c com script literal';
 const long=new Set(['--noprofile','--norc','--posix','--restricted','--verbose','--login','--debugger','--noediting','--help','--version','--dump-strings','--dump-po-strings']);
 let inline=false,errexit=false,pipes=false,stdin=false,informational=false,optionsEnded=false,script;
 for(let i=1;i<words.length;i++){
  const arg=words[i];
  // A redirection feeds or captures the shell; it is not its script. Its target may be any word.
  const redirect=/^\d*(<<<|<<-?|<>|<&|<|>>|>&|>\||>|&>>|&>)/.exec(arg.value);
  if(redirect){if(arg.value===redirect[0])i++;continue;}
  if(!arg.literal)return unknown;
  // After -- only a real argument supplies the script file; redirections above do not.
  if(optionsEnded){if(stdin)break;return null;}
  if(arg.value==='--'){
   if(!inline){if(stdin)break;optionsEnded=true;continue;}
   script=words[i+1];if(!script?.literal)return unknown;break;
  }
  if(arg.value.startsWith('--')){
   if(['--rcfile','--init-file'].includes(arg.value)){if(!words[++i]?.literal)return unknown;continue;}
   if(!long.has(arg.value))return unknown;
   if(['--help','--version'].includes(arg.value))informational=true;
   continue;
  }
  if(!/^[-+][a-zA-Z]+$/.test(arg.value)){
   if(arg.value.startsWith('-')||arg.value.startsWith('+'))return unknown;
   // A file of the project is its own script; after -s, the words are only its arguments.
   if(!inline){if(stdin)break;return null;}
   script=arg;break;
  }
  const enabled=arg.value[0]==='-';
  for(const flag of arg.value.slice(1)){
   if(!'abcefhiklmnoprstuvxBCEHOPT'.includes(flag))return unknown;
   if(flag==='c')inline=true;
   if(flag==='s')stdin=true;
   if(flag==='e')errexit=enabled;
   if(flag==='o'||flag==='O'){
    const option=words[++i];if(!option?.literal)return unknown;
    if(flag==='o'&&option.value==='errexit')errexit=enabled;
    if(flag==='o'&&option.value==='pipefail')pipes=enabled;
   }
  }
 }
 // With neither -c nor a file, the shell runs what comes in on its input (a heredoc, a pipe, <<< or -s), without stopping on errors.
 if(!inline)return informational?null:`um ${shell} que lê o script da entrada (heredoc, pipe, <<< ou -s) não para em erro; põe os comandos diretamente no teste, numa só cadeia de &&, ou num ficheiro de script`;
 if(!script?.literal)return unknown;
 if(shell!=='bash')return `${shell} -c não para em erro; usa bash -c ou o comando direto`;
 const options=/^\s*set\s+([^;&|\n]*)/.exec(script.value)?.[1]||'';
 const strict=errexit||/(^|\s)-[a-z]*e|-o\s+errexit/.test(options),pipefail=pipes||/pipefail/.test(options);
 // Without set -e only its last command counts: one && chain gives the right result, anything else may not.
 if(!strict&&shellParts(script.value).some(part=>[';','&','||','|'].includes(part.joiner)||part.next==='&'))return 'um bash -c com vários comandos não para em erro: junta-os com &&, começa com set -eo pipefail, ou corre-os diretamente';
 if(strict&&!pipefail&&shellParts(script.value).some(part=>part.joiner==='|'))return 'num bash -c com set -e, um pipe só conta com set -o pipefail';
 return testCommandProblem(script.value,depth+1);
}
/** Why a command's exit code would prove nothing. Catches mistakes, not cheating: a program can always lie about its own result. */
export function testCommandProblem(command,depth=0){
 if(depth>3)return 'demasiados shells uns dentro dos outros';
 const parts=shellParts(command);
 for(const [index,part] of parts.entries()){
  const nested=nestedProblem(part.text,depth);if(nested)return nested;
  // Without a job, wait returns 0 whatever the background command did.
  if(/^wait$/.test(part.text)&&parts.slice(0,index).some(x=>x.next==='&'))return 'wait sem argumentos devolve sempre 0; usa wait $! para receber o resultado';
  if(/^trap\s/.test(part.text)&&/\bexit\b/.test(part.text))return 'um trap com exit pode trocar o código de saída';
  // A negated command stops nothing unless it is the last one.
  if(/^!\s/.test(part.text)&&index<parts.length-1&&[';','&'].includes(part.next))return 'um ! a meio não para em erro; põe a verificação no fim ou usa um teste separado';
  if(/^set\s+(\+[a-z]*e|\+o\s+(errexit|pipefail))/.test(part.text))return 'desliga a paragem em erro';
  if(part.joiner==='||'&&!part.grouped&&SWALLOWS.test(part.text))return `esconde a falha com || ${part.text.split(/\s/)[0]}`;
 }
 // errexit does not run for the left side of &&. A later list can replace that failure with success.
 // Grouped lists can disable errexit for their contents too; ask for separate tests instead.
 const and=parts.findIndex(part=>part.joiner==='&&');
 if(and>=0&&(parts.some(part=>part.grouped||part.next==='&')||parts.slice(and+1).some(part=>[';','&','||'].includes(part.joiner))))return 'uma lista com && pode perder a falha antes do comando seguinte; usa só uma cadeia de && ou testes separados';
 // Inside an if the shell does not stop on failure, so only an explicit failing exit makes it count.
 if(parts.some(part=>/^(if|while|until)\s/.test(part.text))&&!parts.some(part=>/(^|\s)(exit\s+[1-9]|false$)/.test(part.text)))return 'um if sem exit com erro termina sempre com sucesso';
 if(parts.every(part=>TESTS_NOTHING.test(part.text)))return 'não verifica nada: só mostra informação';
 return null;
}
const comparable=command=>command.replace(/\s+/g,' ').trim().toLowerCase().replace(/\b(npm|pnpm|yarn|bun) run /g,'$1 ').replace(/\b(npm|pnpm|yarn|bun) t\b/g,'$1 test').replace(/\bpython3? -m /g,'');
const NAMED=/(?<![\w./-])((?:npm|pnpm|yarn|bun)(?: run)? (?:test|t|lint|check|build|typecheck)\b[\w:.-]*|npx (?:vitest|jest|mocha|playwright|tsc)\b|pytest\b|python3? -m (?:pytest|unittest)\b|cargo (?:test|check|clippy|build)\b|go (?:test|vet|build)\b|make (?:test|check|lint|build)\b|node --test\b|deno test\b|dotnet test\b|mvn (?:test|verify)\b|gradle test\b|\.\/gradlew test\b|tox\b|nox\b|rspec\b|phpunit\b|ctest\b)/gi;
/** Test and build commands the user's request names. */
export const namedCommands=text=>[...new Set([...text.replace(/[ \t]+/g,' ').matchAll(NAMED)].map(match=>comparable(match[1])))];
export const ranCommand=(command,named)=>new RegExp('(?<![\\w./-])'+named.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![\\w:-])').test(comparable(command));
/** No fallback to unsandboxed execution. Tests write only to a disposable layer and to /tmp. */
export async function runValidation({snapshot,cwd,command,timeoutMs=120000,signal,origin=null}){
 const {entries}=JSON.parse(await readFile(snapshot+'.json','utf8')),scratch=await mkdtemp(path.join(path.dirname(snapshot),'check-'));
 const upper=path.join(scratch,'upper'),work=path.join(scratch,'work'),masks=path.join(scratch,'masks');
 try{
  await mkdir(upper);await mkdir(work);await mkdir(masks);await maskPrivate(cwd,masks);
  const {mounts,PATH,rustup,userBase}=tools(cwd);
  // A private copy: the test works in it, and absolute paths written inside a virtualenv or a link lead to it, never to the real project.
  const alias=origin?['--tmpfs',origin,...(await readdir(cwd)).flatMap(name=>['--symlink',path.join(cwd,name),path.join(origin,name)])]:[];
  const result=await launch(['--unshare-all','--die-with-parent','--new-session','--ro-bind','/','/',...privateFolders,...mounts,
   '--overlay-src',cwd,'--overlay-src',snapshot,'--overlay-src',masks,'--overlay',upper,work,cwd,...alias,
   '--proc','/proc','--dev','/dev','--chdir',cwd,'--clearenv','--setenv','PATH',PATH,'--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp','--setenv','CI','1','--setenv','RUSTUP_HOME',rustup,'--setenv','PYTHONUSERBASE',userBase,'--setenv','PYTHONPYCACHEPREFIX','/tmp/pycache','--',...TEST_SHELL,command],{timeoutMs,signal});
  const {raw,...report}=result;
  if(report.exitCode===141)report.error='Um comando do encadeamento parou porque o seguinte fechou a saída, por exemplo head. Repete sem cortar a saída: o resultado completo é devolvido na mesma.';
  if(report.exitCode===1&&/^bwrap: /.test(report.output))report.environment=true;
  if(report.aborted||report.environment)return report;
  try{
   const {changed,others}=await changedFiles({snapshot,cwd,upper,entries,mounts});
   return {...report,sourceChanged:changed.length>0,changedFiles:changed.slice(0,50),outputFiles:others.slice(0,30),...(changed.length?{error:'O teste alterou ou criou ficheiros de que o resultado depende: '+changed.slice(0,10).join(', ')+(changed.length>10?` e mais ${changed.length-10}`:'')+'. O resultado não certifica a implementação. O que for temporário escreve-o em /tmp; se for um resultado do projeto, acrescenta-o ao .gitignore.'}:{})};
  }catch(error){return {...report,environment:true,error:'Não foi possível confirmar se o teste alterou o código: '+error.message};}
 }finally{await removePrivate(scratch);}
}
/** What a finished test means for the review. Only "passed" allows approval. */
export function testStatus(result){
 if(result.aborted)return 'interrupted';
 if(result.timedOut)return 'timedOut';
 if(result.sourceChanged)return 'failed';
 if(result.environment||result.exitCode===126||result.exitCode===127)return 'environment';
 return result.exitCode===0&&!result.error?'passed':'failed';
}
/** Why reviewers could not test this project, tried for real, before anything is written. Null when they can. */
export async function validationProblem(cwd,directory,origin=null){
 const probe=path.join(directory,'preflight');
 try{
  const frozen=await validationSnapshot(cwd,probe),result=await runValidation({snapshot:frozen.directory,cwd,origin,command:'true',timeoutMs:30000});
  return result.exitCode===0&&!result.sourceChanged?null:result.error||result.output.trim().slice(-300)||`código ${result.exitCode}`;
 }catch(error){return error.message;}
 finally{await removePrivate(probe);}
}
