// Temporary private server; creates empty sessions and switches agents, never requests inference.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {OpenCode} from '../lib/opencode.mjs';
import {OpenCodeRuntime} from '../lib/opencode-runtime.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(predicate){
  const deadline=Date.now()+15_000;
  while(!predicate()){if(Date.now()>deadline)throw Error('Tempo excedido no ensaio OpenCode.');await sleep(20);}
}
const root=await mkdtemp('/tmp/hydraq-opencode-efficiency-live-');await mkdir(root+'/project');
const runtime=new OpenCodeRuntime({directory:root+'/native',executable:process.env.HYDRAQ_OPENCODE_BIN||'/home/sauron/.opencode/bin/opencode',manifest:false,minimumSettleMs:0});
const client=new OpenCode({dataDir:root+'/state',defaultCwd:root+'/project',runtime});
const api=runtime.api.bind(runtime),history=runtime.history.bind(runtime),reads=[];let modelRequests=0;
runtime.api=async(route,options={})=>{
  if(options.method==='POST'&&/\/(?:prompt|generate|command|shell|skill)(?:\?|$)/.test(route)){modelRequests++;throw Error('Inferência proibida neste ensaio.');}
  return api(route,options);
};
runtime.history=async id=>{reads.push(id);return history(id);};
const quiet=()=>wait(()=>!client.eventTimer&&!client.eventFlush&&!client.syncing.size&&!client.settleTimers.size);
try{
  await client.load();await client.connect();const conversations=[];
  for(let index=0;index<2;index++){
    const c=await client.create({cwd:root+'/project',model:client.models[0].id});
    await client.prepare(c,client.validateSettings(c),null);await client.sync(c);conversations.push(c);
  }
  await quiet();await sleep(350);await quiet();reads.length=0;
  await sleep(6200);await quiet();assert.equal(reads.length,0);
  const idleReads=reads.length,[a,b]=conversations;
  await runtime.api('/api/session/'+a.threadId+'/agent',{method:'POST',body:{agent:'plan'}});
  await runtime.api('/api/session/'+a.threadId+'/agent',{method:'POST',body:{agent:'build'}});
  await wait(()=>reads.length>0);await quiet();await sleep(350);await quiet();
  assert.deepEqual(reads,[a.threadId]);const batchedReads=reads.length;
  client.isArchived=c=>c.id===b.id;reads.length=0;client.lastIdleSweep=Date.now()-60_001;
  await client.sweep();assert.deepEqual(reads,[a.threadId]);const periodicReads=reads.length;
  reads.length=0;client.eventAbort.abort();
  await wait(()=>reads.length>=2&&client.eventState==='connected');await quiet();
  assert.deepEqual(new Set(reads),new Set([a.threadId,b.threadId]));
  assert.ok(conversations.every(c=>c.nativeHistory.status==='complete'&&c.messages.length===0&&c.turns.length===0));
  assert.equal(modelRequests,0);
  console.log(JSON.stringify({version:(await runtime.api('/api/info')).version,idleSeconds:6.2,idleReads,batchedAgentChangeReads:batchedReads,periodicUnarchivedReads:periodicReads,reconnectIncludesArchived:true,modelRequests,passed:true}));
}finally{await client.close();await rm(root,{recursive:true,force:true});}
