import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=new URL('../',import.meta.url);
function digest(directory,extensions){
 const hash=createHash('sha256');
 function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(extensions.some(ext=>file.endsWith(ext)))hash.update(file).update(readFileSync(file));}}
 walk(directory instanceof URL?fileURLToPath(directory):directory);return hash.digest('hex');
}
const backendDigest=()=>digest(new URL('lib/',root),['.mjs'])+createHash('sha256').update(readFileSync(new URL('server.mjs',root))).digest('hex');
function source(){return readFileSync(new URL('AI_CHANGES.md',root),'utf8').match(/Versão atual: (\d+)/)?.[1]||'desconhecida';}
export function runtimeVersion(publicDir){
 const startedAt=new Date().toISOString(),version=source(),backend=backendDigest();let checkedAt=0,current;
 return ()=>{if(Date.now()-checkedAt>10000){try{current={app:'HYDRAQ',version,pid:process.pid,startedAt,sourceVersion:source(),pageVersion:digest(publicDir,['.js','.css','.html']),restartRequired:backend!==backendDigest()};checkedAt=Date.now();}catch{ return {...current,version,startedAt,versionCheckFailed:true};}}return current;};
}
