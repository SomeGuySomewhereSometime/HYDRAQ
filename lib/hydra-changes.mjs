import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile,lstat,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {certifiedEntries} from './hydra-validation.mjs';

// A larger file is compared by its signature alone: a reviewer gets nothing from its diff, and keeping big assets would copy them for every task.
const KEEP_BYTES=1<<20,MOST_FILES=2000,MOST_TEXT=20*(1<<20),LISTED=300;
export const CHANGES_PAGE=40_000;
const baseFile=folder=>path.join(folder,'base.json');
const modeOf=signature=>signature.split(':')[0];
const isLink=signature=>Boolean(signature)&&signature.split(':')[1]==='link';
const linkTarget=signature=>signature.split(':').slice(2).join(':');
async function keepContent(cwd,folder,file){
 const from=path.join(cwd,file),info=await lstat(from);
 if(!info?.isFile()||info.size>KEEP_BYTES)return false;
 const to=path.join(folder,'files',file);
 await mkdir(path.dirname(to),{recursive:true,mode:0o700});await copyFile(from,to);return true;
}
/** What the version looked like when the plan was approved, kept where no participant writes. */
export async function saveBaseline(cwd,folder){
 await rm(folder,{recursive:true,force:true});await mkdir(path.join(folder,'files'),{recursive:true,mode:0o700});
 const entries=await certifiedEntries(cwd),contents={};
 for(const file of Object.keys(entries))if(await keepContent(cwd,folder,file))contents[file]=true;
 await writeFile(baseFile(folder),JSON.stringify({entries,contents}),{mode:0o600});
 return {folder,files:Object.keys(entries).length};
}
/** Changes that came from the user's project, not from the principal, stop being shown as the task's. */
export async function refreshBaseline(cwd,folder,files){
 const base=JSON.parse(await readFile(baseFile(folder),'utf8')),current=await certifiedEntries(cwd);
 for(const file of files){
  await rm(path.join(folder,'files',file),{recursive:true,force:true});
  if(base.contents)delete base.contents[file];
  if(current[file]){base.entries[file]=current[file];if(await keepContent(cwd,folder,file)&&base.contents)base.contents[file]=true;}
  else delete base.entries[file];
 }
 await writeFile(baseFile(folder),JSON.stringify(base),{mode:0o600});
}
// Outside any repository and with no settings: a project's Git configuration or attributes can run programs, and nothing here should.
export const gitDiff=(left,right)=>new Promise((resolve,reject)=>execFile('git',['diff','--no-index','--no-color','--no-ext-diff','--no-textconv','--no-renames','-U3','--',left,right],{cwd:'/',env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',HOME:'/nonexistent',LC_ALL:'C'},maxBuffer:1<<25},(error,stdout)=>error&&error.code!==1?reject(error):resolve(stdout)));
async function fileChange(folder,directory,file,before,after,contents){
 if(isLink(before)||isLink(after)){
  const describe=signature=>!signature?'(não existia)':isLink(signature)?'ligação para '+linkTarget(signature):'ficheiro';
  return {link:true,additions:1,deletions:1,text:`@@ ligação simbólica @@\n-${describe(before)}\n+${describe(after)}\n`};
 }
 const left=before?path.join(folder,'files',file):'/dev/null',right=after?path.join(directory,file):'/dev/null';
 if(before&&!await lstat(left).catch(()=>null)){
  if(contents?.[file])throw Error('Falta o conteúdo guardado na base: '+file);
  return {large:true};
 }
 if(after&&(await lstat(right)).size>KEEP_BYTES)return {large:true};
 const output=await gitDiff(left,right);
 const start=output.search(/^@@ /m);
 if(start<0)return /^Binary files /m.test(output)?{binary:true}:{};
 const text=output.slice(start),lines=text.split('\n');
 return {text,additions:lines.filter(line=>line[0]==='+').length,deletions:lines.filter(line=>line[0]==='-').length};
}
/** Compares a frozen version with the baseline and saves the result, which outlives the frozen folder. */
export async function writeChanges(folder,frozen){
 const {entries:before,contents}=JSON.parse(await readFile(baseFile(folder),'utf8')),{entries:after}=JSON.parse(await readFile(frozen.directory+'.json','utf8'));
 const changed=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(file=>before[file]!==after[file]).sort();
 const files=[];let room=MOST_TEXT;
 for(const [index,file] of changed.entries()){
  const record={path:file,status:!before[file]?'added':!after[file]?'deleted':'modified',additions:0,deletions:0};
  if(before[file]&&after[file]&&modeOf(before[file])!==modeOf(after[file]))record.mode=modeOf(before[file])+' -> '+modeOf(after[file]);
  if(index>=MOST_FILES||room<=0)record.omitted=true;
  else Object.assign(record,await fileChange(folder,frozen.directory,file,before[file],after[file],contents));
  room-=record.text?.length||0;files.push(record);
 }
 const file=path.join(folder,'changes-'+frozen.hash+'.json');
 const body=JSON.stringify({hash:frozen.hash,files}),comparisonId=createHash('sha256').update(body).digest('hex');
 await writeFile(file,body,{mode:0o600});
 const count=status=>files.filter(item=>item.status===status).length,layout=textLayout(files);
 return {hash:frozen.hash,file,comparisonId,summary:{files:files.length,added:count('added'),modified:count('modified'),deleted:count('deleted'),additions:files.reduce((sum,item)=>sum+item.additions,0),deletions:files.reduce((sum,item)=>sum+item.deletions,0),diffLength:layout.text.length,requiredLength:layout.requiredLength,optional:layout.optional.slice(0,50),optionalCount:layout.optional.length}};
}
// What a reviewer must read before approving. Lockfiles come last and are listed, not required; after the budget, the rest is optional and the conclusion says so.
export const READ_BUDGET=160_000;
const LOCKFILES=new Set(['package-lock.json','npm-shrinkwrap.json','yarn.lock','pnpm-lock.yaml','bun.lock','bun.lockb','poetry.lock','Pipfile.lock','uv.lock','pdm.lock','Cargo.lock','composer.lock','Gemfile.lock','go.sum','flake.lock','mix.lock','pubspec.lock','packages.lock.json','gradle.lockfile','Package.resolved','Podfile.lock']);
export const isLockfile=file=>LOCKFILES.has(path.basename(file));
/** The diff text in reading order, with how much of it is required and which files it leaves partly unread. */
export function textLayout(files){
 const ordered=[...files.filter(item=>item.text&&!isLockfile(item.path)),...files.filter(item=>item.text&&isLockfile(item.path))];
 let text='',requiredLength=0;const optional=[];
 for(const item of ordered){
  text+=`--- ${item.path}\n${item.text}`;
  if(!isLockfile(item.path))requiredLength=Math.min(text.length,READ_BUDGET);
  if(isLockfile(item.path)||text.length>READ_BUDGET)optional.push(item.path);
 }
 return {text,requiredLength,optional};
}
/** One page of the saved comparison: always the list of files, and as much of the diff as a tool answer should carry. */
export async function changesPage(saved,{file,offset=0,fileOffset=0}={}){
 const body=await readFile(saved,'utf8'),{hash,files}=JSON.parse(body),comparisonId=createHash('sha256').update(body).digest('hex');
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(fileOffset)||fileOffset<0)throw Error('Os offsets têm de ser inteiros não negativos.');
 const selected=file===undefined?files:files.filter(item=>item.path===file);
 if(file!==undefined&&!selected.length)throw Error('Este ficheiro não mudou nesta versão: '+file);
 const layout=textLayout(selected),text=layout.text,end=offset+CHANGES_PAGE,fileEnd=fileOffset+LISTED;
 return {hash,comparisonId,files:files.slice(fileOffset,fileEnd).map(({text,...rest})=>rest),totalFiles:files.length,fileOffset,nextFileOffset:fileEnd<files.length?fileEnd:null,moreFiles:Math.max(0,files.length-fileEnd),diff:text.slice(offset,end),diffLength:text.length,requiredLength:layout.requiredLength,optional:layout.optional,offset,nextOffset:end<text.length?end:null};
}
