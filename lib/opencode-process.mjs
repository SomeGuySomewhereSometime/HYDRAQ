import{spawn}from'node:child_process';import{processIdentity,sameProcess}from'./process-owner.mjs';
const [owner,executable,...args]=process.argv.slice(2),pid=Number(owner),identity=processIdentity(pid);
if(!identity||!sameProcess(pid,identity))process.exit(1);
const child=spawn(executable,args,{stdio:'inherit'});let closing=false;
const stop=()=>{if(closing)return;closing=true;try{process.kill(-process.pid,'SIGTERM')}catch{child.kill('SIGTERM')}setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL')}catch{}},1200).unref();};
process.on('SIGTERM',stop);process.on('SIGINT',stop);const watch=setInterval(()=>{if(!sameProcess(pid,identity))stop()},1000);watch.unref();child.once('error',()=>{clearInterval(watch);process.exit(1)});child.once('exit',(code)=>{clearInterval(watch);process.exit(code??1)});
