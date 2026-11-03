import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Providers} from '../lib/providers.mjs';
import {DualSessions,memberKeys,targetKeys} from '../lib/dual.mjs';
import {OpinionClient} from './fixtures/opinion-client.mjs';
const ids=['codex','claude','antigravity','cursor','opencode'];
const choice=provider=>({provider,model:'test',effort:'low'});
const wait=async f=>{const end=Date.now()+7000;while(!f()){if(Date.now()>end)throw Error('Timeout');await new Promise(r=>setTimeout(r,10));}};
async function setup(t,n=4){
 const root=await mkdtemp('/tmp/hydraq-multi-'),clients=Object.fromEntries(ids.map(id=>[id,new OpinionClient(id,root+'/'+id,{answer:'ANSWER-'+id})])),runtimes=[];
 const hub=new Providers({dataDir:root+'/hub',defaultCwd:root,clients,git:async()=>[],opinionSupervisor:{available:async()=>({available:true}),stop:async()=>{}},opinionClientFactory:async({job,directory,cwd})=>{const client=new OpinionClient(job.provider,directory,{answer:'SYNTHESIS'});await client.load();runtimes.push(client);return {client,cwd};}});
 await hub.load();const c=await clients.codex.create({cwd:root,model:'test',effort:'low',sandbox:'read-only'});
 const record=(await hub.startDual(c.id,{participants:ids.slice(1,n).map(choice),multiVersion:2})).dual;
 t.after(async()=>{await hub.close();await rm(root,{recursive:true,force:true});});
 const send=(text,extra={})=>hub.sendDual(record.id,{text,requestId:randomUUID(),multiVersion:2,...extra});
 const idle=()=>wait(()=>hub.conversations().every(c=>!['running','starting','waiting'].includes(c.status)));
 const change=(body,remove=false)=>hub.changeDualRoster(record.id,{requestId:randomUUID(),revision:hub.dual.record(record.id).revision,multiVersion:2,...body},remove);
 return {root,hub,clients,c,record,send,idle,change,runtimes};
}
test('Multi: 2, 3 e 4 clientes; valida todos antes de criar e bloqueia páginas antigas',async t=>{
 for(const n of [2,3,4]){const e=await setup(t,n);assert.equal(memberKeys(e.record).length,n);assert.equal(e.clients.claude.logs.length,0);if(n>2){await assert.rejects(e.hub.sendDual(e.record.id,{text:'x',requestId:'old',target:'both'}),/Recarrega/);await assert.rejects(e.send('x',{target:'both'}),/Recarrega/);}assert.deepEqual(targetKeys(e.record,'all'),memberKeys(e.record));await assert.rejects(e.send('x',{target:['a','a']}),/Destinatário/);}
 const e=await setup(t,2);await e.hub.endDual(e.record.id);const before=e.hub.conversations().length;
 await assert.rejects(e.hub.startDual(e.c.id,{participants:[choice('antigravity'),{...choice('cursor'),model:'bad'}]}),/catálogo/);assert.equal(e.hub.conversations().length,before);
 await assert.rejects(e.hub.startDual(e.c.id,{participants:[choice('claude'),choice('claude')]}),/repetir/);
});
test('Multi: quatro respostas independentes, subconjunto e contexto recebido por quem esteve de fora',async t=>{
 const e=await setup(t);await e.send('ROUND-ONE');await e.idle();
 for(const id of ids.slice(0,4)){const log=e.clients[id].logs[0].text;for(const other of ids.slice(0,4).filter(p=>p!==id))assert.ok(!log.includes('ANSWER-'+other));}
 await e.send('ROUND-TWO',{target:['a','c']});await e.idle();assert.equal(e.clients.claude.logs.length,1);assert.equal(e.clients.cursor.logs.length,1);
 assert.match(e.clients.codex.logs[1].text,/ANSWER-claude/);assert.match(e.clients.codex.logs[1].text,/ANSWER-cursor/);
 await e.send('ROUND-THREE',{target:'b'});await e.idle();assert.match(e.clients.claude.logs[1].text,/ROUND-TWO/);assert.match(e.clients.claude.logs[1].text,/ANSWER-antigravity/);
 await assert.rejects(e.send('write',{target:['a','c'],settings:{a:{sandbox:'workspace-write'}}}),/vários modelos/);
 await assert.rejects(e.send('write',{target:'c',settings:{c:{sandbox:'workspace-write'}}}),/principal/);
});
test('Multi: entradas e saídas idempotentes, seleção, principal, histórico e lugares reutilizados',async t=>{
 const e=await setup(t,2);await e.send('OLD');await e.idle();
 const first=e.record.rounds[0],original=structuredClone(first.members),request={...choice('antigravity'),requestId:'add-once',revision:e.record.revision,multiVersion:2};
 await e.hub.changeDualRoster(e.record.id,request);await e.hub.changeDualRoster(e.record.id,request);assert.equal(memberKeys(e.record).length,3);assert.deepEqual(first.members,original);
 await assert.rejects(e.change({...choice('antigravity')}),/já participa/);
 // Failed changes restore the store: always read the current record after a rollback.
 let current=e.hub.dual.record(e.record.id);await e.hub.updateDual(current.id,{target:['a','c'],multiVersion:2});
 await e.change({key:'a',principal:'c'},true);current=e.hub.dual.record(e.record.id);assert.equal(current.principal,'c');assert.equal(current.target,'c');assert.deepEqual(first.members,original);
 await e.change(choice('cursor'));current=e.hub.dual.record(e.record.id);assert.equal(current.members.a.provider,'cursor');assert.equal(current.rounds[0].members.a.provider,'codex');
 const revision=current.revision;await e.change({...choice('opencode'),revision});await assert.rejects(e.change({key:'b',revision},true),/mudou entretanto/);
 current=e.hub.dual.record(e.record.id);assert.equal(memberKeys(current).length,4);
 const loaded=new DualSessions({directory:e.hub.dual.directory,conversations:()=>e.hub.conversations()});await loaded.load();assert.equal(loaded.error,undefined);assert.equal(loaded.records[0].rounds[0].members.a.provider,'codex');assert.equal(JSON.parse(await readFile(e.hub.dual.directory+'/state.json')).version,2);
});
test('Multi: alteração recusada durante uma ronda e principal removido apenas com substituto',async t=>{
 const e=await setup(t,3);e.clients.codex.behavior='hold';await e.send('HOLD');await assert.rejects(e.change(choice('cursor')),/terminem|ronda/);await e.hub.interruptDual(e.record.id);await e.idle();
 await assert.rejects(e.change({key:'a'},true),/principal/);await e.change({key:'a',principal:'b'},true);await assert.rejects(e.change({key:'c'},true),/dois participantes/);
});
test('Multi: falha num de quatro, reenvio só desse e reinício sem duplicar',async t=>{
 const e=await setup(t);e.clients.cursor.behavior='pre-fail';const result=await e.send('FAIL-ONE');await e.idle();assert.deepEqual(result.deliveries,{a:'sent',b:'sent',c:'sent',d:'failed'});
 const round=e.record.rounds.at(-1);e.clients.cursor.behavior='success';await e.hub.retryDual(e.record.id,{roundId:round.id,key:'d'});await e.idle();assert.equal(e.clients.codex.logs.length,1);assert.equal(e.clients.cursor.logs.length,1);assert.doesNotMatch(e.clients.cursor.logs[0].text,/ANSWER-codex/);
 const loaded=new DualSessions({directory:e.hub.dual.directory,conversations:()=>e.hub.conversations()});await loaded.load();assert.equal(loaded.error,undefined);assert.deepEqual(loaded.records[0].rounds[0].targets,['a','b','c','d']);assert.equal(e.clients.cursor.logs.length,1);
});
test('Multi: síntese de subconjunto e parcial identifica todas as respostas ausentes',async t=>{
 const e=await setup(t);e.clients.antigravity.behavior=e.clients.cursor.behavior='pre-fail';await e.send('PARTIAL');await e.idle();const round=e.record.rounds.at(-1);
 const ask={roundId:round.id,requestId:'partial',...choice('claude')};await assert.rejects(e.hub.synthesizeDual(e.record.id,ask),/Antigravity|Gemini/);
 const result=await e.hub.synthesizeDual(e.record.id,{...ask,partial:true});await wait(()=>e.hub.opinions.batches.find(b=>b.id===result.id)?.jobs[0].status==='completed');
 const batch=e.hub.opinions.batches.find(b=>b.id===result.id);assert.deepEqual(batch.missing,['c','d']);assert.match(batch.prompt,/Gemini.*Cursor/);assert.match(batch.prompt,/todas as respostas em falta/);
});
test('Multi: síntese automática espera por todos e conserva texto longo e caracteres escapados',async t=>{
 const e=await setup(t);await e.hub.setDualSynthesis(e.record.id,{auto:true,context:false,...choice('claude')});e.clients.cursor.behavior='hold';await e.send('AUTO');await wait(()=>e.c.status==='completed');assert.equal(e.hub.opinions.batches.length,0);e.clients.cursor.finish(e.clients.cursor.conversations[0],'DONE');await wait(()=>e.hub.opinions.batches[0]?.jobs[0].status==='completed');assert.equal(e.hub.opinions.batches.length,1);
 await e.hub.setDualSynthesis(e.record.id,{auto:false,context:false,...choice('claude')});e.clients.cursor.behavior='success';for(const id of ids.slice(0,4))e.clients[id].answer=id+':'+id[0].repeat(30000);await e.send('LONG');await e.idle();const round=e.record.rounds.at(-1),ask={roundId:round.id,requestId:'long',...choice('claude')};
 const result=await e.hub.synthesizeDual(e.record.id,ask);await wait(()=>e.hub.opinions.batches.find(b=>b.id===result.id)?.jobs[0].status==='completed');const batch=e.hub.opinions.batches.find(b=>b.id===result.id);for(const id of ids.slice(0,4))assert.ok(batch.prompt.includes(id+':'+id[0].repeat(30000)));assert.doesNotMatch(batch.prompt,/Excerto: resposta cortada/);assert.equal(batch.missing.length,0);
 for(const id of ids.slice(0,4))e.clients[id].answer='"\\'.repeat(12000);await e.send('ESCAPED');await e.idle();const escaped=e.hub.dual.record(e.record.id).rounds.at(-1);const quoted=await e.hub.synthesizeDual(e.record.id,{roundId:escaped.id,requestId:'escaped',...choice('claude'),excerpts:true});await wait(()=>e.hub.opinions.batches.find(b=>b.id===quoted.id)?.jobs[0].status==='completed');assert.ok(e.hub.opinions.batches.find(b=>b.id===quoted.id).prompt.length>98000);

});
test('Multi: lê dados Dual v1 e não reenvia entregas incertas após reinício',async t=>{
 const e=await setup(t,2);await e.send('LEGACY');await e.idle();const file=e.hub.dual.directory+'/state.json',saved=JSON.parse(await readFile(file));saved.version=1;saved.records[0].rounds[0].deliveries.a.status='sending';saved.records[0].rounds[0].deliveries.a.requestId='not-confirmed';await writeFile(file,JSON.stringify(saved));const loaded=new DualSessions({directory:e.hub.dual.directory,conversations:()=>e.hub.conversations()});await loaded.load();assert.equal(loaded.error,undefined);assert.equal(loaded.records[0].rounds[0].deliveries.a.status,'uncertain');assert.equal(e.clients.codex.logs.length,1);
});
test('Multi: contexto conserva as respostas completas dos três colegas',async t=>{
 const e=await setup(t);for(const [id,char] of [['claude','B'],['antigravity','C'],['cursor','D']])e.clients[id].answer=char.repeat(24000);await e.send('LONG-PEERS');await e.idle();await e.send('READ-PEERS',{target:'a'});await e.idle();const text=e.clients.codex.logs[1].text;for(const char of ['B','C','D'])assert.ok(text.includes(char.repeat(20000)));const coverage=e.hub.dual.record(e.record.id).rounds.at(-1).deliveries.a.peerCoverage;assert.deepEqual(coverage,{claude:'complete',antigravity:'complete',cursor:'complete'});assert.ok(text.length<=100000);
});
test('Multi: falha de criação não ativa composição parcial e a repetição reutiliza a sessão criada',async t=>{
 const e=await setup(t,2);await e.hub.endDual(e.record.id);const create=e.clients.antigravity.create.bind(e.clients.antigravity);e.clients.antigravity.create=async()=>{throw Error('CREATE-FAILED');};const body={participants:['claude','cursor','antigravity'].map(choice)};await assert.rejects(e.hub.startDual(e.c.id,body),/CREATE-FAILED/);assert.equal(e.hub.dual.activeFor(e.c.group),null);assert.equal(e.clients.cursor.conversations.length,1);assert.equal(e.clients.cursor.logs.length,0);e.clients.antigravity.create=create;const result=await e.hub.startDual(e.c.id,body);assert.equal(memberKeys(result.dual).length,4);assert.equal(e.clients.cursor.conversations.length,1);
});
