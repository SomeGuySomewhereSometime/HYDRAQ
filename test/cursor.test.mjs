import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Cursor, parseCursorModels } from '../lib/cursor.mjs';
import { readCursorCredential, withoutCursorCredentials } from '../lib/cursor-auth.mjs';
import { Providers } from '../lib/providers.mjs';
import { ClaudeCode } from '../lib/claude.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const waitFor=async predicate=>{const until=Date.now()+7000;while(!predicate()){if(Date.now()>until)throw new Error('Tempo excedido.');await new Promise(r=>setTimeout(r,10));}};
async function setup(t,env={}) {
 const directory=await mkdtemp(path.join(os.tmpdir(),'hydraq-cursor-test-'));
 const auth=path.join(directory,'auth');await mkdir(auth,{mode:0o700});
 const credentialFile=path.join(auth,'cursor.env');await writeFile(credentialFile,'CURSOR_API_KEY=TEST-CURSOR-SECRET\n',{mode:0o600});
 const options={dataDir:path.join(directory,'state/cursor'),defaultCwd:directory,credentialFile,executable:process.execPath,prefixArgs:[path.join(root,'test/fixtures/fake-cursor.mjs')],env:{...process.env,CURSOR_API_KEY:'INHERITED-MUST-NOT-WORK',CURSOR_AUTH_TOKEN:'STRIP',CURSOR_API_ENDPOINT:'https://invalid',FAKE_CURSOR_LOG:path.join(directory,'prompts.log'),...env}};
 const client=new Cursor(options);await client.load();
 const clients=[client];t.after(async()=>{for(const c of clients)await c.close();await new Promise(r=>setTimeout(r,60));await rm(directory,{recursive:true,force:true});});
 return {directory,credentialFile,client,options,clients,log:async()=> (await readFile(path.join(directory,'prompts.log'),'utf8')).trim().split('\n').map(JSON.parse)};
}

test('chave privada: ficheiro literal, dono/permissões, recusa de symlinks e ambiente sanitizado',async t=>{
 const {credentialFile,client,directory}=await setup(t);
 assert.equal(await readCursorCredential(credentialFile),'TEST-CURSOR-SECRET');
 assert.equal(client.env.CURSOR_API_KEY,undefined);assert.equal(client.env.CURSOR_AUTH_TOKEN,undefined);assert.equal(client.env.CURSOR_API_ENDPOINT,undefined);
 assert.deepEqual(withoutCursorCredentials({CURSOR_API_KEY:'x',CURSOR_AUTH_TOKEN:'y',OK:'z'}),{OK:'z'});
 await chmod(credentialFile,0o644);await assert.rejects(readCursorCredential(credentialFile),/600/);await chmod(credentialFile,0o600);
 await writeFile(credentialFile,'CURSOR_API_KEY=SECRET-DO-NOT-PRINT\nEVIL=1\n');
 await assert.rejects(readCursorCredential(credentialFile),e=>/única linha/.test(e.message)&&!e.message.includes('SECRET-DO-NOT-PRINT'));
 await writeFile(credentialFile,'CURSOR_API_KEY=TEST-CURSOR-SECRET\n');
 const link=path.join(path.dirname(credentialFile),'link.env');await symlink(credentialFile,link);await assert.rejects(readCursorCredential(link),/simbólicas/);
 const dirlink=path.join(directory,'authlink');await symlink(path.dirname(credentialFile),dirlink);await assert.rejects(readCursorCredential(path.join(dirlink,'cursor.env')),/simbólicas/);
 await rm(credentialFile);await assert.rejects(client.connect(),/Cursor precisa de configuração/);assert.equal(client.connection,'disconnected');
});

test('catálogo Grok, 500K/Fast off, troca de parâmetros e retoma sem duplicar replay',async t=>{
 const {client,directory,options,clients,log}=await setup(t);await client.connect();
 assert.deepEqual(client.models.map(m=>m.id),['grok-4.7','grok-4.6','grok-4.5']);
 assert.equal(client.models[0].defaultContext,'500k');
 const c=await client.create({cwd:directory,model:'grok-4.7',effort:'low'});
 assert.equal(c.fast,false);assert.equal(c.context,'500k');
 await client.send(c.id,'first','r1');await waitFor(()=>c.status==='completed');const sid=c.threadId;
 assert.match(c.messages.at(-1).text,/500k fast=false mode=agent/);assert.ok(!JSON.stringify(c).includes('PRIVATE-THOUGHT'));
 await client.send(c.id,'second','r2',{context:'256k',fast:true,effort:'medium'});await waitFor(()=>c.status==='completed');assert.equal(c.threadId,sid);
 await client.close();const resumed=new Cursor(options);clients.push(resumed);await resumed.load();await resumed.connect();
 const loaded=resumed.conversation(c.id);await resumed.send(c.id,'third','r3');await waitFor(()=>loaded.status==='completed');
 assert.equal(loaded.threadId,sid);assert.equal(loaded.context,'256k');assert.equal(loaded.fast,true);assert.equal(loaded.effort,'medium');
 assert.ok(!JSON.stringify(loaded).includes('REPLAY-DO-NOT-DUPLICATE'));
 await resumed.send(c.id,'fourth','r4',{model:'grok-4.6',effort:'low',context:null,fast:false});await waitFor(()=>loaded.status==='completed');
 assert.equal(loaded.context,null);assert.equal(loaded.model,'grok-4.6');
 assert.equal((await log()).length,4);
 await assert.rejects(resumed.send(c.id,'bad','r5',{context:'500k'}),/Contexto/);
});

test('autorizações nativas, perguntas e planos: respostas únicas, recusa, cancelamento e expiração',async t=>{
 const {client,directory}=await setup(t);const hub=new Providers({clients:{cursor:client}});await hub.connect('cursor');
 const c=await hub.create({provider:'cursor',cwd:directory,model:'grok-4.7',effort:'low'});const chat=client.conversation(c.id);
 await hub.send(c.id,'permission','p1');await waitFor(()=>chat.status==='waiting');
 let request=hub.snapshot().approvals[0];assert.match(request.id,/^cursor:/);assert.equal(request.session,undefined);
 await assert.rejects(hub.respond(request.id,{optionId:'fabricated'}),/anunciadas/);
 const response=hub.respond(request.id,{optionId:'native-allow'});await assert.rejects(hub.respond(request.id,{optionId:'native-allow'}),/resolvido/);await response;
 await waitFor(()=>chat.status==='completed');assert.equal(await readFile(path.join(directory,'approved.txt'),'utf8'),'APPROVED');
 await hub.send(c.id,'permission','p2');await waitFor(()=>chat.status==='waiting');await hub.respond(hub.snapshot().approvals[0].id,{optionId:'native-reject'});
 await waitFor(()=>chat.status==='completed');assert.equal(chat.items.findLast(i=>i.type==='commandExecution').status,'declined');
 await hub.send(c.id,'question','q');await waitFor(()=>chat.status==='waiting');request=hub.snapshot().approvals[0];
 await assert.rejects(hub.respond(request.id,{answers:[{questionId:'q',selectedOptionIds:['wrong']}]}),/válidas/);
 await hub.respond(request.id,{answers:[{questionId:'q',selectedOptionIds:['b']}]});await waitFor(()=>chat.status==='completed');assert.equal(chat.messages.at(-1).text,'ESCOLHIDA-b');
 await hub.send(c.id,'plan','plan');await waitFor(()=>chat.status==='waiting');await hub.respond(hub.snapshot().approvals[0].id,{decision:'decline'});await waitFor(()=>chat.status==='completed');assert.equal(chat.messages.at(-1).text,'PLANO-rejected');
 await hub.send(c.id,'question','cancel');await waitFor(()=>chat.status==='waiting');const expired=hub.snapshot().approvals[0].id;await hub.interrupt(c.id);await waitFor(()=>chat.status==='interrupted');
 assert.equal(hub.snapshot().approvals.length,0);await assert.rejects(hub.respond(expired,{decision:'cancel'}),/resolvido/);
 await hub.send(c.id,'question','cancel-response');await waitFor(()=>chat.status==='waiting');await hub.respond(hub.snapshot().approvals[0].id,{decision:'cancel'});await waitFor(()=>chat.status==='interrupted');
 await hub.send(c.id,'unsupported','u');await waitFor(()=>chat.status==='completed');assert.equal(chat.messages.at(-1).text,'UNSUPPORTED--32601');
});

test('queda mantém saída parcial, não reenvia e não confirma entrega; restart expira perguntas',async t=>{
 const {client,directory,options,clients,log}=await setup(t);await client.connect();
 const c=await client.create({cwd:directory,model:'grok-4.7',effort:'low'});
 await client.send(c.id,'disconnect','d');await waitFor(()=>c.status==='uncertain');assert.equal(c.messages.at(-1).text,'PRIMEIRA PARTE');
 assert.equal((await client.send(c.id,'disconnect','d')).duplicate,true);assert.equal((await log()).length,1);
 await assert.rejects(client.send(c.id,'again','a'),/incerto/);
 const c2=await client.create({cwd:directory,model:'grok-4.7',effort:'low'});await client.send(c2.id,'question','q');await waitFor(()=>c2.status==='waiting');await client.persist();
 const after=new Cursor(options);clients.push(after);await after.load();assert.equal(after.conversation(c2.id).status,'uncertain');assert.equal(after.conversation(c2.id).turns[0].interactions[0].status,'expired');assert.equal(after.snapshot().approvals.length,0);
 await client.interrupt(c2.id);await waitFor(()=>c2.status==='interrupted');
});

test('eventos de ações preservam factos além da UI, não copiam raciocínio e ocultam a chave',async t=>{
 const {client,directory}=await setup(t);await client.connect();const c=await client.create({cwd:directory,model:'grok-4.7',effort:'low'});
 await client.send(c.id,'many','m');await waitFor(()=>c.status==='completed');assert.equal(Object.values(c.turns[0].actionFacts).filter(a=>a.type==='commandExecution').length,205);assert.ok(c.items.length<=200);
 await client.send(c.id,'edit','e');await waitFor(()=>c.status==='completed');assert.equal(c.turns.at(-1).actionFacts[`${c.turns.at(-1).id}:${c.items.findLast(i=>i.type==='fileChange').nativeId}`].files[0],'edited.txt');
 await client.send(c.id,'echo-secret','secret');await waitFor(()=>c.status==='completed');await client.persist();
 assert.equal(c.messages.at(-1).text,'[CHAVE OCULTA]');
 assert.ok(!JSON.stringify(client.snapshot()).includes('TEST-CURSOR-SECRET'));assert.ok(!(await readFile(path.join(client.dataDir,'state.json'),'utf8')).includes('TEST-CURSOR-SECRET'));
 const partial=await client.create({cwd:directory,model:'grok-4.7',effort:'low'});await client.send(partial.id,'partial-secret','partial');await waitFor(()=>partial.status==='uncertain');assert.ok(!JSON.stringify(partial).includes('TEST-CURSOR-SEC'));
 await client.send(c.id,'mismatch','wrong');await waitFor(()=>c.status==='uncertain');assert.ok(!c.messages.some(m=>m.text==='wrong'));
});

test('passagem Claude → Cursor → Claude e regresso conserva contexto/Fast e a sessão Cursor',async t=>{
 const {client,directory,clients,log}=await setup(t);
 const claude=new ClaudeCode({dataDir:path.join(directory,'state/claude'),defaultCwd:directory,executable:process.execPath,prefixArgs:[path.join(root,'test/fixtures/fake-claude.mjs')]});clients.push(claude);
 const hub=new Providers({clients:{cursor:client,claude},git:async()=>null,inspect:async()=>({files:{},warnings:[],complete:true})});await claude.load();await hub.connect('cursor');await hub.connect('claude');
 const source=await hub.create({provider:'claude',cwd:directory,model:'haiku',effort:'low',sandbox:'plan'});
 await hub.send(source.id,'original','a');await waitFor(()=>claude.conversation(source.id).status==='completed');
 await assert.rejects(hub.send(source.id,'invalid','bad',{provider:'cursor',model:'grok-4.7',effort:'low',context:'999k'}),/Contexto/);assert.equal(claude.conversation(source.id).turns.length,1);
 const switched=await hub.send(source.id,'continue','b',{provider:'cursor',model:'grok-4.7',effort:'low',context:'500k',fast:true});
 await waitFor(()=>!hub.handoff&&client.conversation(switched.conversationId).status==='completed');const target=client.conversation(switched.conversationId);const sid=target.threadId;
 assert.equal(target.sandbox,'plan');assert.equal(target.fast,true);assert.match((await log()).at(-1).text,/<hydraq_handoff>/);
 await hub.send(target.id,'return','c',{provider:'claude',model:'haiku',effort:'low',handoffMode:'model'});await waitFor(()=>!hub.handoff&&claude.conversation(source.id).status==='completed');
 assert.equal(target.handoffSummaries.at(-1).text,'RESUMO-CURSOR');
 await hub.send(source.id,'back','d',{provider:'cursor',handoffMode:'quick'});await waitFor(()=>!hub.handoff&&target.status==='completed');
 assert.equal(target.threadId,sid);assert.equal(target.fast,true);assert.equal(target.context,'500k');assert.equal(target.sandbox,'plan');
});
