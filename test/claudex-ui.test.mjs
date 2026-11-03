import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Providers } from '../lib/providers.mjs';
import { createLooseFolder } from '../lib/folders.mjs';
import { ClaudeXUI } from '../public/claudex.js';
import { OpinionClient } from './fixtures/opinion-client.mjs';

async function setup(t,{loseResponse=true,roles=['codex','claude']}={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'hydraq-ui-retry-'));
  const cwd=path.join(dir,'project');await mkdir(cwd);await writeFile(path.join(cwd,'value.txt'),'before');
  const clients=Object.fromEntries(['codex','claude','antigravity'].map(id=>[id,new OpinionClient(id,path.join(dir,id),{behavior:'hold'})]));
  const hub=new Providers({dataDir:path.join(dir,'state'),defaultCwd:cwd,clients,git:async()=>[]});
  await hub.load();await hub.connectAll();
  hub.claudex.endpoint('http://127.0.0.1:1/api/claudex/tools');hub.claudex.kick=()=>{};
  const storage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{setItem(){}}});
  t.after(async()=>{try{await hub.close();}finally{await rm(dir,{recursive:true,force:true});if(storage)Object.defineProperty(globalThis,'localStorage',storage);else delete globalThis.localStorage;}});
  const calls=[],results=[];let folders=0;
  const ui=Object.assign(Object.create(ClaudeXUI.prototype),{
    selected:null,detail:null,pending:null,sending:false,inlineConversation:null,
    prompt:{value:'Compara duas soluções.'},settings:{open:true},
    controls:Object.fromEntries(Object.entries({project:'',cwd:'',workspace:'direct',requestMode:'auto',codexModel:'test',codexEffort:'low',claudeModel:'test',claudeEffort:'low',antigravityModel:'test',antigravityEffort:'low',author:'codex',consensus:'true'}).map(([key,value])=>[key,{value}])),
    guards:()=>({turns:30,minutes:60}),roles:()=>roles,getState:()=>hub.snapshot(),
    render(){},renderDetail(){},saveDraft(){},refresh:async()=>{},toast(){},
    api:async(route,body)=>{
      if(route==='/api/folders/loose'){folders++;return {path:await createLooseFolder(path.join(dir,'conversas'))};}
      if(route.endsWith('/resume')){calls.push({route,...structuredClone(body)});return hub.claudex.resume(ui.selected,body);}
      assert.equal(route,'/api/claudex');calls.push(structuredClone(body));
      const result=await hub.claudex.create(body);results.push(result);
      if(loseResponse){loseResponse=false;throw Error('Resposta perdida depois de o servidor aceitar.');}
      return result;
    },
  });
  return {ui,hub,calls,results,folderCount:()=>folders,dir,cwd};
}

test('Hydra no separador recupera a criação sem mudar pasta ou duplicar a tarefa',async t=>{
  const {ui,hub,calls,results,folderCount}=await setup(t);
  await assert.rejects(ui.submit(),/Resposta perdida/);
  await ui.submit();
  assert.equal(folderCount(),1);assert.equal(hub.claudex.records.length,1);
  assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(calls[0].cwd,calls[1].cwd);
  assert.equal(results[1].duplicate,true);assert.equal(ui.selected,results[0].task.id);assert.equal(ui.pending,null);
});

test('Hydra na conversa recupera a criação automática depois de perder a resposta',async t=>{
  const {ui,hub,calls,results,folderCount}=await setup(t),text=ui.prompt.value;
  assert.equal(await ui.requestInline(text,{cwd:''}),null);
  const recovered=await ui.requestInline(text,{cwd:''});
  assert.equal(folderCount(),1);assert.equal(hub.claudex.records.length,1);
  assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(calls[0].cwd,calls[1].cwd);
  assert.equal(results[1].duplicate,true);assert.equal(recovered.id,results[0].task.id);
});

test('Hydra novo sem pasta não herda a pasta do pedido anterior',async t=>{
  const {ui,calls,folderCount,dir}=await setup(t);
  ui.controls.cwd.value=dir;
  await ui.requestInline(ui.prompt.value,{cwd:''});
  assert.equal(folderCount(),1);assert.notEqual(calls[0].cwd,dir);
  assert.equal(path.dirname(calls[0].cwd),path.join(dir,'conversas'));
});

for(const inline of [false,true])test(`Hydra ${inline?'na conversa':'no separador'} conserva a cópia privada ao repetir uma resposta perdida`,async t=>{
  const {ui,hub,calls,results,cwd}=await setup(t);
  ui.controls.workspace.value='copy';ui.controls.cwd.value=cwd;
  const submit=()=>inline?ui.requestInline(ui.prompt.value,{cwd}):ui.submit();
  if(inline)assert.equal(await submit(),null);else await assert.rejects(submit(),/Resposta perdida/);
  const record=hub.claudex.records[0],copy=record.workspace.copy;
  await submit();
  assert.equal(hub.claudex.records.length,1);assert.equal(calls.length,2);
  assert.equal(calls[0].workspace,'copy');assert.equal(calls[1].workspace,'copy');
  assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(calls[0].cwd,calls[1].cwd);
  assert.equal(results[1].duplicate,true);assert.equal(record.workspaceMode,'copy');
  assert.equal(record.workspace.copy,copy);assert.notEqual(copy,cwd);
  assert.equal(await readFile(path.join(cwd,'value.txt'),'utf8'),'before');
});

for(const mode of ['direct','copy'])test(`Hydra conserva ${mode==='copy'?'a cópia privada':'o projeto por omissão'} ao retomar a tarefa`,async t=>{
  const {ui,hub,calls,cwd}=await setup(t,{loseResponse:false});
  ui.controls.cwd.value=cwd;ui.controls.workspace.value=mode;await ui.submit();
  const copy=ui.detail.workspace?.copy;
  assert.equal(calls[0].workspace,mode);assert.equal(ui.detail.workspaceMode,mode);
  await hub.claudex.pause(ui.selected);await hub.claudex.pauseDrains.get(ui.selected);
  ui.detail=hub.claudex.detail(ui.selected);ui.controls.workspace.value=mode==='copy'?'direct':'copy';ui.prompt.value='';
  await ui.submit();
  assert.equal(calls.length,2);assert.match(calls[1].route,/\/resume$/);
  assert.equal(Object.hasOwn(calls[1],'workspace'),false);
  assert.equal(ui.detail.workspaceMode,mode);assert.equal(ui.detail.workspace?.copy,copy);
});

test('Hydra só leitura guarda a escolha de cópia sem criar uma pasta privada',async t=>{
  const {ui,hub,calls,cwd}=await setup(t,{loseResponse:false});
  ui.controls.cwd.value=cwd;ui.controls.workspace.value='copy';ui.controls.requestMode.value='read-only';
  await ui.submit();
  assert.equal(calls[0].workspace,'copy');assert.equal(calls[0].requestMode,'read-only');
  assert.equal(ui.detail.workspaceMode,'copy');assert.equal(ui.detail.workspace,undefined);
  assert.equal(hub.claudex.records[0].workspace,undefined);
  assert.equal(await readFile(path.join(cwd,'value.txt'),'utf8'),'before');
});

test('Hydra recusa uma cópia num servidor antigo antes de criar pasta ou tarefa',async t=>{
  const {ui,hub,calls,folderCount}=await setup(t,{loseResponse:false});
  ui.getState=()=>{const state=hub.snapshot();delete state.claudex.workspaceModes;return state;};
  ui.controls.workspace.value='copy';
  await assert.rejects(ui.submit(),/Atualiza o servidor/);
  assert.equal(calls.length,0);assert.equal(folderCount(),0);assert.equal(hub.claudex.records.length,0);
});

test('Hydra permite só dois ou três clientes distintos antes de criar uma cópia',async t=>{
  const {ui,calls,cwd}=await setup(t,{loseResponse:false,roles:['codex','claude','antigravity']});
  ui.controls.cwd.value=cwd;ui.controls.workspace.value='copy';await ui.submit();
  assert.deepEqual(calls[0].roles,['codex','claude','antigravity']);
  for(const roles of [['codex'],['codex','codex'],['codex','claude','antigravity','cursor']]){
    ui.selected=null;ui.detail=null;ui.prompt.value='Implementa uma alteração.';ui.roles=()=>roles;
    await assert.rejects(ui.submit(),/dois ou três clientes distintos/);
  }
  assert.equal(calls.length,1);
});

test('atualizar o histórico depois de uma falha muda a assinatura mesmo quando conserva detalhes anteriores',async()=>{
  const record={id:'task',groupId:'group',updatedAt:'new',status:'completed',members:{codex:{conversationId:'c'}}};
  const detail={id:'task',updatedAt:'old',messages:[{seq:1,from:'user',type:'request',at:'2026-11-02',text:'Pedido'}],workspace:{applying:true}};
  let requests=0;
  const ui=Object.assign(Object.create(ClaudeXUI.prototype),{getState:()=>({claudex:{records:[record]}}),cache:new Map([['task',{updatedAt:'old',detail}]]),fetching:new Set(),changed(){},api:async()=>{requests++;throw Error('503 temporário');}});
  const members=[{id:'c',group:'group'}],before=ui.transcript(members,null).signature;
  await new Promise(resolve=>setImmediate(resolve));
  const after=ui.transcript(members,null).signature;
  assert.notEqual(after,before);assert.equal(requests,1);assert.equal(ui.cache.get('task').failed,true);
});
