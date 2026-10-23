import test from 'node:test';
import assert from 'node:assert/strict';
import {antigravityDiagnostics,antigravityPermissionError,antigravityOpinionDiagnostics} from '../lib/antigravity-diagnostics.mjs';

test('quota exige evidência explícita e conserva a origem nativa',()=>{
  assert.equal(antigravityDiagnostics({error:{type:'QUOTA_EXCEEDED',message:'Limit'}})[0].code,'quota');
  assert.equal(antigravityDiagnostics({error:{type:'rate_limit_exceeded',message:'Limit'}})[0].code,'quota');
  assert.equal(antigravityDiagnostics({error:'Quota nativa esgotada'})[0].source,'native-error');
  assert.equal(antigravityDiagnostics({stderr:'ERROR: quota exceeded\n'})[0].source,'stderr');
  assert.deepEqual(antigravityDiagnostics({error:{type:'RESOURCE_EXHAUSTED',message:'Server busy'}}),[]);
  assert.deepEqual(antigravityDiagnostics({error:'HTTP 429'}),[]);
  assert.deepEqual(antigravityDiagnostics({stderr:'Warnings about quota settings are informational.'}),[]);
});
test('recusa de ferramenta não é confundida com quota nem com saída de comando',()=>{
  assert.equal(antigravityPermissionError({type:'PERMISSION_DENIED'}),true);
  assert.equal(antigravityPermissionError({message:'Aprovação indisponível no modo headless'}),true);
  assert.equal(antigravityPermissionError({message:'test failed; see permissions documentation'}),false);
  const diagnostics=antigravityDiagnostics({declined:1,tools:['run_command · git status'],empty:true});
  assert.deepEqual(diagnostics.map(d=>d.code),['permission','empty']);assert.match(diagnostics[0].detail,/git status/);
});
test('registo antigo de parecer vazio recupera a recusa observada sem inventar quota',()=>{
  const diagnostics=antigravityOpinionDiagnostics({provider:'antigravity',status:'failed',text:'',error:'O revisor terminou sem uma resposta.',facts:{declined:1,commands:[]}});
  assert.deepEqual(diagnostics.map(d=>d.code),['permission','empty']);
});
test('diagnóstico limita e filtra evidência sem publicar credenciais',()=>{
  const secret='sk-'+('a'.repeat(30));
  const [diagnostic]=antigravityDiagnostics({stderr:'ERROR: quota exceeded API_KEY='+secret+' '+('x'.repeat(2000))});
  assert.ok(!diagnostic.detail.includes(secret));assert.ok(diagnostic.detail.length<1300);assert.match(diagnostic.detail,/abreviado/);
});
