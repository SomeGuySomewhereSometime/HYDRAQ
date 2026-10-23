import test from 'node:test';
import assert from 'node:assert/strict';
import {opinionTranscriptGroups,opinionResultAnchors,opinionDelivery,automaticParticipants,automaticReturnMode,opinionContextLabel} from '../public/opinions.js';
const entry=(role,requestId,extra={},owner='source')=>({owner:{id:owner},message:{role,requestId,...extra}});

test('interface conserva políticas antigas e mostra o modo condicional explícito',()=>{
 assert.equal(automaticReturnMode({returnToPrincipal:true}),'always');
 assert.equal(automaticReturnMode({returnToPrincipal:false}),'manual');
 assert.equal(automaticReturnMode({returnMode:'necessary'}),'necessary');
});
test('parecer não recomendado ou sem decisão fica identificado como separado',()=>{
 const separate=opinionDelivery('job');
 assert.match(opinionContextLabel({recommendation:{status:'decided',sendToPrincipal:false}},separate),/não recomendou enviar/);
 assert.match(opinionContextLabel({recommendation:{status:'decided',sendToPrincipal:true}},separate),/recomenda enviar/);
 assert.match(opinionContextLabel({recommendation:{status:'pending'}},separate),/pendente/);
 const sent=opinionDelivery('job',[{status:'submitted',jobIds:['job']}]);
 assert.equal(opinionContextLabel({recommendation:{status:'decided',sendToPrincipal:false}},sent),'Enviado ao principal');
});

test('estado do contexto distingue parecer separado, enviado e entrega incerta',()=>{
 assert.equal(opinionDelivery('a').state,'separate');
 assert.equal(opinionDelivery('a',[{jobIds:['b'],status:'submitted'}]).state,'separate');
 assert.equal(opinionDelivery('a',[{jobIds:['a'],status:'failed'}]).state,'separate');
 assert.equal(opinionDelivery('a',[{jobIds:['a'],status:'sending'}]).state,'sending');
 assert.equal(opinionDelivery('a',[{jobIds:['a'],status:'uncertain'}]).state,'uncertain');
 assert.equal(opinionDelivery('a',[{jobIds:['a'],status:'uncertain'},{jobIds:['a'],status:'submitted'}]).state,'submitted');
});
test('configuração antiga de revisor único continua legível sem inventar escrita',()=>{
 const participant={provider:'claude',model:'test',effort:'low'};
 assert.deepEqual(automaticParticipants({participant}),[participant]);
 assert.deepEqual(automaticParticipants({participants:[participant,{...participant,provider:'codex'}]}).map(p=>p.provider),['claude','codex']);
 assert.deepEqual(automaticParticipants(null),[]);
});

test('alternativa segue a resposta original antes da próxima pergunta',()=>{
 const timeline=[entry('user','a'),entry('assistant','a'),entry('user','b'),entry('assistant','b')];
 assert.deepEqual(opinionResultAnchors(timeline),[1,1,3,3]);
 assert.equal(timeline[0].message.role,'user');
});
test('alternativa segue todos os blocos de resposta do mesmo pedido',()=>{
 assert.deepEqual(opinionResultAnchors([entry('user','a'),entry('assistant','a'),entry('assistant','a'),entry('assistant','a')]),[3,1,2,3]);
});
test('orientação a meio do turno não separa a pergunta da resposta final',()=>{
 assert.equal(opinionResultAnchors([entry('user','a'),entry('assistant','a'),entry('user','steer',{kind:'steer'}),entry('assistant','a')])[0],3);
});
test('ID de turno permite posicionar respostas sem requestId',()=>{
 assert.equal(opinionResultAnchors([entry('user',null,{turnId:'turn'}),entry('assistant',null,{turnId:'turn'}),entry('user','later')])[0],1);
});
test('histórico antigo usa só as respostas até à pergunta seguinte',()=>{
 assert.deepEqual(opinionResultAnchors([entry('user',null),entry('assistant',null),entry('assistant',null),entry('user',null),entry('assistant',null)]),[2,1,2,4,4]);
});
test('resumos internos e IDs repetidos noutro cliente não deslocam uma alternativa',()=>{
 const timeline=[entry('user','a'),entry('assistant','a'),entry('assistant','a',{internal:'summary'}),entry('user','a',{},'other'),entry('assistant','a',{},'other')];
 assert.equal(opinionResultAnchors(timeline)[0],1);
 assert.equal(opinionResultAnchors(timeline)[3],4);
});
test('pergunta sem resposta mantém o ponto de apresentação próprio',()=>{
 assert.deepEqual(opinionResultAnchors([entry('user','a'),entry('user','b'),entry('assistant','b')]),[0,2,2]);
});

const reviewedTimeline=()=>[entry('user','original',{id:'question'}),entry('assistant','original',{id:'initial-1'}),entry('assistant','original',{id:'initial-2'}),entry('user','return',{id:'delivery'}),entry('assistant','return',{id:'final'}),entry('user','next',{id:'next'})];
const reviewState=(overrides={})=>({batches:[{id:'batch',conversationId:'source',sourceKey:'initial-2',automaticCycleId:'cycle',jobs:[{id:'job'}]}],merges:[{id:'merge',conversationId:'source',requestId:'return',jobIds:['job']}],automatic:{cycles:[{id:'cycle',conversationId:'source',requestId:'original',returnRequestId:'return',status:'completed',config:{returnMode:'always'},...overrides}]}});
test('revisão automática agrupa todos os blocos iniciais e entrega, mantendo a resposta final fora',()=>{
 const [group]=opinionTranscriptGroups(reviewedTimeline(),reviewState());assert.deepEqual(group.original,[1,2]);assert.deepEqual(group.questions,[0]);assert.deepEqual(group.deliveries,[3]);assert.deepEqual(group.finals,[4]);assert.deepEqual(group.batchIds,['batch']);assert.deepEqual(group.cycleIds,['cycle']);
});
test('envio manual e segunda opinião avulsa conservam a resposta original no chat',()=>{
 assert.deepEqual(opinionTranscriptGroups(reviewedTimeline(),reviewState({config:{returnMode:'manual'}})),[]);
 const state=reviewState();state.automatic.cycles=[];assert.deepEqual(opinionTranscriptGroups(reviewedTimeline(),state),[]);
});
test('condicional sem parecer enviado conserva a resposta original, inclusive com decisões negativas',()=>{
 const state=reviewState({config:{returnMode:'necessary'}});state.merges=[];
 assert.deepEqual(opinionTranscriptGroups(reviewedTimeline().slice(0,3),state),[]);
 assert.equal(opinionTranscriptGroups(reviewedTimeline(),state).length,1);
});
test('resposta ainda em streaming e revisão falhada sem avaliação não escondem o original',()=>{
 const timeline=reviewedTimeline();timeline[2].message.streaming=true;assert.deepEqual(opinionTranscriptGroups(timeline,reviewState()),[]);
 assert.deepEqual(opinionTranscriptGroups(reviewedTimeline().slice(0,3),reviewState({status:'failed'})),[]);
});
test('IDs iguais noutro cliente e notas internas não entram no grupo de revisão',()=>{
 const timeline=reviewedTimeline();timeline.push(entry('assistant','original',{id:'other'},'other'),entry('assistant','original',{id:'private',internal:'summary'}));
 const [group]=opinionTranscriptGroups(timeline,reviewState());assert.deepEqual(group.original,[1,2]);assert.deepEqual(group.finals,[4]);
});
test('ciclo arquivado ainda agrupa o original quando o lote não está na página carregada',()=>{
 const state=reviewState();state.batches=[];const [group]=opinionTranscriptGroups(reviewedTimeline(),state);assert.deepEqual(group.original,[1,2]);assert.deepEqual(group.deliveries,[3]);assert.deepEqual(group.finals,[4]);
});
