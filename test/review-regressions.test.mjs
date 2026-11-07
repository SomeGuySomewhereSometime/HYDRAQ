import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexClient } from '../lib/codex.mjs';
import { Hydraq } from '../lib/hydraq.mjs';
import { ClaudeCode, claudeTurnUsage } from '../lib/claude.mjs';
import { Antigravity } from '../lib/antigravity.mjs';
import { Cursor } from '../lib/cursor.mjs';
import { CursorRpc } from '../lib/cursor-rpc.mjs';
import { Providers } from '../lib/providers.mjs';
import { createHttpServer } from '../lib/http.mjs';
import { buildHandoff, unseenTurns } from '../lib/handoff.mjs';
import { turnFacts } from '../lib/turn-facts.mjs';
import { writeHistory } from '../lib/state-store.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const waitFor=async fn=>{const until=Date.now()+6000;while(!fn()){if(Date.now()>until)throw Error('Tempo excedido.');await new Promise(r=>setTimeout(r,10));}};
async function directory(t){const dir=await mkdtemp(path.join(os.tmpdir(),'hydraq-review-regression-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const optionalRead=file=>readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
async function setup(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'hydraq-review-regression-')),state=path.join(dir,'state'),auth=path.join(dir,'auth');await mkdir(auth,{mode:0o700});
  const credentialFile=path.join(auth,'cursor.env');await writeFile(credentialFile,'CURSOR_API_KEY=FAKE-REVIEW-SECRET\n',{mode:0o600});
  const executable=process.execPath,fixture=id=>[path.join(root,`test/fixtures/fake-${id}.mjs`)];
  const codexLog=path.join(dir,'codex.log'),cursorLog=path.join(dir,'cursor.log');
  const clients={
    codex:new Hydraq({dataDir:state,defaultCwd:dir,modelMetadataPath:path.join(dir,'unused-models.json'),client:new CodexClient({executable,args:fixture('codex'),env:{...process.env,FAKE_CODEX_LOG:codexLog}})}),
    claude:new ClaudeCode({dataDir:path.join(state,'claude'),defaultCwd:dir,executable,prefixArgs:fixture('claude')}),
    antigravity:new Antigravity({dataDir:path.join(state,'antigravity'),defaultCwd:dir,executable,prefixArgs:fixture('agy'),settingsFile:path.join(dir,'unused-settings.json')}),
    cursor:new Cursor({dataDir:path.join(state,'cursor'),defaultCwd:dir,executable,prefixArgs:fixture('cursor'),credentialFile,env:{...process.env,FAKE_CURSOR_LOG:cursorLog}}),
  };
  const hub=new Providers({clients,git:async()=>null,inspect:async()=>({files:{},complete:true,warnings:[]})});await hub.load();
  t.after(async()=>{try{await hub.close();await new Promise(r=>setTimeout(r,60));}finally{await rm(dir,{recursive:true,force:true});}});
  const create=async provider=>{await hub.connect(provider);return clients[provider].create({cwd:dir,model:{codex:'gpt-test',claude:'haiku',antigravity:'gemini-4-argon',cursor:'grok-4.7'}[provider],effort:'low'});};
  const nativeLog=(provider,chat)=>optionalRead(provider==='codex'?codexLog:provider==='cursor'?cursorLog:path.join(dir,`.fake-${provider==='antigravity'?'agy':'claude'}-last-${chat.threadId}`));
  return {dir,clients,hub,create,nativeLog};
}

for(const provider of ['codex','claude','antigravity','cursor'])test(`Parar ${provider} antes do envio cancela pedidos frios e aquecidos sem inferência`,async t=>{
  const {clients,create,nativeLog}=await setup(t),client=clients[provider],chat=await create(provider);
  for(const warm of [false,true]){
    if(warm){await client.send(chat.id,'primeiro',`${provider}-warm`);await waitFor(()=>chat.status==='completed');}
    const before=await nativeLog(provider,chat),persist=client.persist.bind(client);
    let release,entered=false;const gate=new Promise(r=>release=r);
    client.persist=async()=>{if(!entered){entered=true;await gate;}return persist();};
    const sending=client.send(chat.id,'NAO-ENVIAR',`${provider}-cancel-${warm}`);
    try{
      await waitFor(()=>entered);assert.equal((await client.interrupt(chat.id)).requested,true);release();
      assert.equal((await sending).interrupted,true);assert.equal(chat.status,'interrupted');
      assert.equal(await nativeLog(provider,chat),before);
    }finally{release();client.persist=persist;await sending.catch(()=>{});}
  }
});

test('HTTP mantém UTF-8 entre blocos e aceita pedidos Unicode dentro do limite de caracteres',async t=>{
  const hub=new EventEmitter();let received;hub.snapshot=()=>({conversations:[],approvals:[]});hub.send=async(_id,text)=>{received=text;return {accepted:true};};
  const server=createHttpServer({hydraq:hub,publicDir:path.join(root,'public')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeStreams();server.close();});const port=server.address().port,url=`http://127.0.0.1:${port}`;
  const {token}=await (await fetch(url+'/api/bootstrap',{headers:{'X-HYDRAQ-Bootstrap':'1'}})).json();
  const status=await new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path:'/api/conversations/c/send',method:'POST',headers:{'content-type':'application/json','x-hydraq-token':token}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);
    req.write(Buffer.concat([Buffer.from('{"text":"Ol'),Buffer.from([0xc3])]));
    setTimeout(()=>req.end(Buffer.concat([Buffer.from([0xa1]),Buffer.from('","requestId":"utf8"}')])),40);
  });assert.equal(status,200);assert.equal(received,'Olá');
  const text='漢'.repeat(100000);const response=await fetch(url+'/api/conversations/c/send',{method:'POST',headers:{'content-type':'application/json','x-hydraq-token':token},body:JSON.stringify({text,requestId:'large-unicode'})});
  assert.equal(response.status,200);assert.equal(received,text);
});

test('ACP inválido rejeita a chamada e encerra o processo mesmo se ignorar SIGTERM',async t=>{
  const dir=await directory(t);
  const peer="process.on('SIGTERM',()=>{});require('node:readline').createInterface({input:process.stdin}).on('line',s=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(s).id})+'\\n'));process.stderr.write('ready\\n');";
  const rpc=new CursorRpc({executable:process.execPath,args:['-e',peer,'--'],cwd:dir,env:process.env,secret:'FAKE-ONLY'});t.after(()=>rpc.close());
  // Wait for startup so this checks malformed ACP, rather than cold-start scheduling.
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('FIXTURE-NÃO-ARRANCOU')),5000);rpc.child.stderr.once('data',()=>{clearTimeout(timer);resolve();});rpc.child.once('error',reject);});
  await assert.rejects(Promise.race([rpc.call('initialize',{},1000),new Promise((_,reject)=>setTimeout(()=>reject(Error('PROMESSA-PENDURADA')),3000))]),/Resposta ACP sem resultado/);
  await rpc.closed;assert.equal(rpc.child.signalCode,'SIGKILL');assert.equal(rpc.pending.size,0);
});

test('Cursor preserva diff após completed parcial e recusa anterior ao evento de ferramenta',async t=>{
  const {clients,create}=await setup(t),c=await create('cursor'),client=clients.cursor;
  await client.send(c.id,'edit-split','edit');await waitFor(()=>c.status==='completed');
  const item=c.items.find(i=>i.type==='fileChange');assert.equal(item.changes[0].diff,'EDITED');assert.deepEqual(turnFacts(c,c.turns.at(-1)).files,['edited.txt']);
  await client.send(c.id,'permission-first','deny');await waitFor(()=>c.status==='waiting');
  await client.respond(client.snapshot().approvals[0].id,{optionId:'native-reject'});await waitFor(()=>c.status==='completed');
  assert.equal(c.items.findLast(i=>i.type==='commandExecution').status,'declined');assert.equal(turnFacts(c,c.turns.at(-1)).declined,1);
});

test('Claude regista ferramentas de subagentes sem copiar o texto deles para a conversa',async t=>{
  const {clients,create}=await setup(t),c=await create('claude'),client=clients.claude;
  await client.send(c.id,'subagent-tools','children');await waitFor(()=>c.status==='completed');
  const facts=turnFacts(c,c.turns[0]);assert.deepEqual(facts.files,['child.txt']);assert.equal(facts.commands[0].command,'echo child');
  assert.ok(c.items.find(i=>i.id==='child-write').parentToolUseId);assert.ok(!JSON.stringify(c.messages).includes('CHILD-TEXT-NOT-PUBLIC'));
  assert.equal(claudeTurnUsage({}),null);assert.equal(claudeTurnUsage({input_tokens:10}),null);
  assert.equal(claudeTurnUsage({input_tokens:10,output_tokens:0}).inputTokens,10);
});

test('Claude com retoma inexistente falha antes do envio e não bloqueia a sessão como incerta',async t=>{
  const {clients,create,dir}=await setup(t),c=await create('claude'),client=clients.claude;
  await client.send(c.id,'primeiro','first');await waitFor(()=>c.status==='completed');
  await rm(path.join(dir,`.fake-claude-${c.threadId}`));
  await assert.rejects(client.send(c.id,'NAO-EXECUTAR','missing',{effort:'high'}),/No conversation found/);
  assert.equal(c.status,'failed');assert.equal(c.turns.at(-1).delivery,'preparing');assert.equal(client.session,null);
});

test('histórico inválido isola um cliente e nunca é substituído ao encerrar o HYDRAQ',async t=>{
  const dir=await directory(t),bad=path.join(dir,'bad'),good=path.join(dir,'good');await mkdir(bad);await writeFile(path.join(bad,'state.json'),'{invalid');
  const claude=new ClaudeCode({dataDir:good,defaultCwd:dir,executable:process.execPath,prefixArgs:[path.join(root,'test/fixtures/fake-claude.mjs')]});
  const cursor=new Cursor({dataDir:bad,defaultCwd:dir});const hub=new Providers({clients:{claude,cursor}});
  await hub.load();await hub.connect('claude');assert.equal(hub.snapshot().providers.claude.connection,'connected');
  assert.match(hub.snapshot().providers.cursor.connectionError,/ficheiros foram preservados/);await assert.rejects(hub.connect('cursor'),/histórico do Cursor/);
  await hub.close();assert.equal(await readFile(path.join(bad,'state.json'),'utf8'),'{invalid');
});

test('gravação guarda uma cópia privada válida e recusa substituir um original inválido',async t=>{
  const dir=await directory(t),one=JSON.stringify({conversations:[{id:'old'}]}),two=JSON.stringify({conversations:[{id:'new'}]});
  await writeHistory(dir,one);await writeHistory(dir,two);
  const backup=path.join(dir,'state.json.previous');assert.equal(await readFile(backup,'utf8'),one);assert.equal((await stat(backup)).mode&0o777,0o600);
  await utimes(backup,new Date(0),new Date(0));await writeFile(path.join(dir,'state.json'),'{broken');
  await assert.rejects(writeHistory(dir,two));assert.equal(await readFile(path.join(dir,'state.json'),'utf8'),'{broken');assert.equal(await readFile(backup,'utf8'),one);
});

test('recuperação antiga conserva revisão explícita e só confirma entrega quando o pedido termina',async t=>{
  const {clients,hub,create}=await setup(t),source=await create('codex');await hub.connect('claude');
  const original='RESTRICAO-ORIGINAL '+ 'x'.repeat(45000);await hub.send(source.id,original,'large');await waitFor(()=>source.status==='completed');
  const target=await create('claude');target.group=source.group||source.id;
  const pending=target.handoffRecovery={id:'legacy-recovery',status:'required',keys:[source.id+':large']};
  assert.equal(pending.status,'required');assert.equal(target.turns.length,0);
  await assert.rejects(hub.reviewHandoff(target.id,{expectedRecoveryId:'old',summary:'x'}),/passagem mudou/);
  await hub.reviewHandoff(target.id,{expectedRecoveryId:pending.id,summary:'Objetivo e restrição revistos: preservar auth.js. Trabalho ainda por verificar.'});
  assert.equal(unseenTurns(target,[source,target]).length,1);assert.equal(target.handoffDeliveries,undefined);assert.equal(source.messages[0].text,original);
  await hub.send(target.id,'continua','handoff');await waitFor(()=>target.status==='completed');
  assert.equal(unseenTurns(target,[source,target]).length,0);assert.match(target.messages[0].handoffContext,/Resumo revisto pelo utilizador/);
  assert.match(target.messages[0].handoffContext,/preservar auth.js/);assert.ok(!target.messages[0].handoffContext.includes('x'.repeat(100)));
  await hub.send(source.id,'NOVA RESTRICAO: manter cache.js','new');await waitFor(()=>source.status==='completed');
  const context=buildHandoff({target,members:[source,target],git:null});assert.match(context.text,/NOVA RESTRICAO/);
});

test('revisão de contexto não apaga avisos de resultado incerto nem confirma entrega',()=>{
  const source={id:'s',provider:'cursor',status:'uncertain',items:[],messages:[{role:'user',requestId:'r',text:'x'.repeat(45000)}],turns:[{requestId:'r',status:'uncertain'}],uncertaintyReview:{requestIds:['r']}};
  const target={id:'t',cwd:'/p',turns:[],handoffReviews:[{keys:['s:r:uncertain'],text:'Resumo escolhido pelo utilizador'}]};
  const context=buildHandoff({target,members:[source,target],git:null});assert.match(context.text,/RESULTADO POR CONFIRMAR/);assert.match(context.text,/não confirma a conclusão/);assert.deepEqual(context.keys,['s:r:uncertain']);
});

test('atalho resolve Claude/Cursor sem depender do PATH gráfico e remove a chave herdada',async t=>{
  const dir=await directory(t),scripts=path.join(dir,'scripts'),bin=path.join(dir,'bin'),home=path.join(dir,'home'),local=path.join(home,'.local/bin');
  await Promise.all([mkdir(scripts),mkdir(bin),mkdir(local,{recursive:true})]);
  const launch=path.join(scripts,'launch.sh');await writeFile(launch,await readFile(path.join(root,'scripts/launch.sh')),{mode:0o700});
  for(const name of ['codex','agy','claude','agent','cursor-agent'])await writeFile(path.join(local,name),'#!/bin/sh\nexit 0\n',{mode:0o700});
  await writeFile(path.join(bin,'node'),'#!/bin/sh\ncat >/dev/null\n',{mode:0o700});
  await writeFile(path.join(bin,'curl'),'#!/bin/sh\nprintf \'{"app":"HYDRAQ"}\'\n',{mode:0o700});
  const capture=path.join(dir,'capture');await writeFile(path.join(bin,'xdg-open'),'#!/bin/sh\nprintf "%s\\n" "$HYDRAQ_CLAUDE_BIN" "$HYDRAQ_CURSOR_BIN" "${CURSOR_API_KEY:-ABSENT}" > "$HYDRAQ_TEST_CAPTURE"\n',{mode:0o700});
  execFileSync('/bin/bash',[launch],{env:{...process.env,HOME:home,PATH:`${bin}:/usr/bin:/bin`,HYDRAQ_CLAUDE_BIN:'',HYDRAQ_CURSOR_BIN:'',HYDRAQ_TEST_CAPTURE:capture,CURSOR_API_KEY:'FAKE-INHERITED'},timeout:5000});
  assert.deepEqual((await readFile(capture,'utf8')).trim().split('\n'),[path.join(local,'claude'),path.join(local,'cursor-agent'),'ABSENT']);
});
