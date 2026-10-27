import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Providers} from '../lib/providers.mjs';
import {SYNTHESIS_INPUT} from '../lib/opinions.mjs';
import {OpinionClient} from './fixtures/opinion-client.mjs';
import {createHttpServer} from '../lib/http.mjs';
const wait=async f=>{const end=Date.now()+7000;while(!f()){if(Date.now()>end)throw Error('Timeout');await new Promise(r=>setTimeout(r,10));}};
const idle=c=>!['starting','running','waiting'].includes(c.status);
const SYNTH={provider:'antigravity',model:'test',effort:'low'};

// Dual Codex + Claude with simulated clients; the synthesis runs in its own simulated runtime, as a second opinion does.
async function setup(t){
 const root=await mkdtemp('/tmp/hydraq-synthesis-test-');
 const clients={codex:new OpinionClient('codex',root+'/codex'),claude:new OpinionClient('claude',root+'/claude'),antigravity:new OpinionClient('antigravity',root+'/agy'),cursor:new OpinionClient('cursor',root+'/cursor'),opencode:new OpinionClient('opencode',root+'/oc')};
 const runtimes=[],control={behavior:'success',answer:'SINTESE-FINAL'};
 const make=()=>new Providers({dataDir:root+'/hub',defaultCwd:root,clients,opinionSupervisor:{available:async()=>({available:true}),stop:async()=>{}},
  opinionClientFactory:async({job,directory,cwd})=>{const client=new OpinionClient(job.provider,directory,{behavior:control.behavior,answer:control.answer});await client.load();runtimes.push(client);return{client,cwd};}});
 const env={root,clients,runtimes,control,hub:make(),make};
 await env.hub.load();
 env.c=await clients.codex.create({cwd:root,model:'test',effort:'high',sandbox:'read-only'});
 env.dual=(await env.hub.startDual(env.c.id,{provider:'claude',model:'test',effort:'low'})).dual;
 env.partner=clients.claude.conversations[0];
 t.after(async()=>{await env.hub.close().catch(()=>{});await rm(root,{recursive:true,force:true});});
 return env;
}
const round=async(env,requestId,text='Qual é o melhor plano?')=>{await env.hub.sendDual(env.dual.id,{text,requestId});await wait(()=>idle(env.c)&&idle(env.partner)&&env.c.turns.some(t=>t.requestId===requestId+':a'));return env.hub.dual.record(env.dual.id).rounds.at(-1);};
const syntheses=env=>env.hub.opinions.batches.filter(b=>b.kind==='synthesis');
// Finished means closed too: the runtime has stopped and the record is saved.
const finished=(env,id)=>wait(()=>{const job=env.hub.opinions.batches.find(b=>b.id===id)?.jobs[0];return job&&!['queued','starting','running','stopping'].includes(job.status)&&!job.finishing&&!env.hub.opinions.tasks.has(job.id);});

test('síntese manual: as duas respostas completas, numa sessão à parte, e a síntese inteira',async t=>{
 const env=await setup(t);
 env.clients.codex.answer='RESPOSTA-CODEX '+'a'.repeat(40000);env.clients.claude.answer='RESPOSTA-CLAUDE '+'b'.repeat(40000);
 const r1=await round(env,'r1','Como organizar os ficheiros?');
 env.control.answer='SINTESE '+'s'.repeat(60000);
 const result=await env.hub.synthesizeDual(env.dual.id,{roundId:r1.id,requestId:'s1',...SYNTH,instructions:'Foca a manutenção.'});
 assert.equal(result.accepted,true);
 await finished(env,result.id);
 const batch=syntheses(env)[0],job=batch.jobs[0];
 assert.equal(job.status,'completed');assert.equal(batch.roundId,r1.id);assert.equal(batch.context,false);
 // The synthesis is kept whole, above the 24 000 characters of a second opinion.
 assert.equal(job.text.length,'SINTESE '.length+60000);
 const prompt=env.runtimes[0].logs[0].text;
 assert.ok(prompt.includes('a'.repeat(40000))&&prompt.includes('b'.repeat(40000)),'as duas respostas seguem inteiras');
 assert.match(prompt,/Como organizar os ficheiros\?/);assert.match(prompt,/Foca a manutenção\./);
 assert.match(prompt,/resolve a divergência quando houver fundamento/);assert.match(prompt,/mantém a incerteza/);
 assert.match(prompt,/Trabalha em modo Planear ou Só leitura/);
 // The Dual sessions never see the synthesis request.
 assert.equal(env.clients.codex.logs.length,1);assert.equal(env.clients.claude.logs.length,1);
 // The same request is not run twice; another use of its id is refused.
 assert.equal((await env.hub.synthesizeDual(env.dual.id,{roundId:r1.id,requestId:'s1',...SYNTH,instructions:'Foca a manutenção.'})).duplicate,true);
 await assert.rejects(env.hub.synthesizeDual(env.dual.id,{roundId:r1.id,requestId:'s1',...SYNTH}),/Identificador já usado/);
 assert.equal(syntheses(env).length,1);
 // The page sees it apart from the second opinions, without the prompt.
 const shown=env.hub.snapshot().opinions.batches.find(b=>b.id===batch.id);
 assert.equal(shown.kind,'synthesis');assert.equal(shown.prompt,undefined);assert.equal(shown.sourceKey,'dual-synthesis:'+r1.id);
});

test('nada é cortado em silêncio: respostas acima do limite são recusadas antes do envio',async t=>{
 const env=await setup(t);
 env.clients.codex.answer='a'.repeat(50000);env.clients.claude.answer='b'.repeat(SYNTHESIS_INPUT-49000);
 const r1=await round(env,'r1');
 await assert.rejects(env.hub.synthesizeDual(env.dual.id,{roundId:r1.id,requestId:'s1',...SYNTH}),/acima do limite de 90[\s\u202f]000 de uma síntese\. Nada foi cortado nem enviado/);
 assert.equal(syntheses(env).length,0);assert.equal(env.runtimes.length,0);
});

test('desligado, a síntese não chega aos dois; ligado, cada um recebe-a uma vez',async t=>{
 const env=await setup(t);
 const r1=await round(env,'r1');
 const off=await env.hub.synthesizeDual(env.dual.id,{roundId:r1.id,requestId:'s-off',...SYNTH});await finished(env,off.id);
 await round(env,'r2');
 for(const client of [env.clients.codex,env.clients.claude])assert.doesNotMatch(client.logs.at(-1).text,/SINTESE-FINAL|hydraq_dual_synthesis/);
 env.control.answer='SINTESE-COM-CONTEXTO';
 const r2=env.hub.dual.record(env.dual.id).rounds.at(-1);
 const on=await env.hub.synthesizeDual(env.dual.id,{roundId:r2.id,requestId:'s-on',...SYNTH,context:true});await finished(env,on.id);
 const r3=await round(env,'r3');
 for(const client of [env.clients.codex,env.clients.claude]){const text=client.logs.at(-1).text;assert.match(text,/<hydraq_dual_synthesis>[\s\S]*SINTESE-COM-CONTEXTO/);assert.match(text,/escrita pelo Antigravity · Modelo teste/);}
 assert.deepEqual(Object.values(r3.deliveries).map(d=>d.synthesis),[on.id,on.id]);
 // The request shows what went with it: the client keeps it with the message, under «Contexto da passagem».
 assert.match(env.clients.codex.logs.find(l=>l.requestId==='r3:a').settings.handoffContext,/SINTESE-COM-CONTEXTO/);
 await round(env,'r4');
 for(const client of [env.clients.codex,env.clients.claude])assert.doesNotMatch(client.logs.at(-1).text,/SINTESE-COM-CONTEXTO/);
});

test('síntese que chega tarde segue na ronda a seguir a terminar; entrega falhada num só repete-se só a esse',async t=>{
 const env=await setup(t);
 const r1=await round(env,'r1');
 env.control.behavior='hold';
 const late=await env.hub.synthesizeDual(env.dual.id,{roundId:r1.id,requestId:'s-late',...SYNTH,context:true});
 await wait(()=>env.runtimes[0]?.conversations[0]?.status==='running');
 // The Dual is not held by the synthesis: the next round goes without it.
 const r2=await round(env,'r2');
 assert.equal(r2.deliveries.a.synthesis,undefined);assert.doesNotMatch(env.clients.codex.logs.at(-1).text,/hydraq_dual_synthesis/);
 env.runtimes[0].finish(env.runtimes[0].conversations[0],'SINTESE-TARDIA');await finished(env,late.id);
 // The Claude delivery fails: the Codex gets the synthesis now, the Claude in the next round, and neither twice.
 env.clients.claude.behavior='pre-fail';
 await env.hub.sendDual(env.dual.id,{text:'Terceira pergunta',requestId:'r3'});
 await wait(()=>idle(env.c)&&env.c.turns.some(t=>t.requestId==='r3:a'));
 const r3=env.hub.dual.record(env.dual.id).rounds.at(-1);
 assert.equal(r3.deliveries.b.status,'failed');assert.match(env.clients.codex.logs.at(-1).text,/SINTESE-TARDIA/);
 env.clients.claude.behavior='success';
 await round(env,'r4');
 assert.match(env.clients.claude.logs.at(-1).text,/SINTESE-TARDIA/);assert.doesNotMatch(env.clients.codex.logs.at(-1).text,/SINTESE-TARDIA/);
 await round(env,'r5');
 assert.doesNotMatch(env.clients.claude.logs.at(-1).text,/SINTESE-TARDIA/);
});

test('uma síntese desligada pedida depois não cancela a que ia para a ronda seguinte',async t=>{
 const env=await setup(t);
 const r1=await round(env,'r1');
 env.control.answer='SINTESE-PARA-A-RONDA';
 const on=await env.hub.synthesizeDual(env.dual.id,{roundId:r1.id,requestId:'s-on',...SYNTH,context:true});await finished(env,on.id);
 env.control.answer='SINTESE-SO-PARA-LER';
 const off=await env.hub.synthesizeDual(env.dual.id,{roundId:r1.id,requestId:'s-off',...SYNTH,instructions:'Outra versão.'});await finished(env,off.id);
 const r2=await round(env,'r2');
 assert.deepEqual(Object.values(r2.deliveries).map(d=>d.synthesis),[on.id,on.id]);
 for(const client of [env.clients.codex,env.clients.claude]){const text=client.logs.at(-1).text;assert.match(text,/SINTESE-PARA-A-RONDA/);assert.doesNotMatch(text,/SINTESE-SO-PARA-LER/);}
});

test('uma síntese por entregar não passa ao arquivo; depois de entregue aos dois, pode passar',async t=>{
 const env=await setup(t);
 const r1=await round(env,'r1');
 env.control.answer='SINTESE-GUARDADA';
 const on=await env.hub.synthesizeDual(env.dual.id,{roundId:r1.id,requestId:'s-on',...SYNTH,context:true});await finished(env,on.id);
 // More finished second opinions than the 40 kept: the oldest go to the archive.
 const opinions=env.hub.opinions,filler=()=>{for(let i=0;i<45;i++){const at=new Date(Date.now()+i).toISOString();opinions.batches.push({id:randomUUID(),requestId:'filler-'+randomUUID(),signature:'[]',groupId:env.c.group||env.c.id,conversationId:env.c.id,cwd:env.root,title:'Enchimento',createdAt:at,prompt:'',images:[],jobs:[{id:randomUUID(),provider:'codex',model:'test',effort:'low',status:'completed',text:'Parecer',createdAt:at,completedAt:at,error:null}]});}};
 filler();await opinions.serial(()=>opinions.persist());
 assert.ok(opinions.batches.some(b=>b.id===on.id),'a síntese por entregar fica com os pareceres em uso');
 const r2=await round(env,'r2');
 assert.deepEqual(Object.values(r2.deliveries).map(d=>d.synthesis),[on.id,on.id]);
 assert.match(env.clients.claude.logs.at(-1).text,/SINTESE-GUARDADA/);
 filler();await opinions.serial(()=>opinions.persist());
 assert.ok(!opinions.batches.some(b=>b.id===on.id),'entregue aos dois, segue o arquivo como os outros');
 await round(env,'r3');
 assert.doesNotMatch(env.clients.claude.logs.at(-1).text,/SINTESE-GUARDADA/);
});

test('falta uma resposta: só uma síntese parcial pedida explicitamente, que diz o que falta',async t=>{
 const env=await setup(t);
 env.clients.claude.behavior='pre-fail';
 await env.hub.sendDual(env.dual.id,{text:'Pergunta',requestId:'r1'});
 await wait(()=>idle(env.c)&&env.c.turns.some(t=>t.requestId==='r1:a'));
 const r1=env.hub.dual.record(env.dual.id).rounds.at(-1);
 await assert.rejects(env.hub.synthesizeDual(env.dual.id,{roundId:r1.id,requestId:'s1',...SYNTH}),/Falta a resposta do Claude · Modelo teste\. Reenvia-lhe a pergunta ou pede uma síntese parcial/);
 const partial=await env.hub.synthesizeDual(env.dual.id,{roundId:r1.id,requestId:'s2',...SYNTH,partial:true});await finished(env,partial.id);
 const batch=syntheses(env)[0];
 assert.deepEqual(batch.missing,['b']);assert.match(env.runtimes[0].logs[0].text,/síntese é parcial e qual resposta falta/);
 // With both answers, partial is refused: a full synthesis is asked instead.
 env.clients.claude.behavior='success';
 const r2=await round(env,'r2');
 await assert.rejects(env.hub.synthesizeDual(env.dual.id,{roundId:r2.id,requestId:'s3',...SYNTH,partial:true}),/As duas respostas estão completas/);
});

test('automático: uma síntese por ronda nova aos dois, marcada antes de arrancar e nunca repetida',async t=>{
 const env=await setup(t);
 const before=await round(env,'r0');
 await env.hub.setDualSynthesis(env.dual.id,{auto:true,context:false,...SYNTH,instructions:'Curta.'});
 await new Promise(r=>setTimeout(r,80));
 assert.equal(syntheses(env).length,0,'rondas anteriores a ligar o automático não são sintetizadas');
 assert.equal(before.synthesis,undefined);
 const r1=await round(env,'r1');
 await wait(()=>syntheses(env).length===1);
 const batch=syntheses(env)[0];
 assert.equal(batch.automatic,true);assert.equal(batch.roundId,r1.id);assert.equal(batch.requestId,'dual-synthesis:'+r1.id);
 assert.equal(env.hub.dual.record(env.dual.id).rounds.at(-1).synthesis.requestId,'dual-synthesis:'+r1.id);
 await finished(env,batch.id);
 env.clients.codex.changed();env.clients.claude.changed();await new Promise(r=>setTimeout(r,80));
 assert.equal(syntheses(env).length,1);
 // A round marked but never started (a restart in between) waits for the person: the pump does not start it.
 const r2=await round(env,'r2');await wait(()=>syntheses(env).length===2);
 await env.hub.close();
 const marked=env.hub.dual.records[0].rounds.at(-1);assert.equal(marked.id,r2.id);
 env.hub=env.make();await env.hub.load();
 const record=env.hub.dual.record(env.dual.id);
 await env.hub.dual.markSynthesis(record.id,record.rounds.at(-1).id,{requestId:'dual-synthesis:never-started'});
 await new Promise(r=>setTimeout(r,80));
 assert.equal(syntheses(env).length,2,'depois de reiniciar, nenhuma síntese é repetida');
 // A failed answer: the automatic synthesis waits for the person.
 env.clients.claude.behavior='pre-fail';
 await env.hub.sendDual(env.dual.id,{text:'Falha',requestId:'r3'});await wait(()=>idle(env.c)&&env.c.turns.some(t=>t.requestId==='r3:a'));
 await new Promise(r=>setTimeout(r,80));
 assert.equal(syntheses(env).length,2);assert.equal(env.hub.dual.record(env.dual.id).rounds.at(-1).synthesis,undefined);
 // Turning it off keeps the choices for the next time.
 await env.hub.setDualSynthesis(env.dual.id,{auto:false,context:true});
 assert.deepEqual({...env.hub.dual.record(env.dual.id).synthesis},{auto:false,context:true,provider:'antigravity',model:'test',effort:'low',instructions:'',since:null});
 await assert.rejects(env.hub.setDualSynthesis(env.dual.id,{auto:true,context:false,provider:'antigravity',model:'nope',effort:'low'}),/Escolhe cliente, modelo e raciocínio/);
});

test('rotas da síntese: opções e pedido pela API da página',async t=>{
 const env=await setup(t);
 const r1=await round(env,'r1');
 const server=createHttpServer({hydraq:env.hub,publicDir:new URL('../public',import.meta.url).pathname});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/bootstrap',{headers:{'X-HYDRAQ-Bootstrap':'1'}})).json();
 const post=(route,body)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','x-hydraq-token':token},body:JSON.stringify(body)});
 const settings=await post(`/api/dual/${env.dual.id}/synthesis-settings`,{auto:false,context:true,...SYNTH});
 assert.equal(settings.status,200);assert.equal((await settings.json()).dual.synthesis.context,true);
 const asked=await post(`/api/dual/${env.dual.id}/synthesis`,{roundId:r1.id,requestId:'http-1',...SYNTH,context:true});
 assert.equal(asked.status,200);const {id}=await asked.json();await finished(env,id);
 const state=await(await fetch(base+'/api/state',{headers:{'x-hydraq-token':token}})).json();
 assert.equal(state.opinions.batches.find(b=>b.id===id).jobs[0].text,'SINTESE-FINAL');
 assert.equal(state.dual.records[0].synthesis.context,true);
});
