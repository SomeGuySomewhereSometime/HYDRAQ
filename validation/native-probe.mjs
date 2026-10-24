// Original TUI/protocol probe. No credentials copied; every inference operation is simulated/refused.
import {mkdir, mkdtemp, writeFile, copyFile, readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {WebSocketServer} from 'ws';
import {CodexClient} from '../lib/codex.mjs';
import {nativeThreadSettings} from '../lib/native-sessions.mjs';

const directory=process.env.NATIVE_PROBE_DIR||await mkdtemp('/tmp/hydraq-tui-probe-');
const home=path.join(directory,'codex-home');await mkdir(home,{recursive:true,mode:0o700});
await writeFile(path.join(home,'config.toml'),'[analytics]\nenabled=false\n[feedback]\nenabled=false\n[tui]\nscreen_reader_detection_done=true\n',{mode:0o600});
await copyFile(path.join(os.homedir(),'.codex/models_cache.json'),path.join(home,'models_cache.json')).catch(()=>{});
const client=new CodexClient({env:{...process.env,CODEX_HOME:home},args:['app-server','--listen','stdio://']});
const nativeCall=client.call.bind(client);client.call=(method,params={},...rest)=>nativeCall(method,method==='initialize'?{...params,capabilities:{experimentalApi:true}}:params,...rest);
await client.start();
const models=(await client.call('model/list',{})).data;
const model=models.find(m=>m.isDefault)||models[0];
const response=await client.call('thread/start',{model:model.model,cwd:directory,ephemeral:true,approvalPolicy:'on-request',sandbox:'read-only'});
const threadId=response.thread.id;
const methods=[],peers=new Set();let active=null;const queue=[];
await writeFile(path.join(directory,'methods.json'),'[]');
const send=(peer,message)=>{if(peer.readyState===1)peer.send(JSON.stringify(message));};
const broadcast=message=>{for(const peer of peers)send(peer,message);};
client.on('notification',broadcast);
const server=http.createServer((req,res)=>{res.writeHead(404);res.end();});
const wss=new WebSocketServer({server});
const socket=path.join(directory,'probe.sock');await new Promise(r=>server.listen(socket,r));
const simulate=(input,origin='tui')=>{
  const id=randomUUID(),user={id:randomUUID(),type:'userMessage',content:input};active={id,status:'inProgress',items:[user],error:null};
  broadcast({method:'thread/status/changed',params:{threadId,status:{type:'active',activeFlags:[]}}});
  broadcast({method:'turn/started',params:{threadId,turn:active}});
  broadcast({method:'item/started',params:{threadId,turnId:id,item:user}});
  broadcast({method:'item/completed',params:{threadId,turnId:id,item:user}});
  if(origin!=='hold')setTimeout(()=>{
    const agent={id:randomUUID(),type:'agentMessage',text:'PROBE_SIMULATED_RESULT',phase:'final_answer'};
    active.items.push(agent);active.status='completed';
    broadcast({method:'item/started',params:{threadId,turnId:id,item:{...agent,text:''}}});
    broadcast({method:'item/agentMessage/delta',params:{threadId,turnId:id,itemId:agent.id,delta:agent.text}});
    broadcast({method:'item/completed',params:{threadId,turnId:id,item:agent}});
    broadcast({method:'turn/completed',params:{threadId,turn:{...active,id,status:'completed'}}});active=null;
    broadcast({method:'thread/status/changed',params:{threadId,status:{type:'idle'}}});
  },200);
  return {turn:active};
};
const reads=new Set(['model/list','config/read','configRequirements/read','experimentalFeature/list','skills/list','hooks/list','plugin/list','collaborationMode/list','app/list','mcpServerStatus/list','thread/read','thread/turns/list','thread/items/list']);
wss.on('connection',peer=>{
  peers.add(peer);peer.on('close',()=>peers.delete(peer));
  peer.on('message',async raw=>{
    const message=JSON.parse(String(raw));if(message.id===undefined)return;
    const {method,params={}}=message;
    methods.push({method,params});await writeFile(path.join(directory,'methods.json'),JSON.stringify(methods,null,2));
    try{
      let result;
      if(method==='initialize')result=client.info;
      else if(method==='account/read')result={account:{type:'chatgpt',email:'probe@example.invalid',planType:'plus'},requiresOpenaiAuth:false};
      else if(method==='account/rateLimits/read')result={rateLimits:null,rateLimitsByLimitId:null};
      else if(method==='thread/resume')result={...response,thread:{...response.thread,turns:[]},initialTurnsPage:params.initialTurnsPage?{data:[],nextCursor:null}:null};
      else if(method==='thread/read')result={thread:{...response.thread,turns:[]}};
      else if(method==='thread/turns/list'||method==='thread/items/list')result={data:[],nextCursor:null};
      else if(method==='thread/list')result={data:[response.thread],nextCursor:null};
      else if(method==='thread/loaded/list')result={data:[threadId]};
      else if(method==='thread/queue/list')result={data:queue,nextCursor:null};
      else if(method==='thread/queue/add'){
        const queuedSubmission={id:randomUUID(),threadId,input:params.input,clientUserMessageId:params.clientUserMessageId,createdAt:Date.now(),updatedAt:Date.now()};queue.push(queuedSubmission);result={queuedSubmission};
        broadcast({method:'thread/queue/changed',params:{threadId}});
      }
      else if(method==='thread/settings/update'){
        if(Object.entries(params).some(([k,v])=>v!=null&&!['threadId','model','effort','collaborationMode'].includes(k)))throw Error('Probe: unsupported settings');
        if(params.collaborationMode&&(params.collaborationMode.mode!=='default'||params.collaborationMode.settings?.developer_instructions!=null))throw Error('Probe: unsupported collaboration mode');
        // PROBE_SETTINGS=hydraq answers as HYDRAQ's adapter does (its private executor has no experimental
        // API): empty result, then thread/settings/updated built by the production function.
        if(process.env.PROBE_SETTINGS==='hydraq'){
          const chosen={cwd:directory,sandbox:'read-only',model:params.collaborationMode?.settings?.model??params.model??model.model,effort:params.collaborationMode?params.collaborationMode.settings?.reasoning_effort??null:params.effort??null};
          result={};setImmediate(()=>broadcast({method:'thread/settings/updated',params:{threadId,threadSettings:nativeThreadSettings(chosen)}}));
        }else result=await client.call(method,params);
      }
      else if(method==='config/batchWrite'){
        if(params.edits?.length!==1||params.edits[0].keyPath!=='projects.'+JSON.stringify(directory)+'.trust_level')throw Error('Probe: trust is limited to its temporary directory');
        result=await client.call(method,params);
      }
      else if(method==='turn/start')result=simulate(params.input,'hold');
      else if(method==='turn/steer')result={turnId:active?.id};
      else if(method==='turn/interrupt'){if(active)broadcast({method:'turn/completed',params:{threadId,turn:{...active,status:'interrupted'}}});active=null;result={};}
      else if(method==='thread/unsubscribe')result={status:'unsubscribed'};
      else if(reads.has(method))result=await client.call(method,params);
      else throw Error('Probe: operation refused (no model calls): '+method);
      send(peer,{id:message.id,result});
    }catch(error){send(peer,{id:message.id,error:{code:-32000,message:error.message}});}
  });
});
await writeFile(path.join(directory,'info.json'),JSON.stringify({pid:process.pid,directory,home,socket,threadId,model:model.model,models:models.map(m=>({model:m.model,name:m.displayName})),version:client.info.userAgent}));
console.log(JSON.stringify({directory,threadId,model:model.model}));
// Local test commands inject a turn or disconnect peers; they never reach the real executor.
let commandAt=0;
const timer=setInterval(async()=>{try{const command=JSON.parse(await readFile(path.join(directory,'control.json'),'utf8'));if(command.at===commandAt)return;commandAt=command.at;if(command.action==='external')simulate([{type:'text',text:'PROBE_OTHER_INTERFACE',text_elements:[]}]);if(command.action==='complete'&&active){broadcast({method:'turn/completed',params:{threadId,turn:{...active,status:'completed'}}});active=null;}if(command.action==='settings')await client.call('thread/settings/update',{threadId,model:'gpt-6-luna',effort:'low'});if(command.action==='disconnect')for(const peer of peers)peer.close();}catch{}},100);
async function close(){clearInterval(timer);for(const peer of peers)peer.terminate();wss.close();server.close();await client.stop();}
process.on('SIGTERM',()=>close());process.on('SIGINT',()=>close());
