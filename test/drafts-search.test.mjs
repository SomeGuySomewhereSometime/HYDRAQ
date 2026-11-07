import test from 'node:test';
import assert from 'node:assert/strict';
import { ComposerDrafts, PersistentDraftMap } from '../public/drafts.js';
import { draftMode } from '../public/composer.js';
import { searchConversations } from '../public/conversation-search.js';
const storage=()=>{const data=new Map();return {getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)};};
test('rascunho persiste e preserva uma orientação expirada sem a converter em pedido',()=>{
 const store=storage(),drafts=new ComposerDrafts(store);drafts.save('chat:a','texto',{kind:'steer',conversationId:'a',turnId:'old'},'/project');
 const restored=new ComposerDrafts(store).get('chat:a');assert.equal(restored.text,'texto');assert.equal(restored.cwd,'/project');assert.equal(draftMode(restored.intent,{id:'a',turnId:'new',status:'running'}),'expired-steer');
 drafts.move('chat:a','chat:b');assert.equal(new ComposerDrafts(store).get('chat:a').text,'');drafts.clear('chat:b','texto');assert.equal(new ComposerDrafts(store).get('chat:b').text,'');
});
test('definições e cliente persistem; falha de armazenamento conserva edição',()=>{
 const store=storage(),settings=new PersistentDraftMap('settings',store);settings.set('provider','claude');settings.set('model',{model:'test'});assert.equal(new PersistentDraftMap('settings',store).get('provider'),'claude');
 const broken=new ComposerDrafts({getItem:()=>'{',setItem:()=>{throw Error('full');}});broken.save('a','intacto',null,'');assert.equal(broken.get('a').text,'intacto');
});
test('pesquisa global filtra conteúdo, acentos, projeto, data e ficheiro sem mensagens internas',()=>{
 const conversations=[{id:'a',provider:'claude',title:'Exemplo',organization:{projectId:'p',archived:true},items:[{type:'fileChange',path:'src/app.js'}],messages:[{text:'Correção da ligação',at:'2026-11-07T00:00:00Z'},{text:'segredo',internal:true}]},{id:'b',provider:'codex',messages:[{text:'Correção antiga',at:'2020-01-01'}]}];
 const results=searchConversations(conversations,{query:'correcao ligacao',provider:'claude',projectId:'p',since:'2026-11-01',file:'app.js'});assert.equal(results.length,1);assert.equal(results[0].conversationId,'a');assert.equal(searchConversations(conversations,{query:'segredo'}).length,0);assert.equal(searchConversations(conversations,{provider:'cursor'}).length,0);
});

test('versão identifica a instância e deteta alterações à página sem pedir reinício',async t=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
 const {runtimeVersion}=await import('../lib/runtime-version.mjs');
 const directory=await mkdtemp('/tmp/hydraq-version-test-');
 try{
  await writeFile(directory+'/app.js','original');const status=runtimeVersion(directory),before=status();
  assert.match(before.version,/^\d+$/);assert.ok(before.startedAt);assert.equal(before.restartRequired,false);
  await writeFile(directory+'/app.js','updated');t.mock.timers.enable({apis:['Date'],now:Date.now()+11000});
  const after=status();assert.notEqual(after.pageVersion,before.pageVersion);assert.equal(after.restartRequired,false);assert.equal(after.startedAt,before.startedAt);
 }finally{t.mock.timers.reset();await rm(directory,{recursive:true,force:true});}
});
