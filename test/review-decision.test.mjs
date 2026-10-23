import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReviewDecision,reviewReturnMode} from '../lib/review-decision.mjs';
const token='12345678-1234-1234-1234-123456789abc';
const block=(value, id=token)=>`<hydraq_review_decision request="${id}">\n${typeof value==='string'?value:JSON.stringify(value)}\n</hydraq_review_decision>`;
const answer=(value,id=token)=>'Parecer independente.\n'+block(value,id);
test('decisão estruturada preserva parecer e justificação, sem mostrar o envelope',()=>{
 for(const sendToPrincipal of [true,false]){
  const result=parseReviewDecision(answer({sendToPrincipal,reason:'  Há uma regressão concreta.  '}),token);
  assert.equal(result.text,'Parecer independente.');assert.deepEqual(result.recommendation,{status:'decided',sendToPrincipal,reason:'Há uma regressão concreta.'});
 }
 assert.equal(parseReviewDecision(answer('{"reason":"Diz \\"sendToPrincipal\\": false no exemplo.","sendToPrincipal":true}'),token).recommendation.status,'decided');
});
test('ausência, token alheio, duplicação e decisão fora do fim ficam pendentes',()=>{
 for(const text of ['Está aprovado, não vale a pena enviar.',answer({sendToPrincipal:true,reason:'Algo'},'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),answer({sendToPrincipal:true,reason:'Algo'})+'\n'+block({sendToPrincipal:false,reason:'Outro'}),answer({sendToPrincipal:true,reason:'Algo'})+' Depois há mais texto.',block({sendToPrincipal:true,reason:'Sem parecer'})]){
  const result=parseReviewDecision(text,token);assert.equal(result.recommendation.status,'pending');assert.equal(result.recommendation.sendToPrincipal,undefined);assert.equal(result.text,text);
 }
});
test('JSON ambíguo, tipos incorretos ou justificação inválida não autorizam envio',()=>{
 for(const value of ['{bad}',{sendToPrincipal:'true',reason:'Motivo'},{sendToPrincipal:true,reason:''},{sendToPrincipal:false,reason:' '.repeat(3)},{sendToPrincipal:true,reason:'x'.repeat(1001)},{sendToPrincipal:true,reason:'Motivo',extra:1},null,[], '{"sendToPrincipal":false,"sendToPrincipal":true,"reason":"Ambíguo"}'])assert.equal(parseReviewDecision(answer(value),token).recommendation.status,'pending');
});
test('políticas antigas conservam sempre/manual; modo novo é explícito',()=>{
 assert.equal(reviewReturnMode({returnToPrincipal:true}),'always');assert.equal(reviewReturnMode({returnToPrincipal:false}),'manual');assert.equal(reviewReturnMode({returnMode:'necessary'}),'necessary');assert.equal(reviewReturnMode({returnMode:'invalid',returnToPrincipal:true}),'invalid');assert.equal(reviewReturnMode({}),null);
});
