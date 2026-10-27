import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,symlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Providers} from '../lib/providers.mjs';
import {OpinionArchive} from '../lib/opinion-archive.mjs';
import {OpinionClient} from './fixtures/opinion-client.mjs';
import {createHttpServer} from '../lib/http.mjs';

const wait=async f=>{const end=Date.now()+8000;while(!f()){if(Date.now()>end)throw Error('Timeout');await new Promise(r=>setTimeout(r,10));}};
const config={trigger:'all',scope:'request',returnToPrincipal:true,participant:{provider:'claude',model:'test',effort:'low'},focus:''};
async function setup(t){
 const root=await mkdtemp('/tmp/hydraq-archive-test-');
 const clients=Object.fromEntries(['codex','claude','antigravity','cursor','opencode'].map(p=>[p,new OpinionClient(p,root+'/'+p)]));
 const hub=new Providers({dataDir:root+'/hub',defaultCwd:root,clients,opinionSupervisor:{available:async()=>({available:true}),stop:async()=>{}},opinionClientFactory:async({job,directory,cwd})=>{const client=new OpinionClient(job.provider,directory);await client.load();return{client,cwd,sandbox:'plan'};},git:async()=>null});
 await hub.load();const c=await clients.codex.create({cwd:root,model:'test',effort:'low',sandbox:'read-only'});
 await hub.send(c.id,'Uma pergunta','seed');await wait(()=>c.status==='completed');
 t.after(async()=>{await hub.close();await rm(root,{force:true,recursive:true});});
 return{root,hub,c,main:clients.codex};
}

test('mais de 200 ciclos e 100 pareceres preservam resultados sem bloquear novos pedidos',async t=>{
 const{hub,c}=await setup(t);const body={requestId:'old-review',messageKey:c.messages.at(-1).id,participants:[config.participant]};
 await hub.opinions.create(c.id,body);await wait(()=>!hub.opinions.tasks.size);const first=hub.opinions.batches[0];
 for(let i=0;i<120;i++)hub.opinions.batches.push({...first,id:randomUUID(),requestId:'batch-'+i,createdAt:new Date(Date.now()+i).toISOString(),jobs:first.jobs.map(j=>({...j,id:randomUUID()}))});
 for(let i=0;i<205;i++)hub.automaticReviews.cycles.push({id:randomUUID(),requestId:'cycle-'+i,returnRequestId:'return-'+i,conversationId:c.id,groupId:c.id,settings:{},config,status:'completed',createdAt:new Date(Date.now()+i).toISOString()});
 await hub.opinions.serial(()=>hub.opinions.persist());
 assert.equal(hub.opinions.batches.length,40);assert.equal(hub.automaticReviews.cycles.length,80);
 assert.equal((await hub.opinions.create(c.id,body)).duplicate,true);
 const before=hub.opinions.batches.length;await assert.rejects(hub.opinions.create(c.id,{...body,comment:'Changed'}),/Identificador/);assert.equal(hub.opinions.batches.length,before);
 let cursor='',batches=[],cycles=[];do{const page=await hub.opinions.page(c.id,cursor);assert.ok(page.batches.length+page.cycles.length+page.merges.length<=20);batches.push(...page.batches);cycles.push(...page.cycles);cursor=page.nextCursor;}while(cursor);
 assert.equal(batches.length,81);assert.equal(cycles.length,125);assert.equal(batches.find(b=>b.id===first.id).jobs[0].text,first.jobs[0].text);assert.equal(batches[0].prompt,undefined);
 await hub.send(c.id,'Nova pergunta','after-cap',{autoReview:config});await wait(()=>hub.automaticReviews.cycles.at(-1)?.status==='completed');
 assert.equal(hub.opinions.batches.at(-1).jobs[0].status,'completed');
});

test('recibos de envios arquivados impedem repetição e pareceres antigos continuam utilizáveis',async t=>{
 const{hub,c,main}=await setup(t);await hub.opinions.create(c.id,{requestId:'review',messageKey:c.messages.at(-1).id,participants:[config.participant]});await wait(()=>!hub.opinions.tasks.size);
 const batch=hub.opinions.batches[0],body={requestId:'merge-old',jobIds:[batch.jobs[0].id],settings:{model:'test',effort:'low',sandbox:'read-only'}};
 await hub.opinions.incorporate(c.id,body);await wait(()=>c.status==='completed');
 const merge=hub.opinions.merges[0];await hub.opinions.archive.put('batches',batch,c.id);await hub.opinions.archive.put('merges',merge,c.id);hub.opinions.batches=[];hub.opinions.merges=[];await hub.opinions.persist();
 assert.equal((await hub.opinions.incorporate(c.id,body)).duplicate,true);assert.equal(main.logs.length,2);
 await hub.opinions.incorporate(c.id,{...body,requestId:'new-explicit-import'});await wait(()=>c.status==='completed');assert.equal(main.logs.length,3);
 const other=await main.create({cwd:c.cwd,model:'test',effort:'low',sandbox:'read-only'});await assert.rejects(hub.opinions.incorporate(other.id,{...body,requestId:'wrong-group'}),/desta conversa/);
});

test('arquivo roda também por tamanho, sem eliminar pareceres ou ultrapassar o orçamento ativo',async t=>{
 const{hub,c}=await setup(t);const text='x'.repeat(450000);
 for(let i=0;i<22;i++)hub.opinions.batches.push({id:randomUUID(),requestId:'large-'+i,groupId:c.id,conversationId:c.id,createdAt:new Date(Date.now()+i).toISOString(),prompt:text,jobs:[]});
 await hub.opinions.serial(()=>hub.opinions.persist());
 assert.ok((await readFile(hub.opinions.directory+'/state.json')).length<=8_000_000);assert.ok(hub.opinions.batches.length<22);
 const page=await hub.opinions.page(c.id);assert.ok(page.batches.length);assert.equal((await hub.opinions.archive.find('batches','large-0')).prompt.length,text.length);
});

test('revisor indisponível oferece falha anterior ao envio e permite envio explícito sem revisão',async t=>{
 const{hub,c,main}=await setup(t);hub.clients.claude.models=[];
 await assert.rejects(hub.send(c.id,'Pedido conservado','missing-model',{autoReview:config}),e=>e.code==='REVIEW_UNAVAILABLE'&&e.beforeSend===true);
 assert.equal(main.logs.length,1);await hub.send(c.id,'Pedido conservado','missing-model',{autoReview:null});await wait(()=>c.status==='completed');assert.equal(main.logs.length,2);
 hub.opinions.error='Arquivo indisponível';await assert.rejects(hub.send(c.id,'Outro pedido','bad-archive',{autoReview:config}),e=>e.code==='REVIEW_UNAVAILABLE');
 await hub.send(c.id,'Outro pedido','bad-archive',{autoReview:null});await wait(()=>c.status==='completed');assert.equal(main.logs.length,3);
 hub.opinions.error=null;
});

test('recibo corrompido ou pasta simbólica não autoriza repetição nem leitura externa',async t=>{
 const root=await mkdtemp('/tmp/hydraq-archive-security-');t.after(()=>rm(root,{recursive:true,force:true}));const archive=new OpinionArchive(root+'/archive');await archive.load();
 const record={id:randomUUID(),requestId:'r',groupId:randomUUID(),jobs:[],createdAt:new Date().toISOString()};await archive.put('batches',record,record.groupId);
 const restored=new OpinionArchive(root+'/archive');await restored.load();assert.equal((await restored.find('batches','r')).id,record.id);
 await writeFile(root+'/outside.json',JSON.stringify({record}));await symlink(root+'/outside.json',root+'/archive/batches/'+record.groupId+'/bad.json');await assert.rejects(restored.page(record.groupId),/inválido/);
 await assert.rejects(restored.resolve({kind:'batches',groupId:record.groupId,name:'../outside.json'}),/inválido/);
});

test('HTTP distingue revisão indisponível antes do envio e autentica a paginação',async t=>{
 const{hub,c,main}=await setup(t),server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeStreams();server.closeAllConnections();server.close();});
 const base='http://127.0.0.1:'+server.address().port,{token}=await(await fetch(base+'/api/bootstrap',{headers:{'X-HYDRAQ-Bootstrap':'1'}})).json();
 const headers={'Content-Type':'application/json','x-hydraq-token':token};hub.clients.claude.models=[];
 const send=autoReview=>fetch(base+'/api/conversations/'+c.id+'/send',{method:'POST',headers,body:JSON.stringify({text:'Pedido conservado',requestId:'http-no-review',autoReview})});
 const failed=await send(config);assert.equal(failed.status,409);const error=await failed.json();assert.equal(error.code,'REVIEW_UNAVAILABLE');assert.equal(error.beforeSend,true);assert.equal(main.logs.length,1);
 assert.equal((await send(null)).status,200);await wait(()=>c.status==='completed');assert.equal(main.logs.length,2);
 assert.equal((await fetch(base+'/api/conversations/'+c.id+'/opinion-history')).status,403);
 assert.equal((await fetch(base+'/api/conversations/'+c.id+'/opinion-history',{headers})).status,200);
});
