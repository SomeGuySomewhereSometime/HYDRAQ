import {inspectImage,AttachmentStore,MAX_IMAGE_BYTES} from './attachments.mjs';

export const ARTIFACT_FOLDER='/tmp/hydraq-test-images';
export const ARTIFACT_QUOTA=32*1024*1024;
export const ARTIFACT_TOTAL=20*1024*1024;
export const ARTIFACT_COUNT=32;
export const ARTIFACT_WIRE_LIMIT=Math.ceil(ARTIFACT_TOTAL*4/3)+262144;

// Runs inside bwrap. The command cannot inherit the image transport descriptor.
// A tmpfs bounds storage during execution; collection also bounds reads of growing files.
function collectImages(){
 const fs=require('fs'),{spawn}=require('child_process');
 const [folder,maxFile,maxTotal,maxCount,...command]=process.argv.slice(1);
 const child=spawn(command[0],command.slice(1),{stdio:['ignore','inherit','inherit'],detached:true});
 let finished=false;
 function finish(code,signal,error){
  if(finished)return;finished=true;
  try{process.kill(-child.pid,'SIGKILL');}catch{}
  const files=[];let total=0,problem=error;
  try{
   const names=fs.readdirSync(folder);if(names.length>Number(maxCount))throw Error('Demasiadas capturas (máximo '+maxCount+').');
   for(const name of names.sort()){
    if(name.length>160||/[\x00-\x1f\x7f]/.test(name))throw Error('Nome de captura inválido.');
    const fd=fs.openSync(folder+'/'+name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try{
     const st=fs.fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.size>Number(maxFile))throw Error('Captura inválida: '+name+'. Usa ficheiros de imagem normais até 5 MB.');
     const buffer=Buffer.alloc(Number(maxFile)+1);let n=0,count;
     while(n<buffer.length&&(count=fs.readSync(fd,buffer,n,buffer.length-n,null)))n+=count;
     total+=n;if(n>Number(maxFile)||total>Number(maxTotal))throw Error('As capturas excederam o limite de tamanho.');
     files.push({name,data:buffer.subarray(0,n).toString('base64')});
    }finally{fs.closeSync(fd);}
   }
  }catch(e){problem=e.message;}
  const transport=fs.createWriteStream(null,{fd:3,autoClose:false});transport.on('error',()=>{process.exitCode=1;});
  let visual;
  try{const report='/tmp/hydraq-visual-report.json';if(fs.existsSync(report)){const fd=fs.openSync(report,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.size>131072)throw Error('Relatório visual inválido.');const buffer=Buffer.alloc(131073);let n=0,count;while(n<buffer.length&&(count=fs.readSync(fd,buffer,n,buffer.length-n,null)))n+=count;if(n>131072)throw Error('Relatório visual demasiado grande.');visual=JSON.parse(buffer.subarray(0,n).toString('utf8'));}finally{fs.closeSync(fd);}}}catch(e){problem=e.message;}
  transport.end(JSON.stringify({files:problem?[]:files,...(visual?{visual}:{}),...(problem?{error:problem}:{})}));
  process.exitCode=code??(signal?128+({SIGINT:2,SIGTERM:15,SIGKILL:9}[signal]||1):1);
 }
 child.once('error',e=>finish(127,null,e.message));child.once('close',(code,signal)=>finish(code,signal));
}
export const IMAGE_COLLECTOR='('+collectImages.toString()+')()';

export function decodeArtifacts(raw){
 if(Buffer.byteLength(raw)>ARTIFACT_WIRE_LIMIT)throw Error('Transporte de capturas demasiado grande.');
 const value=JSON.parse(raw);if(value.error)throw Error(value.error);
 if(!Array.isArray(value.files)||value.files.length>ARTIFACT_COUNT)throw Error('Lista de capturas inválida.');
 let total=0;const names=new Set();
 return value.files.map(file=>{
  if(typeof file.name!=='string'||!file.name||file.name.length>160||/[\/\\\x00-\x1f\x7f]/.test(file.name)||names.has(file.name)||typeof file.data!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data))throw Error('Captura inválida.');
  names.add(file.name);const bytes=Buffer.from(file.data,'base64');total+=bytes.length;if(total>ARTIFACT_TOTAL)throw Error('As capturas excederam 20 MB.');
  return {name:file.name,bytes,...inspectImage(bytes)};
 });
}
export {AttachmentStore,MAX_IMAGE_BYTES};
