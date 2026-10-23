import http from'node:http';import readline from'node:readline';import{readFile,writeFile,mkdir,appendFile,readdir,rm}from'node:fs/promises';import path from'node:path';import{randomUUID}from'node:crypto';
const base=path.dirname(process.env.OPENCODE_DB);await mkdir(base,{recursive:true});
for(const name of ['fixture-inbox','fixture-projected'])await mkdir(base+'/'+name,{recursive:true});
const price=[{input:0,output:0,cache:{read:0,write:0}}];const model=(id,name,providerID='opencode',cost=price)=>({id,modelID:id,providerID,name,cost,enabled:true,status:'active',capabilities:{tools:true,input:['text','image'],output:['text']},variants:[{id:'low'},{id:'high'}],limit:{context:128000,output:8192}});
const catalog=async()=>process.env.FAKE_OPENCODE_CATALOG?JSON.parse(await readFile(process.env.FAKE_OPENCODE_CATALOG,'utf8')):[model('test-free','Teste grátis'),model('second-free','Segundo grátis'),model('paid','Pago','opencode',[{input:0,output:1,cache:{read:0,write:0}}]),model('elsewhere','NVIDIA','nvidia')];
if(process.argv.includes('serve')){
 const server=http.createServer(async(req,res)=>{
  if(req.headers.authorization!=='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64')){res.writeHead(401).end();return;}
  res.setHeader('Content-Type','application/json');try{
   const route=req.url.match(/^\/api\/session\/([^/]+)\/(prompt|inbox|message)(?:\/([^/]+))?$/);
   if(!route){res.end(JSON.stringify({data:await catalog()}));return;}
   const[,sid,kind,id]=route;
   if(req.method==='POST'&&kind==='prompt'){
    let body='';for await(const part of req)body+=part;const input=JSON.parse(body);if(input.resume!==false||input.delivery!=='steer')throw Error('Unsafe fixture admission');
    const data={id:input.id,sessionID:sid,type:'user',delivery:'steer',payload:{text:input.text}};
    await appendFile(base+'/admissions.jsonl',JSON.stringify(input)+'\n');
    if(input.text==='http-fail'){res.writeHead(503).end('{}');return;}
    if(!input.text.startsWith('late'))await writeFile(base+'/fixture-inbox/'+input.id+'.json',JSON.stringify(data));
    if(input.text==='http-lost'){req.socket.destroy();return;}
    res.end(JSON.stringify({data}));return;
   }
   if(req.method==='DELETE'&&kind==='inbox'){await rm(base+'/fixture-inbox/'+id+'.json',{force:true});res.writeHead(204).end();return;}
   if(kind==='message'){try{res.end(JSON.stringify({data:JSON.parse(await readFile(base+'/fixture-projected/'+id+'.json','utf8'))}));}catch{res.writeHead(404).end('{}');}return;}
   res.writeHead(404).end('{}');
  }catch{res.writeHead(503).end('{}')}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));console.log('server listening on http://127.0.0.1:'+server.address().port);process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit())});
}else{
 let sessions={};try{sessions=JSON.parse(await readFile(base+'/fixture-sessions.json','utf8'))}catch{}
 let waiting,prompt,current,draining=false,cancelling=false;const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');const reply=(id,result)=>send({id,result});const update=(s,u)=>send({method:'session/update',params:{sessionId:s.id,update:u}});
 const drain=async()=>{if(!prompt||waiting||draining||cancelling)return;draining=true;try{for(const f of await readdir(base+'/fixture-inbox')){const data=JSON.parse(await readFile(base+'/fixture-inbox/'+f,'utf8'));if(data.sessionID!==current?.id)continue;await writeFile(base+'/fixture-projected/'+f,JSON.stringify({id:data.id,type:'user',text:data.payload.text}));await rm(base+'/fixture-inbox/'+f,{force:true});finish(current,data.payload.text);break;}}finally{draining=false;}};setInterval(()=>drain().catch(()=>{}),20).unref();
 const options=s=>[{id:'model',currentValue:s.model,options:[{value:'opencode/test-free'},{value:'opencode/second-free'}]},{id:'mode',currentValue:s.mode,options:[{value:'build'},{value:'plan'}]},{id:'effort',currentValue:s.effort,options:[{value:'default'},{value:'low'},{value:'high'}]}];
 const finish=(s,text)=>{update(s,{sessionUpdate:'agent_message_chunk',content:{type:'text',text}});update(s,{sessionUpdate:'usage_update',cost:{amount:0,currency:'USD'}});reply(prompt,{stopReason:'end_turn',usage:{inputTokens:12,outputTokens:4,totalTokens:16}});prompt=null;};
 for await(const line of readline.createInterface({input:process.stdin})){let m=JSON.parse(line),p=m.params||{},s=sessions[p.sessionId];
 if(!m.method){const w=waiting;waiting=null;if(m.result?.outcome?.outcome==='cancelled'){cancelling=true;continue;}if(w){if(w.method==='session/request_permission')update(w.s,{sessionUpdate:'tool_call',toolCallId:'tool-1',kind:'edit',title:'Edit test.txt',locations:[{path:path.join(w.s.cwd,'test.txt')}],status:'completed'});await drain();if(prompt)finish(w.s,'REPLY '+JSON.stringify(m.result));}continue;}
 if(m.method==='initialize')reply(m.id,{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{image:true},sessionCapabilities:{resume:{}}}});
 else if(m.method==='session/new'){s={id:'ses_'+randomUUID(),cwd:p.cwd,model:'opencode/test-free',mode:'build',effort:'default'};sessions[s.id]=s;await writeFile(base+'/fixture-sessions.json',JSON.stringify(sessions));reply(m.id,{sessionId:s.id,configOptions:options(s)});}
 else if(m.method==='session/resume'){if(!s||s.cwd!==p.cwd)send({id:m.id,error:{code:-32602,message:'Unknown session'}});else reply(m.id,{sessionId:s.id,configOptions:options(s)});}
 else if(m.method==='session/set_config_option'){s[p.configId]=p.value;reply(m.id,{configOptions:options(s)});}
 else if(m.method==='session/prompt'){prompt=m.id;current=s;cancelling=false;const text=p.prompt.find(b=>b.type==='text')?.text||'';if(process.env.FAKE_OPENCODE_LOG)await appendFile(process.env.FAKE_OPENCODE_LOG,JSON.stringify({sessionId:s.id,cwd:s.cwd,model:s.model,mode:s.mode,effort:s.effort,prompt:p.prompt,mcpServers:p.mcpServers,text})+'\n');
  if(text==='raw-write'||text==='raw-failed'){update(s,{sessionUpdate:'tool_call',toolCallId:'raw-write',kind:'edit',title:'write',rawInput:{path:path.join(s.cwd,'sum.mjs'),content:'export const n=5;'},locations:[],status:'in_progress'});update(s,{sessionUpdate:'tool_call_update',toolCallId:'raw-write',status:text==='raw-failed'?'failed':'completed',content:[{type:'content',content:{type:'text',text:'Created file successfully'}}]});finish(s,'Feito');}
  else if(text==='die'){process.exit(9)}else if(text==='wait'){update(s,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Parcial'}})}else if(text==='permission'||text==='question'){
   const method=text==='permission'?'session/request_permission':'elicitation/create';waiting={s,method};send({id:500,method,params:method==='session/request_permission'?{sessionId:s.id,toolCall:{toolCallId:'tool-1',title:'Edit test.txt'},options:[{optionId:'once',kind:'allow_once',name:'Permitir'},{optionId:'reject',kind:'reject_once',name:'Recusar'}]}:{sessionId:s.id,mode:'form',message:'Qual?',requestedSchema:{type:'object',required:['answer'],properties:{answer:{type:'string'}}}}});
  }else{if(text==='compact')update(s,{sessionUpdate:'compaction_update',compactionId:'cmp_1',status:'completed'});finish(s,'Resposta '+text);}}
 else if(m.method==='session/cancel'){waiting=null;reply(prompt,{stopReason:'cancelled'});prompt=null;}
 else send({id:m.id,error:{code:-32601,message:'Unsupported'}});
 }
}
