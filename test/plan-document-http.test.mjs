import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {Providers} from '../lib/providers.mjs';
import {OpinionClient} from './fixtures/opinion-client.mjs';
import {createHttpServer} from '../lib/http.mjs';
const wait=async f=>{const end=Date.now()+5000;while(!f()){if(Date.now()>end)throw Error('Timeout');await new Promise(r=>setTimeout(r,10));}};
test('pedido HTTP autenticado acima de 650 KB chega inteiro ao cliente; conteúdo de plano exige sessão e conversa correta',async t=>{
 const directory=await mkdtemp('/tmp/hydraq-text-http-'),client=new OpinionClient('codex',directory+'/codex');
 const hub=new Providers({dataDir:directory+'/hub',defaultCwd:directory,clients:{codex:client},git:async()=>[]});await hub.load();const c=await client.create({cwd:directory,model:'test',effort:'low',sandbox:'read-only'});
 client.readPlanDocument=async(id,documentId)=>{assert.equal(id,c.id);assert.equal(documentId,'11111111-1111-1111-1111-111111111111');return {id:documentId,name:'Plano',text:'Plano completo',path:directory+'/plan.md'};};
 const server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeStreams();await new Promise(r=>server.close(r));await hub.close();await rm(directory,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port,{token}=await (await fetch(base+'/api/bootstrap',{headers:{'x-hydraq-bootstrap':'1'}})).json();const text='Ü'.repeat(400000)+'TEXT-END';
 const sent=await fetch(base+'/api/conversations/'+c.id+'/send',{method:'POST',headers:{'content-type':'application/json','x-hydraq-token':token},body:JSON.stringify({text,requestId:'large-request'})});assert.equal(sent.status,200);await wait(()=>c.status==='completed');assert.equal(client.logs[0].text,text);
 const route='/api/conversations/'+c.id+'/plan-documents/11111111-1111-1111-1111-111111111111';assert.equal((await fetch(base+route)).status,403);const read=await fetch(base+route,{headers:{'x-hydraq-token':token}});assert.equal(read.status,200);assert.equal((await read.json()).text,'Plano completo');assert.equal((await fetch(base+'/api/conversations/unknown/plan-documents/11111111-1111-1111-1111-111111111111',{headers:{'x-hydraq-token':token}})).status,400);
});
