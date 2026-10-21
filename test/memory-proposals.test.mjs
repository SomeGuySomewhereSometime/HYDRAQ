import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm,stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MemoryProposals } from '../lib/memory-proposals.mjs';
async function setup(t){const dir=await mkdtemp('/tmp/hydraq-proposals-');t.after(()=>rm(dir,{recursive:true,force:true}));const store=new MemoryProposals(dir),projectId=randomUUID(),record={id:randomUUID(),projectId,requestId:randomUUID(),conversationId:randomUUID(),status:'running',text:'',sources:[],warnings:[],createdAt:new Date().toISOString()};return {dir,store,projectId,record};}

test('proposta guardada recupera conclusão após reinício sem enviar novo pedido',async t=>{
 const {dir,store,projectId,record}=await setup(t);await store.create(projectId,record);const restored=new MemoryProposals(dir);
 const conversations=[{id:record.conversationId,turns:[{requestId:record.requestId,status:'completed'}]}];let reads=0;await restored.recover(projectId,conversations,()=>{reads++;return 'Proposta final';});const result=(await restored.list(projectId)).records[0];assert.equal(result.status,'ready');assert.equal(result.text,'Proposta final');assert.equal(reads,1);assert.ok(result.warnings.length);await restored.recover(projectId,conversations,()=>{throw Error('Não repetir');});assert.equal((await stat(dir+'/'+projectId+'.json')).mode&0o777,0o600);
});

test('proposta interrompida fica incerta e conserva parcial sem aplicar memória',async t=>{
 const {dir,store,projectId,record}=await setup(t);await store.create(projectId,record);const restored=new MemoryProposals(dir);await restored.recover(projectId,[{id:record.conversationId,turns:[{requestId:record.requestId,status:'uncertain'}]}],()=> 'Texto parcial');const result=(await restored.list(projectId)).records[0];assert.equal(result.status,'uncertain');assert.equal(result.text,'Texto parcial');assert.match(result.error,/Nada foi reenviado/);
});

test('propostas corrompidas são preservadas e bloqueiam só o respetivo arquivo',async t=>{
 const {dir,store,projectId,record}=await setup(t);await store.create(projectId,record);const file=dir+'/'+projectId+'.json';await writeFile(file,'{danificado');await assert.rejects(store.update(projectId,record.id,{text:'Não sobrescrever'}),/mudaram no disco/);assert.equal(await readFile(file,'utf8'),'{danificado');const restored=new MemoryProposals(dir);await assert.rejects(restored.list(projectId),/original foi preservado/);
});
