import test from 'node:test';
import assert from 'node:assert/strict';
import {ProjectRecords} from '../lib/project-records.mjs';

test('diagnóstico do índice mede construção/cache/falha sem guardar projetos ou conteúdo',()=>{
 let revision=0,fail=false;
 const records=new ProjectRecords({projects:{data:{revision:0},group:()=>null},conversations:()=>{if(fail)throw Error('SEGREDO');return [];},collaborations:()=>[],cache:true,revision:()=>revision,diagnostics:true});
 records.entries('PROJETO_PRIVADO');records.entries('PROJETO_PRIVADO');revision++;records.entries('PROJETO_PRIVADO');
 const measured=records.diagnostics();assert.equal(measured.enabled,true);assert.equal(measured.entries.calls,3);assert.equal(measured.entries.hits,1);assert.equal(measured.entries.failures,0);assert.ok(measured.entries.totalMs>=0);assert.ok(measured.entries.last.durationMs>=0);assert.equal(measured.entries.last.cacheHit,false);
 revision++;fail=true;assert.throws(()=>records.entries('PROJETO_PRIVADO'),/SEGREDO/);
 assert.equal(records.diagnostics().entries.failures,1);assert.doesNotMatch(JSON.stringify(records.diagnostics()),/SEGREDO|PROJETO_PRIVADO/);
 const disabled=new ProjectRecords({projects:{data:{}},conversations:()=>[],collaborations:()=>[],diagnostics:false});disabled.entries('p');assert.deepEqual(disabled.diagnostics(),{enabled:false,entries:null});
});
