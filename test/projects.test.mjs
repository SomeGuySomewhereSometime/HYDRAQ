import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Projects, containsFolder } from '../lib/projects.mjs';
import { Providers } from '../lib/providers.mjs';
import { Hydraq } from '../lib/hydraq.mjs';
import { CodexClient } from '../lib/codex.mjs';
import { ClaudeCode } from '../lib/claude.mjs';
import { createHttpServer } from '../lib/http.mjs';
import { ComposerDrafts, draftKey } from '../public/drafts.js';
import { conversationGroups } from '../public/projects.js';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const waitFor=async predicate=>{const end=Date.now()+6000;while(!predicate()){if(Date.now()>end)throw Error('Tempo excedido.');await new Promise(r=>setTimeout(r,10));}};
async function folder(t){const dir=await mkdtemp(path.join(os.tmpdir(),'hydraq-projects-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function setup(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'hydraq-projects-')),dataDir=dir+'/state';
  const clients={codex:new Hydraq({dataDir,defaultCwd:dir,modelMetadataPath:dir+'/unused.json',client:new CodexClient({executable:process.execPath,args:[root+'/test/fixtures/fake-codex.mjs']})}),claude:new ClaudeCode({dataDir:dataDir+'/claude',defaultCwd:dir,executable:process.execPath,prefixArgs:[root+'/test/fixtures/fake-claude.mjs']})};
  const hub=new Providers({dataDir,clients,git:async()=>null});await hub.load();await hub.connectAll();
  t.after(async()=>{try{await hub.close();}finally{await new Promise(r=>setTimeout(r,30));await rm(dir,{recursive:true,force:true});}});
  const project=async(name='Projeto',folder=dir)=>hub.createProject({name,root:folder,revision:hub.projects.data.revision});
  const chat=async(projectId)=>hub.create({provider:'codex',cwd:dir,model:'gpt-test',effort:'low',...(projectId?{projectId,revision:hub.projects.data.revision}:{})});
  const idle=()=>!hub.handoff&&!hub.snapshot().conversations.some(c=>['starting','running','waiting'].includes(c.status));
  return {hub,clients,dir,project,chat,idle};
}

test('catálogo privado resolve symlinks, recusa duplicados e sugere a raiz mais específica',async t=>{
  const dir=await folder(t),store=new Projects(dir+'/state');await mkdir(dir+'/repo/tools',{recursive:true});await mkdir(dir+'/repo-extra');await symlink(dir+'/repo',dir+'/alias');await store.load();
  const project=await store.create({name:'Raiz',root:dir+'/alias',revision:0});assert.equal(project.root,dir+'/repo');
  await assert.rejects(store.create({name:'Duplicado',root:dir+'/repo',revision:1}),/Já existe/);
  const nested=await store.create({name:'Ferramentas',root:dir+'/repo/tools',revision:1});assert.equal(store.suggest(dir+'/repo/tools').id,nested.id);
  assert.equal(containsFolder(dir+'/repo',dir+'/repo-extra'),false);assert.equal(containsFolder('/',dir),true);
  const restored=new Projects(dir+'/state');await restored.load();assert.equal(restored.data.revision,2);assert.equal(restored.data.projects.length,2);
  assert.equal((await stat(store.file)).mode&0o777,0o600);assert.equal(JSON.parse(await readFile(store.file+'.previous')).revision,1);
});

test('fila recusa revisão antiga e uma gravação falhada não muda o catálogo em memória',async t=>{
  const dir=await folder(t),store=new Projects(dir+'/state');await store.load();
  const results=await Promise.allSettled([store.create({name:'A',root:dir,revision:0}),store.create({name:'B',root:dir,revision:0})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/noutra janela/);
  const before=store.data;await writeFile(store.file,JSON.stringify({...store.data,revision:99}));
  await assert.rejects(store.change(1,draft=>{draft.projects[0].name='Perdido';}),/mudou no disco/);assert.equal(store.data,before);assert.equal(store.data.projects[0].name,'A');
});

test('catálogo corrompido é preservado e não é substituído por vazio nem pela cópia anterior',async t=>{
  const dir=await folder(t);await mkdir(dir+'/state');await writeFile(dir+'/state/projects.json','{corrompido');
  const store=new Projects(dir+'/state');await store.load();assert.match(store.error,/preservado/);
  await assert.rejects(store.create({name:'Não gravar',root:dir,revision:0}),/preservado/);assert.equal(await readFile(store.file,'utf8'),'{corrompido');
});

test('projetos não agrupam históricos sozinhos; associação por grupo mantém pasta e IDs nas passagens',async t=>{
  const {hub,clients,dir,project,chat,idle}=await setup(t),legacy=await chat(),p=await project();
  assert.equal(hub.snapshot().conversations[0].organization,null);
  await hub.organizeGroups({revision:hub.projects.data.revision,groups:[legacy.id],projectId:p.id,title:'Nome escolhido'});
  await hub.send(legacy.id,'Memoriza teste','first');await waitFor(idle);const native=clients.codex.conversation(legacy.id).threadId;
  const handoff=await hub.send(legacy.id,'Continua','second',{provider:'claude',model:'haiku',effort:'low',handoffMode:'quick'});await waitFor(idle);
  const target=hub.snapshot().conversations.find(c=>c.id===handoff.conversationId);assert.equal(target.group,legacy.id);assert.equal(target.organization.projectId,p.id);assert.equal(target.cwd,dir);
  const rows=conversationGroups(hub.snapshot());assert.equal(rows.length,1);assert.equal(rows[0].title,'Nome escolhido');
  await hub.send(legacy.id,'Regresso','third');await waitFor(idle);assert.equal(clients.codex.conversation(legacy.id).threadId,native);
  const restored=new Projects(hub.projects.directory);await restored.load();assert.equal(restored.group(legacy.id).projectId,p.id);
});

test('associação aceita subpasta real, recusa vizinho e grupo com pastas divergentes; retirar conserva cwd',async t=>{
  const {hub,clients,dir,project}=await setup(t);await mkdir(dir+'/repo/tools',{recursive:true});await mkdir(dir+'/repo-extra');const p=await project('Raiz',dir+'/repo');
  const sub=await hub.create({provider:'codex',cwd:dir+'/repo/tools',model:'gpt-test'});
  await hub.organizeGroups({revision:hub.projects.data.revision,groups:[sub.id],projectId:p.id});assert.equal(clients.codex.conversation(sub.id).cwd,dir+'/repo/tools');
  const neighbour=await hub.create({provider:'codex',cwd:dir+'/repo-extra',model:'gpt-test'});
  await assert.rejects(hub.organizeGroups({revision:hub.projects.data.revision,groups:[neighbour.id],projectId:p.id}),/incompatíveis/);
  const other=clients.codex.conversation(neighbour.id);other.group=sub.id;
  await assert.rejects(hub.organizeGroups({revision:hub.projects.data.revision,groups:[sub.id],projectId:p.id}),/incompatíveis/);delete other.group;
  await hub.organizeGroups({revision:hub.projects.data.revision,groups:[sub.id],projectId:null});assert.equal(hub.projects.group(sub.id).projectId,null);assert.equal(clients.codex.conversation(sub.id).cwd,dir+'/repo/tools');
});

test('predefinições são validadas, aplicadas só na criação e nunca concedem permissões',async t=>{
  const {hub,clients,dir,project}=await setup(t),p=await project();
  await hub.updateProject(p.id,{revision:hub.projects.data.revision,defaults:{provider:'codex',clients:{codex:{model:'gpt-test',effort:'low'}}}});
  const c=await hub.create({projectId:p.id,revision:hub.projects.data.revision,sandbox:'read-only'});assert.equal(c.model,'gpt-test');assert.equal(c.cwd,dir);assert.equal(c.sandbox,'read-only');
  await hub.updateProject(p.id,{revision:hub.projects.data.revision,name:'Renomeado',defaults:{clients:{}}});assert.equal(clients.codex.conversation(c.id).effort,'low');
  await assert.rejects(hub.updateProject(p.id,{revision:hub.projects.data.revision,defaults:{clients:{codex:{sandbox:'workspace-write'}}}}),/permissões/);
  await assert.rejects(hub.updateProject(p.id,{revision:hub.projects.data.revision,defaults:{clients:{codex:{model:'modelo-inexistente'}}}}),/disponível/);
  await assert.rejects(hub.updateProject(p.id,{revision:hub.projects.data.revision,root:dir+'/outro'}),/fixa/);
});

test('arquivo bloqueia envio e tarefa ativa bloqueia arquivo; restauração conserva sessão',async t=>{
  const {hub,clients,project,chat,idle}=await setup(t),p=await project(),c=await chat(p.id),native=clients.codex.conversation(c.id);
  native.status='waiting';await assert.rejects(hub.updateProject(p.id,{revision:hub.projects.data.revision,archived:true}),/pendente/);native.status='idle';
  await hub.organizeGroups({revision:hub.projects.data.revision,groups:[c.id],archived:true});await assert.rejects(hub.send(c.id,'Não enviar','archived'),/Restaura/);assert.equal(native.turns.length,0);
  await hub.organizeGroups({revision:hub.projects.data.revision,groups:[c.id],archived:false});await hub.send(c.id,'Enviado','restore');await waitFor(idle);const id=native.threadId;
  await hub.updateProject(p.id,{revision:hub.projects.data.revision,archived:true});await assert.rejects(hub.send(c.id,'Não enviar','project-archived'),/Restaura/);
  await hub.updateProject(p.id,{revision:hub.projects.data.revision,archived:false});assert.equal(native.threadId,id);
});

test('pasta desaparecida bloqueia antes da inferência e continua com histórico consultável',async t=>{
  const {hub,clients,dir,project,chat}=await setup(t);await mkdir(dir+'/repo');const p=await project('Pasta',dir+'/repo'),c=await chat(p.id);
  await rename(dir+'/repo',dir+'/movida');await assert.rejects(hub.send(c.id,'Não enviar','missing'),/Não é possível/);
  assert.equal(clients.codex.conversation(c.id).turns.length,0);assert.equal(hub.snapshot().projectCatalog.projects[0].available,false);
  await rename(dir+'/movida',dir+'/repo');await hub.refreshProjects();assert.equal(hub.snapshot().projectCatalog.projects[0].available,true);
});

test('envio aguarda uma alteração do catálogo já iniciada e respeita o arquivo confirmado',async t=>{
  const {hub,clients,project,chat}=await setup(t),p=await project(),c=await chat(p.id);
  let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const changing=hub.projects.change(hub.projects.data.revision,async draft=>{entered();await gate;draft.projects.find(project=>project.id===p.id).archived=true;});
  await started;const sending=hub.send(c.id,'Não enviar','archive-race');release();await changing;
  await assert.rejects(sending,/Restaura/);assert.equal(clients.codex.conversation(c.id).turns.length,0);
});

test('catálogo inválido conserva os históricos dos clientes e desativa só as novas operações',async t=>{
  const {hub,clients,chat}=await setup(t),c=await chat();
  await writeFile(hub.projects.file,'{corrompido');await hub.projects.load();
  assert.equal(hub.snapshot().conversations.length,1);assert.equal(hub.snapshot().providers.codex.connection,'connected');
  await assert.rejects(hub.send(c.id,'Não enviar','corrupt'),/preservado/);assert.equal(clients.codex.conversation(c.id).turns.length,0);
  assert.equal(await readFile(hub.projects.file,'utf8'),'{corrompido');
});

test('HTTP protege organização, transmite conflitos 409 e serve os módulos',async t=>{
  const {hub,dir,chat}=await setup(t),c=await chat(),server=createHttpServer({hydraq:hub,publicDir:root+'/public'});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeStreams();server.close();});const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/bootstrap')).json();
  const post=(route,body,key=token)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json','x-hydraq-token':key},body:JSON.stringify(body)});
  assert.equal((await post('/api/projects',{name:'A',root:dir,revision:0},'wrong')).status,403);
  const response=await post('/api/projects',{name:'A',root:dir,revision:0});assert.equal(response.status,201);const p=await response.json();
  assert.equal((await post(`/api/projects/${p.id}`,{name:'B',revision:0})).status,409);
  assert.equal((await post('/api/groups/organize',{groups:[c.id],projectId:p.id,revision:1})).status,200);
  assert.equal((await fetch(base+'/projects.js')).status,200);assert.equal((await fetch(base+'/drafts.js')).status,200);
});

test('rascunhos isolam projetos e grupos sem separar texto por modelo; intenção steer conserva o turno',()=>{
  const drafts=new ComposerDrafts(),a=draftKey(null,'a'),b=draftKey(null,'b'),chat={id:'native-two',group:'same-group'};
  drafts.save(a,'Texto A',{kind:'steer',turnId:'old',conversationId:'c'},'/a');drafts.save(b,'Texto B',null,'/b');assert.equal(drafts.get(a).text,'Texto A');assert.equal(drafts.get(b).text,'Texto B');
  drafts.move(a,draftKey(chat));assert.equal(drafts.get(draftKey({id:'native-one',group:'same-group'})).intent.turnId,'old');assert.equal(drafts.get(a).text,'');
  drafts.clear(b,'outro');assert.equal(drafts.get(b).text,'Texto B');drafts.clear(b,'Texto B');assert.equal(drafts.get(b).text,'');
});
