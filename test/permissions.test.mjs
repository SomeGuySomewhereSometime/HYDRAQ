import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {Providers} from '../lib/providers.mjs';
import {Permissions,permissionPolicy,permissionSupport,inheritedPermissions,turnPermissions} from '../lib/permissions.mjs';
import {OpinionClient} from './fixtures/opinion-client.mjs';
const wait=async f=>{const end=Date.now()+7000;while(!f()){if(Date.now()>end)throw Error('Tempo excedido.');await new Promise(r=>setTimeout(r,15));}};
class Client extends OpinionClient {
 snapshot(){const s=super.snapshot();return {...s,capabilities:{...s.capabilities,permissionProfiles:['read-only','project']}};}
 async send(id,text,requestId,settings={}){
  const result=await super.send(id,text,requestId,settings);
  Object.assign(this.conversation(id).turns.at(-1),turnPermissions(settings));this.changed();return result;
 }
}
async function setup(t,behavior='success'){
 const root=await mkdtemp('/tmp/hydraq-permissions-test-'),cwd=root+'/project';await mkdir(cwd);await writeFile(cwd+'/a.txt','before');
 const clients=Object.fromEntries(['codex','cursor'].map(id=>[id,new Client(id,root+'/'+id,{behavior})]));
 const hub=new Providers({dataDir:root+'/state',defaultCwd:cwd,clients});await hub.load();
 t.after(async()=>{await hub.close();await rm(root,{recursive:true,force:true});});
 const c=await hub.create({cwd,provider:'codex',model:'test',effort:'low',sandbox:'read-only'});
 return {hub,c:clients.codex.conversation(c.id),clients,cwd,root};
}
test('perfis recusam valores desconhecidos e a delegação conserva limites',()=>{
 assert.throws(()=>permissionPolicy({profile:'bypass'}),/inválido/);
 assert.throws(()=>permissionPolicy({profile:'read-only',network:'yes'}),/inválida/);
 assert.throws(()=>permissionPolicy({profile:'read-only',grant:true}),/desconhecidas/);
 assert.equal(permissionSupport('cursor',{profile:'read-only'}).includes('Nativo'),true);
 assert.deepEqual(inheritedPermissions({profile:'project',network:false,externalMcp:false,plan:false}),{profile:'read-only',network:false,externalMcp:false,plan:true});
});
test('envio normal guarda o perfil e a auditoria deteta alteração de Só leitura',async t=>{
 const {hub,c,clients,cwd}=await setup(t,'hold');
 await hub.send(c.id,'Lê o projeto.','read',{permissionPolicy:{profile:'read-only'}});
 assert.equal(c.turns[0].permissionPolicy.profile,'read-only');
 assert.equal(clients.codex.logs[0].settings.sandbox,'read-only');
 await writeFile(cwd+'/a.txt','changed');
 clients.codex.finish(c,'Concluído.');
 await wait(()=>c.turns[0].permissionAudit?.status==='violation');
 assert.equal(c.status,'uncertain');assert.deepEqual(c.turns[0].permissionAudit.paths,['a.txt']);
});
test('a ronda estrita valida todos antes de enviar; a mista regista o participante nativo',async t=>{
 const {hub,c,clients}=await setup(t);
 const {dual}=await hub.startDual(c.id,{participants:[{provider:'cursor',model:'test',effort:'low'}]});
 const body={text:'Consulta',requestId:'strict',multiVersion:2,revision:dual.revision||0,target:'all',permissionPolicy:{profile:'read-only'},settings:{}};
 await assert.rejects(hub.sendDual(dual.id,body),/Nativo|mista/);
 assert.equal(clients.codex.logs.length,0);assert.equal(clients.cursor.logs.length,0);
 const result=await hub.sendDual(dual.id,{...body,requestId:'mixed',permissionMode:'mixed'});
 assert.equal(result.accepted,true);
 assert.equal(clients.codex.logs[0].settings.permissionPolicy.profile,'read-only');
 assert.equal(clients.cursor.logs[0].settings.permissionPolicy.profile,'native');
 const round=hub.dual.record(dual.id).rounds[0];
 assert.equal(round.deliveries.b.permissionRequested.profile,'read-only');
 assert.match(round.deliveries.b.permissionFallback,/Nativo/);
});
test('a auditoria verifica .git aninhado e .hydraq mesmo fora da listagem Git',async t=>{
 const {hub,c,clients,cwd}=await setup(t,'hold');
 await mkdir(cwd+'/sub/.git/hooks',{recursive:true});await mkdir(cwd+'/.hydraq');
 await writeFile(cwd+'/sub/.git/hooks/pre-commit','before');
 await hub.send(c.id,'Implementa.','project',{permissionPolicy:{profile:'project'}});
 await writeFile(cwd+'/sub/.git/hooks/pre-commit','after');
 clients.codex.finish(c,'Concluído.');
 await wait(()=>c.turns[0].permissionAudit?.status==='violation');
 assert.ok(c.turns[0].permissionAudit.paths.includes('sub/.git/hooks/pre-commit'));
});

test('o Hydra protegido exige selecionar os servidores externos antes de enviar',async t=>{
 const {hub,c,clients}=await setup(t);
 hub.claudex.endpoint('http://127.0.0.1:1/api/claudex/tools');
 await assert.rejects(hub.claudex.create({conversationId:c.id,text:'Lê o projeto',requestId:'hydra-external',roles:['codex','claude'],members:{codex:{model:'test',effort:'low'},claude:{model:'test',effort:'low'}},author:'codex',workflow:2,requestMode:'read-only',permissionPolicy:{profile:'read-only',externalMcp:true}}),/servidores MCP/);
 assert.equal(clients.codex.logs.length,0);
});

test('reiniciar com auditoria pendente exige revisão e conserva o perfil',async t=>{
 const {hub,c,clients,root}=await setup(t);
 c.status='completed';
 c.turns.push({id:'interrupted-audit',requestId:'recover',status:'completed',permissionPolicy:permissionPolicy({profile:'read-only'}),permissionAudit:{status:'pending'}});
 const recovered=new Permissions(hub,root+'/recovery');
 await recovered.load();
 assert.equal(c.status,'uncertain');assert.equal(c.turns.at(-1).permissionAudit.status,'interrupted');
 assert.equal(c.turns.at(-1).permissionPolicy.profile,'read-only');
 assert.equal(clients.codex.logs.length,0);
});
