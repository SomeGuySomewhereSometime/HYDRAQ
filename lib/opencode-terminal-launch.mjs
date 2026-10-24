import {readFile,open,unlink,lstat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {processIdentity,sameProcess} from './process-owner.mjs';
const file=process.argv[2];let owned=false,child,timer;
try{
  const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error('Configuração privada OpenCode inválida.');
  const config=JSON.parse(await readFile(file,'utf8'));
  if(!sameProcess(config.ownerPid,config.ownerIdentity))throw Error('Esta ligação OpenCode terminou. Abre novamente pela HYDRAQ.');
  try{await lstat(file+'.lock');throw Error('Esta ligação já foi aberta. Fecha o terminal e usa «Continuar na HYDRAQ» antes de abrir novamente.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const lock=await open(file+'.lock','wx',0o600);owned=true;await lock.writeFile(JSON.stringify({pid:process.pid,identity:processIdentity()}));await lock.close();
  const current=JSON.parse(await readFile(file,'utf8'));
  if(current.leaseId!==config.leaseId||!sameProcess(current.ownerPid,current.ownerIdentity))throw Error('Esta ligação OpenCode foi revogada.');
  child=spawn(config.executable,config.args,{cwd:config.cwd,env:{...config.env,...(process.env.TERM?{TERM:process.env.TERM}:{}),...(process.env.COLORTERM?{COLORTERM:process.env.COLORTERM}:{})},stdio:'inherit'});
  const stop=()=>{if(child.exitCode===null)child.kill('SIGTERM');};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  timer=setInterval(async()=>{if(!sameProcess(config.ownerPid,config.ownerIdentity))stop();else try{await lstat(file);}catch{stop();}},500);
  process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code||0));});
}catch(error){console.error(error.message);process.exitCode=1;}
finally{clearInterval(timer);if(owned)await unlink(file+'.lock').catch(()=>{});}
