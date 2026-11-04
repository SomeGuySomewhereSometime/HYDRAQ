// Executed inside the test's bwrap, never in the user's browser or server network.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
const wait=ms=>new Promise(r=>setTimeout(r,Math.max(0,ms)));
function normalizeVisual(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Guião visual inválido.');
 const integer=(n,def,min,max)=>{n=n??def;if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('Valor fora dos limites do guião visual.');return n;};
 const page=value.page??'index.html';if(typeof page!=='string'||path.isAbsolute(page)||page.split(/[\\/]/).includes('..')||page.includes('\0')||page.length>1000)throw Error('Indica uma página relativa ao projeto.');
 const durationMs=integer(value.durationMs,1500,100,10000),frameCount=integer(value.frameCount,8,1,24),width=integer(value.width,960,320,1600),height=integer(value.height,720,240,1200);
 if(!Array.isArray(value.actions??[])||(value.actions??[]).length>80)throw Error('Escolhe até 80 ações.');
 const actions=(value.actions??[]).map(a=>{
  if(!a||!['keyDown','keyUp','mouseMove','mouseDown','mouseUp'].includes(a.type))throw Error('Ação visual inválida.');
  const atMs=integer(a.atMs,0,0,durationMs),key=a.key;
  if(a.type.startsWith('key')&&(typeof key!=='string'||!key||key.length>24))throw Error('Tecla inválida.');
  return {atMs,type:a.type,...(key?{key}:{}),x:integer(a.x,Math.floor(width/2),0,width),y:integer(a.y,Math.floor(height/2),0,height),button:a.button??'left'};
 }).sort((a,b)=>a.atMs-b.atMs);
 if(actions.some(a=>!['left','middle','right'].includes(a.button)))throw Error('Botão inválido.');
 const probe=value.probe??'';if(typeof probe!=='string'||probe.length>4000)throw Error('Sonda inválida.');
 if(!Array.isArray(value.checks??[])||(value.checks??[]).length>16)throw Error('Escolhe até 16 verificações.');
 const checks=(value.checks??[]).map(c=>{if(!c||typeof c.expression!=='string'||!c.expression||c.expression.length>2000||typeof c.name!=='string'||!c.name||c.name.length>200)throw Error('Verificação inválida.');return {name:c.name,expression:c.expression};});
 return {page,durationMs,frameCount,width,height,actions,probe,checks};
}
async function run(spec){
 if(typeof WebSocket!=='function')throw Error('O Node deste ambiente não disponibiliza WebSocket.');
 const root=fs.realpathSync(process.cwd()),folder=process.env.HYDRAQ_TEST_ARTIFACTS;if(!folder)throw Error('O teste visual requer capture:true.');const pageFile=fs.realpathSync(path.resolve(root,spec.page));if(!pageFile.startsWith(root+path.sep)||!fs.statSync(pageFile).isFile())throw Error('A página visual não é um ficheiro do projeto.');
 const server=http.createServer((req,res)=>{
  try{const file=fs.realpathSync(path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname)));if(file!==root&&!file.startsWith(root+path.sep))throw Error();
   const ext=path.extname(file),mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.glb':'model/gltf-binary','.wasm':'application/wasm'}[ext]||'application/octet-stream';
   res.setHeader('Content-Type',mime);const stream=fs.createReadStream(file);stream.on('error',()=>{res.statusCode=404;res.end();});stream.pipe(res);
  }catch{res.statusCode=404;res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile='/tmp/hydraq-browser-profile-'+process.pid;fs.mkdirSync(profile,{recursive:true});
 const child=spawn('google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size='+spec.width+','+spec.height,'about:blank'],{stdio:'ignore'});
 let socket,seq=0;const pending=new Map(),errors=[];
 const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP sem resposta: '+method));},10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text||'Erro na página.');return r.result?.value;};
 try{
  const end=Date.now()+10000;while(!fs.existsSync(profile+'/DevToolsActivePort')){if(child.exitCode!==null||Date.now()>end)throw Error('Chrome não abriu o controlo CDP.');await wait(30);}
  const port=Number(fs.readFileSync(profile+'/DevToolsActivePort','utf8').split('\n')[0]),base='http://127.0.0.1:'+port;
  const target=await (await fetch(base+'/json/new?about:blank',{method:'PUT'})).json();socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);else if(m.method==='Network.loadingFailed'&&!m.params.canceled)errors.push('Recurso não carregado: '+m.params.errorText);});
  await command('Page.enable');await command('Runtime.enable');await command('Network.enable');await command('Emulation.setDeviceMetricsOverride',{width:spec.width,height:spec.height,deviceScaleFactor:1,mobile:false});
  const instrument=`(()=>{const s=window.__hydraqVisual={samples:[],inputs:[],probeErrors:[]};const probe=()=>(${spec.probe||'null'});for(const type of ['keydown','keyup','mousedown','mouseup','mousemove'])addEventListener(type,e=>s.inputs.length<200&&s.inputs.push({type,key:e.key,t:performance.now(),x:e.clientX,y:e.clientY}),true);const tick=t=>{if(s.samples.length<1200){let state=null;try{state=probe()}catch(e){if(s.probeErrors.length<3)s.probeErrors.push(String(e))}try{s.samples.push({t,state:JSON.parse(JSON.stringify(state))})}catch{}}requestAnimationFrame(tick)};requestAnimationFrame(tick)})()`;
  await command('Page.addScriptToEvaluateOnNewDocument',{source:instrument});
  const url='http://127.0.0.1:'+server.address().port+'/'+spec.page.split('/').map(encodeURIComponent).join('/'),frames=[];
  async function pass(capture){
   for(const key of new Set(spec.actions.filter(a=>a.type.startsWith('key')).map(a=>a.key==='Space'?' ':a.key)))await command('Input.dispatchKeyEvent',{type:'keyUp',key,code:key===' '?'Space':key.length===1?(/^[0-9]$/.test(key)?'Digit':'Key')+key.toUpperCase():key});
   await command('Page.navigate',{url});let ready=false;const until=Date.now()+10000;while(!ready&&Date.now()<until){try{ready=await evaluate('location.href==='+JSON.stringify(url)+'&&document.readyState==="complete"')}catch{}if(!ready)await wait(30);}if(!ready)throw Error('A página não terminou de carregar.');
   await evaluate('document.body.focus()');await wait(100);await evaluate('window.__hydraqVisual.samples=[];window.__hydraqVisual.inputs=[];window.__hydraqVisual.start=performance.now()');
   const tasks=spec.actions.map(a=>({t:a.atMs,action:a}));if(capture)for(let i=0;i<spec.frameCount;i++)tasks.push({t:Math.round(i*spec.durationMs/Math.max(1,spec.frameCount-1)),frame:i});tasks.sort((a,b)=>a.t-b.t);
   const start=performance.now();
   for(const task of tasks){await wait(task.t-(performance.now()-start));const a=task.action;
    if(a){if(a.type.startsWith('key')){const key=a.key==='Space'?' ':a.key,code=key===' '?'Space':key.length===1?(/^[0-9]$/.test(key)?'Digit':'Key')+key.toUpperCase():key,vk=key===' '?32:key.length===1?key.toUpperCase().charCodeAt(0):({ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40}[key]||0);await command('Input.dispatchKeyEvent',{type:a.type==='keyDown'?'keyDown':'keyUp',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk,text:a.type==='keyDown'&&key.length===1?key:undefined});}
     else await command('Input.dispatchMouseEvent',{type:{mouseMove:'mouseMoved',mouseDown:'mousePressed',mouseUp:'mouseReleased'}[a.type],x:a.x,y:a.y,button:a.type==='mouseMove'?'none':a.button,clickCount:a.type==='mouseMove'?0:1});
    }else{const atMs=performance.now()-start,result=await command('Page.captureScreenshot',{format:'jpeg',quality:65}),name='frame-'+String(task.frame).padStart(2,'0')+'.jpg';fs.writeFileSync(folder+'/'+name,Buffer.from(result.data,'base64'));frames.push({name,plannedMs:task.t,actualMs:Math.round(atMs),data:result.data});}
   }
   await wait(spec.durationMs-(performance.now()-start));
   const observed=await evaluate('window.__hydraqVisual');return {...observed,samples:observed.samples.map(s=>({...s,t:s.t-observed.start})),inputs:observed.inputs.map(i=>({...i,t:i.t-observed.start})),elapsedMs:Math.round(performance.now()-start)};
  }
  const capture=await pass(true),measurement=await pass(false),samples=measurement.samples,intervals=samples.slice(1).map((s,i)=>s.t-samples[i].t),ordered=[...intervals].sort((a,b)=>a-b),percentile=p=>ordered.length?ordered[Math.min(ordered.length-1,Math.floor(ordered.length*p))]:null;
  const stateChanges=[];for(let i=1;i<samples.length&&stateChanges.length<128;i++){const before=samples[i-1].state,after=samples[i].state;if(before&&after)for(const key of ['attack','dash','combo'])if(JSON.stringify(before[key])!==JSON.stringify(after[key]))stateChanges.push({t:Math.round(samples[i].t),key,before:before[key],after:after[key]});}
  const durations=[];for(const key of ['attack','dash']){let previous=null,start=null,startObserved=false,seen=false;for(const s of samples){const value=s.state?.[key]??null;if(value!==null&&typeof value==='object')continue;if(value!==previous){if(previous&&start!==null)durations.push({key,value:previous,ms:s.t-start,startObserved,endObserved:true});start=value?s.t:null;startObserved=seen;previous=value;}seen=true;}if(previous&&start!==null)durations.push({key,value:previous,ms:samples.at(-1).t-start,startObserved,endObserved:false});}
  const checks=spec.checks.map(c=>{try{return {name:c.name,passed:Boolean(Function('samples','inputs','"use strict";return ('+c.expression+')')(samples,measurement.inputs))};}catch(e){return {name:c.name,passed:false,error:e.message};}});
  if(spec.probe)checks.unshift({name:'A sonda produziu estado observável',passed:samples.some(s=>s.state!==null)});
  const result={kind:'visual',width:spec.width,height:spec.height,frames:frames.map(({data,...r})=>r),captureElapsedMs:capture.elapsedMs,measurementElapsedMs:measurement.elapsedMs,metrics:{rafHz:intervals.length?1000*intervals.length/intervals.reduce((a,b)=>a+b,0):null,p50Ms:percentile(.5),p95Ms:percentile(.95),longFramesOver50Ms:intervals.filter(n=>n>50).length,samples:samples.length},inputs:measurement.inputs.map(i=>({...i,t:Math.round(i.t)})),stateChanges,durations,checks,probeErrors:measurement.probeErrors,errors,limits:['Cadência rAF no browser headless; não mede diretamente frames apresentados ou sensação de controlo.','Capturas e medições feitas em execuções separadas do mesmo guião.','Ataques e combos só são observados através da sonda e verificações fornecidas.']};
  await command('Page.navigate',{url:'about:blank'});const cols=Math.min(4,frames.length),rows=Math.ceil(frames.length/cols),html='<body style="margin:0;background:#111;color:white;font:14px sans-serif;display:grid;grid-template-columns:repeat('+cols+',240px)">'+frames.map(f=>'<div><div>'+f.name+' · '+f.actualMs+' ms</div><img style="width:240px;height:180px;object-fit:contain" src="data:image/jpeg;base64,'+f.data+'"></div>').join('');await command('Page.setDocumentContent',{frameId:(await command('Page.getFrameTree')).frameTree.frame.id,html});await evaluate('Promise.all([...document.images].map(i=>i.decode()))');await command('Emulation.setDeviceMetricsOverride',{width:cols*240,height:rows*205,deviceScaleFactor:1,mobile:false});
  fs.writeFileSync(folder+'/mosaico.png',Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));fs.writeFileSync('/tmp/hydraq-visual-report.json',JSON.stringify(result));console.log(JSON.stringify(result));if(errors.length||checks.some(c=>!c.passed)||(spec.probe&&!samples.some(s=>s.state!==null)))process.exitCode=1;
 }finally{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Browser encerrado.'));}socket?.close();child.kill('SIGKILL');await new Promise(r=>server.close(r));}
}
module.exports={normalizeVisual,run};
if(require.main===module)run(normalizeVisual(JSON.parse(Buffer.from(process.argv[2],'base64').toString()))).catch(e=>{console.error(e.stack);process.exitCode=1;});
