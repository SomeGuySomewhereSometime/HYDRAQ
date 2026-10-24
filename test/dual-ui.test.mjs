import test from 'node:test';
import assert from 'node:assert/strict';
import {dualSendLabel,dualRounds,dualPanelState,activeDual,isReadMode,DualUI} from '../public/dual.js';

const record={id:'d',groupId:'g',active:true,principal:'a',target:'both',members:{a:{provider:'codex',conversationId:'A'},b:{provider:'claude',conversationId:'B'}},rounds:[]};

test('o botão de envio nomeia quem recebe o pedido antes de enviar',()=>{
 assert.equal(dualSendLabel(record),'Enviar aos dois ↗');
 assert.equal(dualSendLabel(record,{target:'b'}),'Enviar só ao Claude ↗');
 assert.equal(dualSendLabel(record,{target:'a'}),'Enviar só ao Codex ↗');
 assert.equal(dualSendLabel(record,{target:'a',writing:true}),'Enviar ao principal · Codex ↗');
 assert.equal(isReadMode('plan'),true);assert.equal(isReadMode('read-only'),true);assert.equal(isReadMode('workspace-write'),false);
 assert.equal(activeDual({dual:{records:[record,{...record,groupId:'h',active:false}]}},'h'),null);
});

test('rondas juntam a pergunta pela identidade da ronda, nunca pelo texto',()=>{
 const A={id:'A'},B={id:'B'},at=i=>`2026-10-24T10:00:0${i}Z`;
 const timeline=[
  {owner:A,message:{role:'user',requestId:'r1:a',text:'Igual',at:at(0)}},
  {owner:B,message:{role:'user',requestId:'r1:b',text:'Igual',at:at(1)}},
  {owner:A,message:{role:'assistant',requestId:'r1:a',text:'Resposta A',at:at(2)}},
  {owner:B,message:{role:'assistant',requestId:'r1:b',text:'Resposta B',at:at(3)}},
  // The same text in a later, separate request stays its own question.
  {owner:A,message:{role:'user',requestId:'r2:a',text:'Igual',at:at(4)}},
  {owner:A,message:{role:'user',requestId:'manual',text:'Igual',at:at(5)}},
 ];
 const delivery=(key,conversationId,requestId)=>({provider:key==='a'?'codex':'claude',conversationId,requestId,status:'sent'});
 const rounds=dualRounds(timeline,{...record,rounds:[
  {id:'1',requestId:'r1',targets:['a','b'],deliveries:{a:delivery('a','A','r1:a'),b:delivery('b','B','r1:b')}},
  {id:'2',requestId:'r2',targets:['a'],deliveries:{a:delivery('a','A','r2:a')}},
  {id:'3',requestId:'r3',targets:['a','b'],deliveries:{a:delivery('a','A','r3:a'),b:delivery('b','B','r3:b')}},
 ]});
 assert.equal(rounds.length,2);
 assert.deepEqual(rounds[0].parts.map(p=>[p.key,p.user,p.answers]),[['a',0,[2]],['b',1,[3]]]);
 assert.deepEqual(rounds[1].parts.map(p=>[p.key,p.user]),[['a',4]]);
});

test('estado de cada painel vem da conversa; falha de envio não parece resposta',()=>{
 assert.deepEqual(dualPanelState({status:'sending'},null),{label:'A enviar',tone:'active',live:true});
 assert.equal(dualPanelState({status:'failed'},null).label,'Não enviado');
 assert.equal(dualPanelState({status:'uncertain'},null).label,'Entrega incerta');
 assert.equal(dualPanelState({status:'sent'},{status:'running'}).label,'A responder');
 assert.equal(dualPanelState({status:'sent'},{status:'waiting'}).attention,true);
 assert.equal(dualPanelState({status:'sent'},{status:'completed'}).label,'Pronta');
 assert.equal(dualPanelState({status:'sent'},{status:'interrupted'}).label,'Parado');
 assert.equal(dualPanelState({status:'failed'},{status:'failed'}).tone,'failed');
});

test('ronda reenviada junta as tentativas; só o principal escreve; imagens para cada destinatário',()=>{
 const record={active:true,principal:'a',target:'both',members:{a:{provider:'codex',conversationId:'A'},b:{provider:'opencode',conversationId:'B'}},
  rounds:[{id:'r',requestId:'q',targets:['a','b'],deliveries:{a:{provider:'codex',conversationId:'A',requestId:'q:a',status:'sent'},b:{provider:'opencode',conversationId:'B',requestId:'q:b~2',attempts:['q:b'],status:'sent'}}}]};
 const timeline=[{owner:{id:'A'},message:{role:'user',requestId:'q:a'}},{owner:{id:'B'},message:{role:'user',requestId:'q:b'}},{owner:{id:'A'},message:{role:'assistant',requestId:'q:a'}},{owner:{id:'B'},message:{role:'user',requestId:'q:b~2'}},{owner:{id:'B'},message:{role:'assistant',requestId:'q:b~2'}}];
 const [entry]=dualRounds(timeline,record),b=entry.parts[1];
 assert.equal(b.user,3);assert.deepEqual(b.users,[1,3]);assert.deepEqual(b.answers,[4]);
 const ui={record:()=>record,pendingFor:()=>null,memberSettings:(r,key)=>({model:key==='a'?'gpt':'sem-imagens'}),getModels:id=>id==='opencode'?[{id:'sem-imagens',images:false},{id:'com',images:true}]:[{id:'gpt'}],getState:()=>({providers:{}})};
 assert.equal(DualUI.prototype.readOnly.call(ui,{}),true);
 record.target='b';assert.equal(DualUI.prototype.readOnly.call(ui,{}),true);
 record.target='a';assert.equal(DualUI.prototype.readOnly.call(ui,{}),false);
 assert.equal(DualUI.prototype.imagesBlocked.call(ui,{}),false);
 record.target='both';assert.equal(DualUI.prototype.imagesBlocked.call(ui,{}),true);
 ui.memberSettings=()=>({model:'com'});ui.getModels=()=>[{id:'com',images:true}];assert.equal(DualUI.prototype.imagesBlocked.call(ui,{}),false);
});

