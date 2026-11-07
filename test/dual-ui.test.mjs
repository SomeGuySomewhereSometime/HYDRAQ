import test from 'node:test';
import assert from 'node:assert/strict';
import {dualSendLabel,dualRounds,roundMembers,dualPanelState,activeDual,isReadMode,DualUI} from '../public/dual.js';

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


test('a troca de cliente não muda os nomes das rondas anteriores; o campo de cliente substitui quem está a falar',async()=>{
 const record={active:true,principal:'a',target:'b',members:{a:{provider:'codex',conversationId:'A'},b:{provider:'opencode',conversationId:'O'}},
  rounds:[{id:'r',requestId:'q',targets:['a'],members:{a:{provider:'codex',conversationId:'A'},b:{provider:'claude',conversationId:'C'}},deliveries:{a:{provider:'codex',conversationId:'A',requestId:'q:a',status:'sent'}}},{id:'old',requestId:'p',targets:['a'],deliveries:{}}]};
 assert.equal(roundMembers(record,record.rounds[0]).b.provider,'claude');
 // Rounds saved before this record existed fall back on the current pair, as before.
 assert.equal(roundMembers(record,record.rounds[1]).b.provider,'opencode');
 const calls=[],toasts=[],ui={record:()=>record,getCurrent:()=>({id:'A'}),pendingFor:()=>null,toast:m=>toasts.push(m),offered:id=>id!=='opencode-off',editMember:(key,provider)=>calls.push([key,provider]),configure:()=>calls.push(['configure'])};
 DualUI.prototype.chooseClient.call(ui,'opencode');assert.deepEqual(calls,[]);
 DualUI.prototype.chooseClient.call(ui,'codex');assert.match(toasts[0],/Codex já participa/);
 DualUI.prototype.chooseClient.call(ui,'antigravity');assert.deepEqual(calls,[['b','antigravity']]);
 record.target='both';DualUI.prototype.chooseClient.call(ui,'cursor');assert.deepEqual(calls.at(-1),['a','cursor']);
 ui.offered=()=>false;DualUI.prototype.chooseClient.call(ui,'antigravity');assert.match(toasts.at(-1),/Liga primeiro o Antigravity/);assert.equal(calls.length,2);ui.offered=()=>true;
});

test('a barra espera pela confirmação do servidor antes de mostrar um participante desligado',async()=>{
 const record={id:'d1',principal:'a',members:{a:{provider:'codex'},b:{provider:'claude'},c:{provider:'antigravity'}}};
 let finish,request;
 const ui=Object.assign(Object.create(DualUI.prototype),{
  record:()=>record,pendingFor:()=>null,getCurrent:()=>null,running:()=>false,refresh:async()=>{},
  api:(url,body)=>{request={url,body};return new Promise(resolve=>{finish=()=>{delete record.members[body.key];resolve({dual:record});};});},
 });
 assert.equal(ui.dockClick('claude'),true);
 assert.equal(ui.memberBusy,true);
 await Promise.resolve();
 assert.equal(request.url,'/api/dual/d1/remove');
 assert.equal(request.body.key,'b');
 assert.deepEqual(ui.activeProviders(),['codex','claude','antigravity']);
 finish();
 await ui.memberTask;
 assert.equal(ui.memberBusy,false);
 assert.deepEqual(ui.activeProviders(),['codex','antigravity']);
});

test('ao reordenar os lugares do rascunho, o cliente principal que ficou conserva o papel',()=>{
 let source='codex';
 const pending={principal:'c',participants:['claude','antigravity','cursor'].map(provider=>({provider}))};
 const ui=Object.assign(Object.create(DualUI.prototype),{
  record:()=>null,getCurrent:()=>null,pendingFor:()=>pending,getProvider:()=>source,setProvider:id=>{source=id;},
 });
 ui.dockClick('claude');
 assert.equal(ui.pendingMembers()[pending.principal].provider,'antigravity');
 ui.dockClick('codex');
 assert.equal(source,'antigravity');
 assert.equal(ui.pendingMembers()[pending.principal].provider,'antigravity');
 ui.dockClick('cursor');
 assert.equal(ui.incomplete(),true);
});

test('OpenCode só entra depois de carregar um modelo válido para a conversa atual',async()=>{
 const pending={principal:'a',participants:[{provider:'claude'}]};
 let available=[],key='chat-a',finish,loadCalls=0;
 const ui=Object.assign(Object.create(DualUI.prototype),{
  record:()=>null,getCurrent:()=>null,getKey:()=>key,getProvider:()=>'codex',pendingFor:()=>pending,
  offered:()=>true,getModels:()=>available,
  loadModels:(provider,force)=>{assert.equal(provider,'opencode');assert.equal(force,true);loadCalls++;return new Promise(resolve=>{finish=()=>{available=[{id:'open-free',efforts:['low']}];resolve();};});},
 });
 ui.dockClick('opencode');
 await Promise.resolve();
 assert.deepEqual(ui.activeProviders(),['codex','claude']);
 key='chat-b';
 finish();await ui.memberTask;
 assert.deepEqual(ui.activeProviders(),['codex','claude']);
 available=[];
 ui.dockClick('opencode');
 await Promise.resolve();
 finish();await ui.memberTask;
 assert.equal(loadCalls,2);
 assert.equal(pending.participants.at(-1).model,'open-free');
});

test('renderDock mantém os cinco clientes visíveis e destaca os ligados no Multi com aria-pressed',()=>{
 const makePill=agent=>{
  const tag={textContent:'Tag'},name={before(star){pill.star=star;}};
  const pill={
   dataset:{agent,tip:`Mudar para ${agent}`},
   hidden:true,
   attrs:{},
   setAttribute(k,v){this.attrs[k]=v;},
   removeAttribute(k){delete this.attrs[k];},
   querySelector(sel){if(sel==='.agent-pill-tag')return tag;if(sel==='.agent-pill-name')return name;return null;},
  };
  return pill;
 };
 const pills=['codex','antigravity','claude','cursor','opencode'].map(makePill);
 const dock={
  attrs:{},
  toggleAttribute(k,v){if(v)this.attrs[k]='';else delete this.attrs[k];},
  setAttribute(k,v){this.attrs[k]=v;},
  querySelectorAll(){return pills;},
 };
 const prevDoc=globalThis.document;
 globalThis.document={
  getElementById:id=>id==='agent-dock'?dock:null,
  createElement:(tag)=>({tag,className:'',textContent:'',attrs:{},setAttribute(k,v){this.attrs[k]=v;}}),
 };
 try{
  const dualRec={id:'d2',active:true,principal:'a',members:{a:{provider:'codex'},b:{provider:'cursor'}}};
  const ui=Object.assign(Object.create(DualUI.prototype),{record:()=>dualRec,pendingFor:()=>null,memberSettings:()=>({model:'m1',effort:'high'}),getModels:()=>[{id:'m1',name:'Model 1'}]});
  assert.equal(DualUI.prototype.renderDock.call(ui,{}),true);
  assert.equal('data-dual' in dock.attrs,true);
  for(const pill of pills){
   assert.equal(pill.hidden,false);
   assert.equal(pill.attrs['aria-pressed'],pill.dataset.agent==='codex'||pill.dataset.agent==='cursor'?'true':'false');
  }
  assert.equal(pills[0].dataset.dualKey,'a');
  assert.equal(pills[3].dataset.dualKey,'b');
  assert.equal(pills[1].dataset.dualKey,undefined);
  assert.equal(pills[0].star?.textContent,'★');
 }finally{
  globalThis.document=prevDoc;
 }
});
