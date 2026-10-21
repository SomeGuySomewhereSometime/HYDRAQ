import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
if (!process.argv.includes('acp') || !process.argv.includes('--sandbox') || !process.env.CURSOR_API_KEY || process.argv.includes('--force') || process.env.CURSOR_AUTH_TOKEN || process.env.CURSOR_API_ENDPOINT) process.exit(9);
const emit = message => process.stdout.write(JSON.stringify({ jsonrpc:'2.0',...message })+'\n');
const result = (id,result) => emit({id,result});
const error = (id,message,code=-32602) => emit({id,error:{code,message}});
let sid, cwd, mode='agent', model='grok-4.7', context='256k', effort='high', fast='true', saved={prompts:[]}, count=0;
const requests=new Map(); let holding;
const effortId=()=>model==='grok-4.7'?'reasoning_effort':'effort';
const option=(id,currentValue,items)=>({id,currentValue,options:items.map(value=>({value,name:value}))});
const config=()=>[option('mode',mode,['agent','plan','ask']),option('model',model,['grok-4.7','grok-4.6','grok-4.5']),option(effortId(),effort,['low','medium','high','xhigh']),option('fast',fast,['false','true']),...(model==='grok-4.7'?[option('context',context,['256k','500k'])]:[])];
const storage=()=>path.join(process.env.CURSOR_CONFIG_DIR,`fake-session-${sid}.json`);
const persist=()=>writeFileSync(storage(),JSON.stringify(saved));
const update=u=>emit({method:'session/update',params:{sessionId:sid,update:u}});
const say=text=>update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
const done=(id,reason='end_turn')=>result(id,{stopReason:reason});
const request=(method,params,callback)=>{const id='native-'+(++count);requests.set(id,callback);emit({id,method,params});};
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(!m.method){const cb=requests.get(m.id);if(cb){requests.delete(m.id);cb(m);}return;}
 const p=m.params || {};
 if(m.method==='initialize'){
  if(!p.clientCapabilities?._meta?.parameterizedModelPicker)return error(m.id,'Native parameter negotiation missing');
  return result(m.id,{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{image:process.env.FAKE_CURSOR_NO_IMAGES!=='true'}},authMethods:[{id:'cursor_login'}]});
 }
 if(m.method==='authenticate'){process.exit(8);}
 if(m.method==='cursor/list_available_models')return result(m.id,{models:['grok-4.7','grok-4.6','grok-4.5','gpt-hidden'].map(value=>({value,name:value,configOptions:[option(value==='grok-4.7'?'reasoning_effort':'effort','high',['low','medium','high','xhigh']),option('fast','true',['false','true']),...(value==='grok-4.7'?[option('context','256k',['256k','500k'])]:[])]}))});
 if(m.method==='session/new'){sid=randomUUID();cwd=p.cwd;saved={prompts:[]};persist();return result(m.id,{sessionId:sid,configOptions:config()});}
 if(m.method==='session/load'){
  sid=p.sessionId;cwd=p.cwd;if(!existsSync(storage()))return error(m.id,'Unknown session');saved=JSON.parse(readFileSync(storage()));
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'REPLAY-DO-NOT-DUPLICATE'}});
  return result(m.id,{configOptions:config()});
 }
 if(m.method==='session/set_config_option'){
  if(p.sessionId!==sid)return error(m.id,'Wrong session');
  if(p.configId==='model')model=p.value;
  else if(p.configId==='mode')mode=p.value;
  else if(p.configId==='context')context=p.value;
  else if(p.configId==='fast')fast=p.value;
  else if(p.configId===effortId())effort=p.value;
  else return error(m.id,'Wrong native parameter id');
  return result(m.id,{configOptions:process.env.FAKE_CURSOR_UNCONFIRMED?[]:config()});
 }
 if(m.method==='session/cancel'){if(holding){done(holding,'cancelled');holding=null;}return;}
 if(m.method!=='session/prompt')return error(m.id,'Method not found',-32601);
 const text=p.prompt[0].text;
 if(process.env.FAKE_CURSOR_IMAGE_LOG)appendFileSync(process.env.FAKE_CURSOR_IMAGE_LOG,JSON.stringify(p.prompt)+'\n');
 saved.prompts.push(text);persist();
 if(process.env.FAKE_CURSOR_LOG)appendFileSync(process.env.FAKE_CURSOR_LOG,JSON.stringify({sid,text,model,effort,context,fast,mode,pid:process.pid})+'\n');
 if(text==='disconnect'){say('PRIMEIRA PARTE');process.exit(1);}
 if(text==='mismatch'){emit({method:'session/update',params:{sessionId:'different',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'wrong'}}}});return;}
 if(text==='hold'){say('A trabalhar…');holding=m.id;return;}
 if(text==='echo-secret'){const key=process.env.CURSOR_API_KEY;say(key.slice(0,8));say(key.slice(8));done(m.id);return;}
 if(text==='partial-secret'){say(process.env.CURSOR_API_KEY.slice(0,15));process.exit(1);}
 if(text==='permission'||text==='permission-first'){
  const toolCallId='tool-'+(++count);
  if(text!=='permission-first')update({sessionUpdate:'tool_call',toolCallId,kind:'execute',title:'python3 approved.txt',status:'in_progress',rawInput:{command:'python3 approved.txt'}});
  request('session/request_permission',{sessionId:sid,toolCall:{toolCallId,title:'python3 approved.txt',kind:'execute'},options:[{optionId:'native-allow',name:'Allow',kind:'allow_once'},{optionId:'native-reject',name:'Reject',kind:'reject_once'}]},reply=>{
   const choice=reply.result?.outcome;
   if(choice?.outcome==='cancelled'){done(m.id,'cancelled');return;}
   const allowed=choice?.optionId==='native-allow';
   if(text==='permission-first')update({sessionUpdate:'tool_call',toolCallId,kind:'execute',title:'python3 approved.txt',status:'in_progress',rawInput:{command:'python3 approved.txt'}});
   if(allowed)writeFileSync(path.join(cwd,'approved.txt'),'APPROVED');
   update({sessionUpdate:'tool_call_update',toolCallId,status:allowed?'completed':'failed',content:[{type:'content',content:{type:'text',text:allowed?'ok':'Permission denied'}}],rawOutput:{exitCode:allowed?0:1}});
   say(allowed?'PERMITIDO':'RECUSADO');done(m.id);
  });return;
 }
 if(text==='question'){
  request('cursor/ask_question',{title:'Escolhe',questions:[{id:'q',prompt:'Qual opção?',options:[{id:'a',label:'Opção A'},{id:'b',label:'Opção B'}]}]},reply=>{
   const out=reply.result?.outcome;if(out?.outcome==='cancelled'){done(m.id,'cancelled');return;}
   say('ESCOLHIDA-'+out.answers[0].selectedOptionIds.join(','));done(m.id);
  });return;
 }
 if(text==='plan'){
  request('cursor/create_plan',{name:'Plano de teste',plan:'1. Rever\n2. Executar',todos:[]},reply=>{say('PLANO-'+reply.result?.outcome.outcome);done(m.id);});return;
 }
 if(text==='unsupported'){
  request('fs/write_text_file',{path:'/not-allowed',content:'NO'},reply=>{say('UNSUPPORTED-'+reply.error?.code);done(m.id);});return;
 }
 if(text==='edit'||text==='edit-split'){
  const toolCallId='edit-'+(++count);writeFileSync(path.join(cwd,'edited.txt'),'EDITED');
  update({sessionUpdate:'tool_call',toolCallId,kind:'edit',title:'Edit edited.txt',status:text==='edit-split'?'in_progress':'completed',...(text==='edit' ? {locations:[{path:'edited.txt'}]} : {}),content:[{type:'diff',path:'edited.txt',oldText:null,newText:'EDITED'}]});
  if(text==='edit-split')update({sessionUpdate:'tool_call_update',toolCallId,status:'completed'});
 }
 if(text==='many')for(let i=0;i<205;i++)update({sessionUpdate:'tool_call',toolCallId:'cmd-'+i,kind:'execute',title:'command-'+i,status:'completed',rawInput:{command:'command-'+i},rawOutput:{exitCode:0}});
 update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'PRIVATE-THOUGHT'}});
 const answer=text.startsWith('[HYDRAQ · pedido interno')?'RESUMO-CURSOR':`Resposta ${saved.prompts.length} ${model} ${effort} ${context} fast=${fast} mode=${mode} contexto=${text.includes('<hydraq_handoff>')}`;
 say(answer);done(m.id);
});
