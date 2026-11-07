import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {EventEmitter, once} from 'node:events';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {createHttpServer} from '../lib/http.mjs';
import {ClaudeX} from '../lib/claudex.mjs';

function fixture() {
  const cx = new ClaudeX({hub: {}});
  cx.kick = () => {};
  cx.native = () => ({status:'running'});
  const record = {
    id:'task', status:'discussing', author:'codex', roles:['codex','claude'],
    members:{codex:{requestId:'turn'},claude:{requestId:'review'}},
    workflow:{phase:'planning',tests:[]}, candidates:[], ready:{}, evidenceRevision:1, revision:1,
    messages:[{seq:1,from:'codex',type:'question',text:'Dúvida'}],
  };
  const lease = {role:'codex',config:{names:['wait_for_reply']},controller:new AbortController(),waits:new Map()};
  return {cx,record,lease,wait:timeoutMs=>cx.waitForReply(record,lease,{seq:1,timeoutMs})};
}

test('expirar conserva a pergunta e a resposta posterior acorda a segunda espera', async () => {
  const {cx,record,wait} = fixture();
  assert.equal((await wait(5)).status,'pending');
  const pending = wait(1000);
  record.messages.push({seq:2,from:'claude',replyTo:1,text:'Resposta'});
  record.messages[0].resolution = {seq:2};
  cx.emit('state');
  assert.deepEqual(await pending,{status:'answered',seq:1,reply:{seq:2,from:'claude',text:'Resposta'}});
  assert.equal(cx.listenerCount('state'),0);
});

test('cancelamento HTTP e revogação libertam a espera e recusam espera em fecho', async () => {
  const {cx,record,lease,wait} = fixture();
  const http = new AbortController();
  const pending = cx.waitForReply(record,lease,{seq:1,timeoutMs:30_000},http.signal);
  http.abort();
  await assert.rejects(pending,{name:'AbortError'});
  const revoked = wait(30_000);
  cx.disposeLease({controller:lease.controller,config:{file:'/dev/null/hydraq-test'}});
  await assert.rejects(revoked,{name:'AbortError'});
  assert.equal(cx.listenerCount('state'),0);
  cx.turnClosing.set('task:codex',{requestId:'turn'});
  await assert.rejects(wait(1000),/ready_to_conclude/);
});

test('apenas três esperas por pergunta', async () => {
  const {wait} = fixture();
  for(let i=0;i<3;i++)assert.equal((await wait(1)).status,'pending');
  assert.equal((await wait(1)).status,'limit');
});

test('cancelamento MCP fecha a espera HTTP e devolve o lugar à ponte', {timeout:10_000}, async t => {
  const hub = new EventEmitter();
  const started = new EventEmitter();
  hub.claudex = {
    endpoint() {},
    async tool(_token, _name, args, signal) {
      started.emit('call');
      if (!args.wait) return {ok:true};
      try { await delay(30_000, null, {signal}); }
      finally { started.emit('released'); }
    },
  };
  const server = createHttpServer({hydraq:hub,publicDir:'.'});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const dir = await mkdtemp('/tmp/hydraq-wait-bridge-test-');
  const lease = dir+'/lease.json';
  await writeFile(lease,JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/api/claudex/tools',token:'a'.repeat(64),tools:[{name:'wait_for_reply'}]}),{mode:0o600});
  const child = spawn(process.execPath,[fileURLToPath(new URL('../lib/claudex-mcp-server.mjs',import.meta.url))],{env:{...process.env,HYDRAQ_CLAUDEX_LEASE:lease}});
  const lines = createInterface({input:child.stdout});
  t.after(async () => {
    lines.close();child.kill();server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));await rm(dir,{recursive:true,force:true});
  });
  const send = msg => child.stdin.write(JSON.stringify({jsonrpc:'2.0',...msg})+'\n');
  for(let id=1;id<=5;id++){
    const accepted=once(started,'call',{signal:AbortSignal.timeout(1000)});
    send({id,method:'tools/call',params:{name:'wait_for_reply',arguments:{wait:true}}});
    await accepted;
    const released=once(started,'released',{signal:AbortSignal.timeout(1000)});
    send({method:'notifications/cancelled',params:{requestId:id}});
    await released;
  }
  const result=once(lines,'line',{signal:AbortSignal.timeout(1000)});
  send({id:6,method:'tools/call',params:{name:'wait_for_reply',arguments:{}}});
  const [line]=await result;
  assert.equal(JSON.parse(line).id,6);
  assert.deepEqual(JSON.parse(JSON.parse(line).result.content[0].text),{ok:true});
});
