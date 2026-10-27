import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,readFile} from 'node:fs/promises';
import {Providers} from '../lib/providers.mjs';
import {DualSessions} from '../lib/dual.mjs';
import {buildHandoff} from '../lib/handoff.mjs';
import {OpinionClient} from './fixtures/opinion-client.mjs';
import {createHttpServer} from '../lib/http.mjs';
const wait=async f=>{const end=Date.now()+7000;while(!f()){if(Date.now()>end)throw Error('Timeout');await new Promise(r=>setTimeout(r,10));}};
const idle=c=>!['starting','running','waiting'].includes(c.status);

async function setup(t,{a='success',b='success'}={}){
 const root=await mkdtemp('/tmp/hydraq-dual-test-');
 const clients={codex:new OpinionClient('codex',root+'/codex',{behavior:a}),claude:new OpinionClient('claude',root+'/claude',{behavior:b}),antigravity:new OpinionClient('antigravity',root+'/agy'),cursor:new OpinionClient('cursor',root+'/cursor'),opencode:new OpinionClient('opencode',root+'/oc')};
 const hub=new Providers({dataDir:root+'/hub',defaultCwd:root,clients,opinionSupervisor:{available:async()=>({available:true}),stop:async()=>{}},opinionClientFactory:async({job,directory,cwd})=>{const client=new OpinionClient(job.provider,directory);await client.load();return{client,cwd};}});
 await hub.load();
 const c=await clients.codex.create({cwd:root,model:'test',effort:'high',sandbox:'read-only'});
 t.after(async()=>{await hub.close();await rm(root,{recursive:true,force:true});});
 return {root,hub,c,codex:clients.codex,claude:clients.claude};
}
const start=(hub,c,extra={})=>hub.startDual(c.id,{provider:'claude',model:'test',effort:'low',...extra});
const send=(hub,record,requestId,text,extra={})=>hub.sendDual(record.id,{text,requestId,...extra});

test('ativar o Dual liga uma segunda conversa ao grupo sem enviar nada',async t=>{
 const{hub,c,codex,claude}=await setup(t);
 const {dual}=await start(hub,c);
 assert.equal(dual.active,true);assert.equal(dual.principal,'a');assert.equal(dual.target,'both');
 const second=claude.conversations[0];
 assert.equal(dual.members.a.conversationId,c.id);assert.equal(dual.members.b.conversationId,second.id);
 assert.equal(second.group,c.group);assert.equal(second.sandbox,'plan');
 assert.equal(codex.logs.length+claude.logs.length,0);
 await assert.rejects(start(hub,c),/já está ativo/);
 await assert.rejects(hub.startDual(c.id,{provider:'codex',model:'test',effort:'low'}),/outro cliente/);
 assert.equal(hub.snapshot().dual.records.length,1);
 // Snapshots are ordered: the browser never replaces a newer state with an older response.
 const earlier=hub.snapshot(),later=hub.snapshot();assert.equal(earlier.stateInstance,later.stateInstance);assert.ok(later.stateRevision>earlier.stateRevision);
});

test('na mesma ronda nenhum vê a resposta do outro; na seguinte, cada um recebe a anterior do outro',async t=>{
 const{hub,c,codex,claude}=await setup(t);
 const {dual}=await start(hub,c);
 // The Codex answer arrives before the Claude request is handed over: the cut-off is fixed beforehand.
 const deliver=claude.send.bind(claude);claude.send=async(...args)=>{await wait(()=>c.status==='completed');return deliver(...args);};
 codex.answer='RESPOSTA-CODEX-1';claude.answer='RESPOSTA-CLAUDE-1';
 const first=await send(hub,dual,'r1','Como resolver o problema X?');
 assert.deepEqual(first.deliveries,{a:'sent',b:'sent'});
 const second=claude.conversations[0];await wait(()=>second.status==='completed');
 assert.doesNotMatch(claude.logs[0].text,/RESPOSTA-CODEX-1/);
 assert.doesNotMatch(codex.logs[0].text,/RESPOSTA-CLAUDE-1/);
 assert.equal(codex.logs[0].requestId,'r1:a');assert.equal(claude.logs[0].requestId,'r1:b');
 claude.send=deliver;codex.answer='RESPOSTA-CODEX-2';claude.answer='RESPOSTA-CLAUDE-2';
 await send(hub,dual,'r2','Qual é o melhor plano?');
 await wait(()=>idle(c)&&idle(second)&&claude.logs.length===2);
 assert.match(codex.logs[1].text,/RESPOSTA-CLAUDE-1/);assert.match(claude.logs[1].text,/RESPOSTA-CODEX-1/);
 assert.match(claude.logs[1].text,/Conversa dual no HYDRAQ/);
 // The shared question is not repeated: it was already in the recipient's own history.
 assert.match(claude.logs[1].text,/o mesmo que recebeste nesta ronda/);
 assert.doesNotMatch(claude.logs[1].text,/Pedido do utilizador: Como resolver o problema X\?/);
 assert.match(claude.logs[1].text,/Novo pedido do utilizador:\nQual é o melhor plano\?/);
 const round=hub.dual.record(dual.id).rounds[1];
 assert.equal(round.deliveries.a.coverage,'complete');assert.equal(round.deliveries.b.coverage,'complete');
 // A repeated request id is the same round, never a new delivery.
 assert.equal((await send(hub,dual,'r2','Qual é o melhor plano?')).duplicate,true);
 assert.equal(codex.logs.length+claude.logs.length,4);
});

test('falar só com um não acorda o outro; ao voltar, recebe as mensagens que perdeu',async t=>{
 const{hub,c,codex,claude}=await setup(t);
 const {dual}=await start(hub,c);
 await hub.updateDual(dual.id,{target:'a'});
 codex.answer='SÓ-CODEX-1';await send(hub,dual,'solo-1','Primeira só para o Codex');await wait(()=>c.status==='completed');
 codex.answer='SÓ-CODEX-2';await send(hub,dual,'solo-2','Segunda só para o Codex');await wait(()=>c.status==='completed');
 assert.equal(claude.logs.length,0);
 await send(hub,dual,'back','Agora os dois',{target:'both'});
 await wait(()=>claude.logs.length===1);
 const text=claude.logs[0].text;
 assert.match(text,/Primeira só para o Codex/);assert.match(text,/SÓ-CODEX-1/);
 assert.match(text,/Segunda só para o Codex/);assert.match(text,/SÓ-CODEX-2/);
 assert.equal(hub.dual.record(dual.id).target,'a');
});

test('com os dois só leitura; escrita só pelo principal',async t=>{
 const{hub,c,codex,claude}=await setup(t);
 const {dual}=await start(hub,c);
 await assert.rejects(send(hub,dual,'w1','Implementa',{settings:{a:{sandbox:'workspace-write'}}}),/Com os dois modelos/);
 await assert.rejects(send(hub,dual,'w2','Implementa',{target:'b',settings:{b:{sandbox:'workspace-write'}}}),/Só o principal implementa/);
 assert.equal(codex.logs.length+claude.logs.length,0);assert.equal(hub.dual.record(dual.id).rounds.length,0);
 await send(hub,dual,'w3','Implementa o plano escolhido',{target:'a',settings:{a:{sandbox:'workspace-write'}}});
 assert.equal(codex.logs[0].settings.sandbox,'workspace-write');assert.equal(hub.dual.record(dual.id).rounds[0].write,true);
 await wait(()=>c.status==='completed');
 // Changing the principal changes who may write next, never a request already sent.
 await hub.updateDual(dual.id,{principal:'b'});
 await send(hub,dual,'w4','Agora implementa tu',{target:'b',settings:{b:{sandbox:'workspace-write'}}});
 await wait(()=>claude.logs.length===1);assert.equal(claude.logs[0].settings.sandbox,'workspace-write');
 assert.match(claude.logs[0].text,/Implementa o plano escolhido/);
});

test('uma ronda a dois não arma a revisão automática do grupo',async t=>{
 const{hub,c,claude}=await setup(t);
 await hub.automaticReviews.policy(c.id,{trigger:'all',scope:'conversation',returnToPrincipal:true,participant:{provider:'antigravity',model:'test',effort:'low'}});
 const {dual}=await start(hub,c);
 await send(hub,dual,'no-review','Pergunta aos dois');
 await wait(()=>idle(c)&&idle(claude.conversations[0]));
 assert.equal(hub.automaticReviews.cycles.length,0);
});

test('falha de um participante conserva o outro e não é repetida',async t=>{
 const{hub,c,codex,claude}=await setup(t,{b:'pre-fail'});
 const {dual}=await start(hub,c);
 const result=await send(hub,dual,'partial','Pergunta aos dois');
 assert.deepEqual(result.deliveries,{a:'sent',b:'failed'});
 const round=hub.dual.record(dual.id).rounds[0];
 assert.equal(round.deliveries.b.status,'failed');assert.match(round.deliveries.b.error,/Falha antes do envio/);
 await wait(()=>c.status==='completed');
 assert.equal(codex.logs.length,1);assert.equal(claude.logs.length,0);
 claude.behavior='pre-fail';codex.behavior='pre-fail';
 await assert.rejects(send(hub,dual,'none','Outra'),/Falha antes do envio/);
});

test('parar um participante não interrompe o outro; parar a ronda para os dois',async t=>{
 const{hub,c,claude}=await setup(t,{a:'hold',b:'hold'});
 const {dual}=await start(hub,c);
 await send(hub,dual,'hold-1','Pergunta longa');
 const second=claude.conversations[0];
 await hub.interrupt(second.id);
 assert.equal(second.status,'interrupted');assert.equal(c.status,'running');
 await assert.rejects(send(hub,dual,'busy','Outra pergunta'),/em curso/);
 assert.throws(()=>hub.steer(c.id,'Orienta','steer-1',c.turnId,'steer'),/espera pelo fim da ronda/);
 await hub.interruptDual(dual.id);
 assert.equal(c.status,'interrupted');
});

test('com o Dual ativo não se muda de cliente; desligado, a conversa continua normal',async t=>{
 const{hub,c,codex}=await setup(t);
 const {dual}=await start(hub,c);
 await assert.rejects(hub.send(c.id,'Mudar','switch',{provider:'cursor',model:'test',effort:'low',sandbox:'plan'}),/Desliga o Dual/);
 await hub.endDual(dual.id);
 assert.equal(hub.dual.record(dual.id).active,false);
 await assert.rejects(send(hub,dual,'off','Pergunta'),/desligado/);
 await hub.send(c.id,'Só o principal','normal',{model:'test',effort:'high',sandbox:'read-only'});
 await wait(()=>c.status==='completed');assert.equal(codex.logs.length,1);
 // Reactivating keeps the earlier rounds and reuses the same second conversation.
 const again=await start(hub,c);assert.equal(again.dual.id,dual.id);
});

test('com o Dual ativo, o envio normal também só deixa o principal escrever',async t=>{
 const{hub,c,codex,claude}=await setup(t);
 const {dual}=await start(hub,c);
 const second=claude.conversations[0];
 // Pareceres and queued messages use the normal send: the rule is checked there too.
 await assert.rejects(hub.send(second.id,'Implementa','n1',{model:'test',effort:'low',sandbox:'workspace-write'}),/só o principal implementa \(Codex\)/);
 assert.equal(claude.logs.length,0);
 await hub.send(second.id,'Lê só','n2',{model:'test',effort:'low',sandbox:'plan'});await wait(()=>second.status==='completed');
 await hub.send(c.id,'Implementa tu','n3',{model:'test',effort:'high',sandbox:'workspace-write'});await wait(()=>c.status==='completed');
 assert.equal(codex.logs.at(-1).settings.sandbox,'workspace-write');
 await hub.endDual(dual.id);
 await hub.send(second.id,'Agora sim','n4',{model:'test',effort:'low',sandbox:'workspace-write'});
 await wait(()=>claude.logs.length===2);assert.equal(claude.logs[1].settings.sandbox,'workspace-write');
});

test('reenviar só ao que falhou conserva a ronda, o corte e a pergunta partilhada',async t=>{
 const{hub,c,codex,claude}=await setup(t,{b:'pre-fail'});
 const {dual}=await start(hub,c);
 codex.answer='RESPOSTA-CODEX-R';
 const result=await send(hub,dual,'retry','Pergunta aos dois');
 assert.deepEqual(result.deliveries,{a:'sent',b:'failed'});assert.match(result.errors.b,/Falha antes do envio/);
 await wait(()=>c.status==='completed');
 const round=hub.dual.record(dual.id).rounds[0];
 await assert.rejects(hub.retryDual(dual.id,{roundId:'outra',key:'b'}),/última ronda/);
 await assert.rejects(hub.retryDual(dual.id,{roundId:round.id,key:'a'}),/não falhou/);
 claude.behavior='success';claude.answer='RESPOSTA-CLAUDE-R';
 assert.deepEqual((await hub.retryDual(dual.id,{roundId:round.id,key:'b'})).deliveries,{b:'sent'});
 const second=claude.conversations[0];await wait(()=>second.status==='completed');
 // Same question, new id, and still without the Codex answer to this round.
 assert.equal(claude.logs[0].requestId,'retry:b~2');assert.equal(claude.logs[0].text,'Pergunta aos dois');
 assert.doesNotMatch(claude.logs[0].text,/RESPOSTA-CODEX-R/);assert.equal(claude.logs[0].settings.planOnly,true);
 const entry=hub.dual.record(dual.id).rounds[0].deliveries.b;
 assert.equal(entry.status,'sent');assert.deepEqual(entry.attempts,['retry:b']);assert.equal(entry.requestId,'retry:b~2');
 await assert.rejects(hub.retryDual(dual.id,{roundId:round.id,key:'b'}),/não falhou/);
 assert.equal(codex.logs.length,1);
 await send(hub,dual,'after','Seguinte');await wait(()=>idle(c)&&idle(second)&&codex.logs.length===2);
 assert.match(codex.logs[1].text,/RESPOSTA-CLAUDE-R/);assert.match(codex.logs[1].text,/o mesmo que recebeste nesta ronda/);
});

test('modelo e imagens validados por modelo, na lista da pasta da conversa, antes de qualquer envio',async t=>{
 const{hub,c,codex}=await setup(t);
 const oc=hub.clients.opencode,folders=[];
 oc.refreshModels=async cwd=>{folders.push(cwd);oc.models=[{id:'test',name:'Modelo teste',efforts:['low','high'],defaultEffort:'low',free:true,images:true},{id:'pasta',name:'Só nesta pasta',efforts:['low'],defaultEffort:'low',free:true,images:false}];};
 const {dual}=await hub.startDual(c.id,{provider:'opencode',model:'pasta',effort:'low'});
 assert.deepEqual(folders,[c.cwd]);
 await assert.rejects(send(hub,dual,'img','Vê a imagem',{attachments:['imagem']}),/Só nesta pasta\) não aceita imagens/);
 assert.equal(codex.logs.length+oc.logs.length,0);assert.equal(hub.dual.record(dual.id).rounds.length,0);
 await send(hub,dual,'pasta','Pergunta');
 await wait(()=>oc.logs.length===1);assert.equal(oc.logs[0].settings.model,'pasta');assert.deepEqual(folders,[c.cwd,c.cwd,c.cwd]);
});

test('reinício conserva o que a conversa registou e nunca reenvia',async t=>{
 const root=await mkdtemp('/tmp/hydraq-dual-restart-');t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(root,{recursive:true});
 const delivery=(status,requestId)=>({provider:'codex',conversationId:'conv-a',requestId,status,error:null,coverage:null});
 await writeFile(root+'/state.json',JSON.stringify({version:1,records:[{id:'11111111-1111-1111-1111-111111111111',groupId:'g',active:true,principal:'a',target:'both',members:{a:{provider:'codex',conversationId:'conv-a'},b:{provider:'claude',conversationId:'conv-b'}},rounds:[
  {id:'22222222-2222-2222-2222-222222222222',requestId:'x',targets:['a','b'],deliveries:{a:delivery('sending','x:a'),b:{...delivery('sending','x:b'),conversationId:'conv-b'}}},
  {id:'33333333-3333-3333-3333-333333333333',requestId:'y',targets:['a'],deliveries:{a:delivery('preparing','y:a')}},
 ]}]}));
 const dual=new DualSessions({directory:root,conversations:()=>[{id:'conv-a',turns:[{requestId:'x:a',status:'running'}]},{id:'conv-b',turns:[]}]});
 await dual.load();
 const [x,y]=dual.records[0].rounds;
 assert.equal(x.deliveries.a.status,'sent');assert.equal(x.deliveries.b.status,'uncertain');assert.match(x.deliveries.b.error,/Nada foi reenviado/);
 assert.equal(y.deliveries.a.status,'failed');
 assert.equal(JSON.parse(await readFile(root+'/state.json','utf8')).records[0].rounds[1].deliveries.a.status,'failed');
});

test('resposta longa do outro segue como excerto assinalado, nunca como completa',()=>{
 const member=(id,provider,answer)=>({id,provider,cwd:'/p',messages:[{role:'user',requestId:'q',text:'Pergunta'},{role:'assistant',requestId:'q',text:answer}],turns:[{requestId:'q',status:'completed',model:'m',startedAt:'2026-10-24T10:00:00Z',facts:{version:2,files:[],commands:[]}}]});
 const target={id:'t',provider:'claude',cwd:'/p',messages:[],turns:[]};
 const short=buildHandoff({target,members:[target,member('o','codex','curta')],git:[],dual:{other:'Codex',shared:new Map()}});
 assert.equal(short.coverage,'complete');
 const long=buildHandoff({target,members:[target,member('o','codex','x'.repeat(30000))],git:[],budget:20000,dual:{other:'Codex',shared:new Map()}});
 assert.equal(long.coverage,'excerpt');assert.match(long.text,/cortado/);
 // Outside the dual mode the existing handoff keeps its smaller answer excerpts.
 assert.equal(buildHandoff({target,members:[target,member('o','codex','y'.repeat(5000))],git:[]}).coverage,'excerpt');
});

test('rotas HTTP do Dual exigem a sessão local e encaminham para o coordenador',async t=>{
 const{hub,c,claude}=await setup(t);
 const server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeStreams();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/bootstrap',{headers:{'X-HYDRAQ-Bootstrap':'1'}})).json();
 const post=(route,body,authenticated=true)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...(authenticated?{'x-hydraq-token':token}:{})},body:JSON.stringify(body)});
 assert.equal((await post(`/api/conversations/${c.id}/dual`,{provider:'claude',model:'test',effort:'low'},false)).status,403);
 const started=await(await post(`/api/conversations/${c.id}/dual`,{provider:'claude',model:'test',effort:'low',principal:'b'})).json();
 assert.equal(started.dual.principal,'b');
 const id=started.dual.id;
 assert.equal((await(await post(`/api/dual/${id}`,{target:'b'})).json()).dual.target,'b');
 const sent=await(await post(`/api/dual/${id}/send`,{text:'Pergunta',requestId:'http-1'})).json();
 assert.deepEqual(sent.deliveries,{b:'sent'});await wait(()=>claude.logs.length===1&&idle(claude.conversations[0]));
 const replaced=await(await post(`/api/dual/${id}/replace`,{key:'b',provider:'opencode',model:'test',effort:'low'})).json();
 assert.equal(replaced.dual.members.b.provider,'opencode');assert.equal(replaced.dual.principal,'b');
 assert.equal((await(await post(`/api/dual/${id}/end`,{})).json()).dual.active,false);
});

test('trocar o cliente de um participante não desliga o Dual: cada ronda mantém quem respondeu e o novo recebe o histórico',async t=>{
 const{hub,c,codex,claude}=await setup(t);
 const oc=hub.clients.opencode;
 const {dual}=await start(hub,c);
 codex.answer='RESPOSTA-CODEX-1';claude.answer='RESPOSTA-CLAUDE-1';
 await send(hub,dual,'antes','Primeira pergunta');
 const second=claude.conversations[0];await wait(()=>idle(c)&&idle(second)&&claude.logs.length===1);
 await assert.rejects(hub.replaceDualMember(dual.id,{key:'b',provider:'codex',model:'test',effort:'low'}),/já participa/);
 await assert.rejects(hub.replaceDualMember(dual.id,{key:'b',provider:'opencode',model:'outro',effort:'low'}),/catálogo/);
 const result=await hub.replaceDualMember(dual.id,{key:'b',provider:'opencode',model:'test',effort:'high'});
 const record=hub.dual.record(dual.id),joined=oc.conversations[0];
 assert.equal(record.active,true);assert.equal(record.principal,'a');assert.equal(result.conversationId,joined.id);
 assert.deepEqual(record.members.b,{provider:'opencode',conversationId:joined.id,model:'test',effort:'high'});
 assert.equal(joined.group,c.group);assert.equal(joined.sandbox,'plan');assert.equal(second.group,c.group);
 // The earlier round keeps the pair that received it; the change itself is recorded where it happened.
 assert.equal(record.rounds[0].members.b.provider,'claude');assert.equal(record.rounds[0].deliveries.b.provider,'claude');
 assert.equal(record.changes.length,1);assert.equal(record.changes[0].from.provider,'claude');assert.equal(record.changes[0].to.provider,'opencode');
 // Changing a participant sends nothing.
 assert.equal(codex.logs.length+claude.logs.length+oc.logs.length,2);
 codex.answer='RESPOSTA-CODEX-2';oc.answer='RESPOSTA-OPENCODE-2';
 await send(hub,dual,'depois','Segunda pergunta');
 await wait(()=>idle(c)&&idle(joined)&&oc.logs.length===1);
 const text=oc.logs[0].text;
 assert.match(text,/entras agora nesta conversa/);assert.match(text,/Primeira pergunta/);
 assert.match(text,/RESPOSTA-CODEX-1/);assert.match(text,/RESPOSTA-CLAUDE-1/);
 assert.equal(oc.logs[0].settings.model,'test');assert.equal(oc.logs[0].settings.effort,'high');assert.equal(oc.logs[0].settings.sandbox,'plan');
 assert.match(codex.logs[1].text,/RESPOSTA-CLAUDE-1/);assert.equal(claude.logs.length,1);
 assert.equal(hub.dual.record(dual.id).rounds[1].members.b.provider,'opencode');
 // Going back to a client of the group reuses its conversation and session.
 await hub.replaceDualMember(dual.id,{key:'b',provider:'claude',model:'test',effort:'low'});
 assert.equal(hub.dual.record(dual.id).members.b.conversationId,second.id);assert.equal(claude.conversations.length,1);
});

test('trocar participante espera pelo fim da ronda e pelo terminal; o principal só muda quando escolhido',async t=>{
 const{hub,c,codex,claude}=await setup(t,{a:'hold',b:'hold'});
 const {dual}=await start(hub,c);
 await send(hub,dual,'longa','Pergunta longa');
 await assert.rejects(hub.replaceDualMember(dual.id,{key:'b',provider:'opencode',model:'test',effort:'low'}),/respostas terminem/);
 await hub.interruptDual(dual.id);
 hub.nativeSessions.sessions.set('terminal',{id:c.id,group:c.group});
 await assert.rejects(hub.replaceDualMember(dual.id,{key:'b',provider:'opencode',model:'test',effort:'low'}),/terminal/);
 await assert.rejects(hub.updateDual(dual.id,{principal:'b'}),/terminal/);
 hub.nativeSessions.sessions.delete('terminal');
 assert.equal(hub.clients.opencode.conversations.length,0);
 // Replacing the principal's client keeps the role in that slot unless the person chooses again.
 await hub.replaceDualMember(dual.id,{key:'a',provider:'antigravity',model:'test',effort:'low'});
 assert.equal(hub.dual.record(dual.id).principal,'a');assert.equal(hub.dual.record(dual.id).members.a.provider,'antigravity');
 await hub.replaceDualMember(dual.id,{key:'a',provider:'cursor',model:'test',effort:'low',principal:'b'});
 assert.equal(hub.dual.record(dual.id).principal,'b');
 // The same client only changes model and reasoning.
 await hub.replaceDualMember(dual.id,{key:'b',provider:'claude',model:'test',effort:'high'});
 assert.equal(hub.dual.record(dual.id).members.b.effort,'high');assert.equal(hub.dual.record(dual.id).changes.length,2);
 assert.equal(codex.logs.length+claude.logs.length,2);
});

test('no Dual só o principal abre no terminal; um reenvio não atravessa a troca de participante',async t=>{
 const{hub,c,claude}=await setup(t,{b:'pre-fail'});
 const {dual}=await start(hub,c);
 const result=await send(hub,dual,'falha','Pergunta aos dois');
 assert.deepEqual(result.deliveries,{a:'sent',b:'failed'});await wait(()=>idle(c));
 const second=claude.conversations[0];
 assert.doesNotThrow(()=>hub.assertTerminal(c.id));
 assert.throws(()=>hub.assertTerminal(second.id),/só o principal \(Codex\) abre no terminal/);
 await hub.replaceDualMember(dual.id,{key:'b',provider:'opencode',model:'test',effort:'low'});
 const round=hub.dual.record(dual.id).rounds[0];
 await assert.rejects(hub.retryDual(dual.id,{roundId:round.id,key:'b'}),/participante mudou/);
 await hub.endDual(dual.id);
 assert.doesNotThrow(()=>hub.assertTerminal(second.id));
});
