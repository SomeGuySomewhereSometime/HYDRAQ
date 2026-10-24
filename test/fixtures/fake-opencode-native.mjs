import http from 'node:http';
import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const base=path.dirname(process.env.OPENCODE_DB);await mkdir(base,{recursive:true});
let sessions={};try{sessions=JSON.parse(await readFile(base+'/sessions.json','utf8'));}catch{}
let saving=Promise.resolve();const save=()=>saving=saving.then(()=>writeFile(base+'/sessions.json',JSON.stringify(sessions)));
const streams=new Set(),emit=sessionID=>{for(const s of streams)s.write('data: '+JSON.stringify({type:'session.updated',data:{sessionID}})+'\n\n');};
const msg=(type,more={})=>({id:'msg_'+randomUUID(),type,time:{created:Date.now()},...more});
const tokens={input:12,output:4,reasoning:0,cache:{read:0,write:0}};
const assistant=text=>msg('assistant',{agent:'build',model:{providerID:'opencode',id:'test-free'},content:[{type:'text',text}],tokens,cost:0,time:{created:Date.now(),completed:Date.now()}});
const finish=async(s,text,outcome='succeeded')=>{s.messages.push(assistant(text),msg('idle',{outcome}));await save();emit(s.id);};
const server=http.createServer(async(req,res)=>{
 if(req.headers.authorization!=='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64'))return res.writeHead(401).end();
 const url=new URL(req.url,'http://local');res.setHeader('content-type','application/json');
 const json=x=>res.end(JSON.stringify(x));let body;
 try{
  if(req.method==='POST'||req.method==='PATCH'||req.method==='PUT'){let text='';for await(const b of req)text+=b;body=text?JSON.parse(text):{};}
  if(url.pathname==='/api/info')return json({version:'2.0.8'});
  if(url.pathname==='/api/event'){res.setHeader('content-type','text/event-stream');res.flushHeaders();streams.add(res);req.on('close',()=>streams.delete(res));res.write('data: {"type":"server.connected","data":{}}\n\n');return;}
  if(url.pathname==='/api/model')return json({data:[{id:'test-free',providerID:'opencode',name:'Teste',enabled:true,status:'active',cost:[{input:0,output:0,cache:{read:0,write:0}}],capabilities:{input:['text','image']},variants:[{id:'low'},{id:'high'}]}]});
  if(url.pathname.startsWith('/api/experimental/mcp/'))return json({data:{}});
  if(url.pathname==='/api/session'&&req.method==='POST'){const id='ses_'+randomUUID();sessions[id]={...body,id,messages:[],permissionsPending:[],forms:[]};await save();return json({data:sessions[id]});}
  if(url.pathname==='/test/disconnect'){for(const s of streams)s.destroy();return json({});}
  if(url.pathname==='/test/events'){
   for(const frame of body.frames){for(const s of streams)s.write(frame);await new Promise(r=>setTimeout(r,5));}return json({});
  }
  const match=/^\/api\/session\/([^/]+)(.*)$/.exec(url.pathname),s=sessions[match?.[1]],suffix=match?.[2];
  if(!s)return res.writeHead(404).end('{}');
  if(suffix===''){if(req.method==='PATCH'){Object.assign(s,body);await save();return res.writeHead(204).end();}return json({data:{id:s.id,location:s.location,model:s.model,agent:s.agent}});}
  if(suffix==='/model'||suffix==='/agent'){Object.assign(s,body);await save();return res.writeHead(204).end();}
  if(suffix==='/message'){
   let mode;try{mode=JSON.parse(await readFile(base+'/mode.json','utf8'));}catch{}
   if(mode?.historyError)return res.writeHead(503).end('{}');
   const start=Number(url.searchParams.get('cursor')||0),size=mode?.pageSize||100;
   return json({data:s.messages.slice(start,start+size),cursor:{previous:null,next:start+size<s.messages.length?String(start+size):null}});
  }
  if(suffix==='/permission')return json({data:s.permissionsPending});
  if(suffix==='/form')return json({data:s.forms});
  if(suffix==='/prompt'){
   if(process.env.FAKE_OPENCODE_LOG)await appendFile(process.env.FAKE_OPENCODE_LOG,JSON.stringify({...body,sessionID:s.id})+'\n');
   s.messages.push(msg('user',{id:body.id,text:body.text,metadata:body.metadata}));await save();
   const receipt={id:body.id,sessionID:s.id,type:'user',delivery:body.delivery||'queue',payload:{text:body.text}};
   if(body.text==='lost'){req.socket.destroy();setTimeout(()=>finish(s,'Recuperada'),30);return;}
   if(body.text==='lost-hang'){req.socket.destroy();return;}
   if(body.text==='lagged'){
    const pending=assistant('');delete pending.time.completed;s.messages.push(pending,msg('idle',{outcome:'succeeded'}));await save();
    setTimeout(async()=>{pending.content=[{type:'text',text:'Final tardio'}];pending.time.completed=Date.now();await save();emit(s.id);},900);
   }
   else if(body.text==='wait'){s.messages.push(assistant('Parcial'));await save();}
   else if(body.text==='permission')s.permissionsPending.push({id:'perm_1',sessionID:s.id,action:'edit',resources:['test.txt']});
   else if(body.text==='question')s.forms.push({id:'form_1',sessionID:s.id,title:'Qual comando?',fields:[{key:'answer',type:'string',required:true}]});
   else setTimeout(()=>finish(s,body.text==='password'?process.env.OPENCODE_SERVER_PASSWORD:'Resposta '+body.text),20);
   emit(s.id);return json({data:receipt});
  }
  if(suffix==='/interrupt'){s.permissionsPending=[];s.forms=[];s.messages.push(msg('idle',{outcome:'interrupted'}));await save();emit(s.id);return json({data:{}});}
  if(suffix.startsWith('/permission/')&&suffix.endsWith('/reply')){s.permissionsPending=[];await finish(s,'Decisão '+body.decision);return res.writeHead(204).end();}
  if(suffix.startsWith('/form/')){s.forms=[];await finish(s,'Resposta '+JSON.stringify(body?.answer||{}));return res.writeHead(204).end();}
  if(suffix.startsWith('/inbox/'))return res.writeHead(204).end();
  if(suffix.startsWith('/message/')){const m=s.messages.find(m=>m.id===decodeURIComponent(suffix.slice(9)));return m?json({data:m}):res.writeHead(404).end('{}');}
  res.writeHead(404).end('{}');
 }catch(error){res.writeHead(500).end(JSON.stringify({error:error.message}));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));console.log('http://127.0.0.1:'+server.address().port);
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit());});
