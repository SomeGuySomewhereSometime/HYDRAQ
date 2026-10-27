import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, symlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttachmentStore, inspectImage, MAX_IMAGE_BYTES } from '../lib/attachments.mjs';
import { Providers } from '../lib/providers.mjs';
import { Hydraq } from '../lib/hydraq.mjs';
import { CodexClient } from '../lib/codex.mjs';
import { ClaudeCode } from '../lib/claude.mjs';
import { Antigravity } from '../lib/antigravity.mjs';
import { Cursor } from '../lib/cursor.mjs';
import { createHttpServer } from '../lib/http.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5j8AAAAASUVORK5CYII=','base64');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const waitFor=async predicate=>{const end=Date.now()+6000;while(!predicate()){if(Date.now()>end)throw Error('Tempo excedido.');await new Promise(r=>setTimeout(r,10));}};
async function dir(t){const directory=await mkdtemp(path.join(os.tmpdir(),'hydraq-images-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}

test('imagens privadas persistem com hash e não aceitam ficheiros de outro grupo',async t=>{
  const directory=await dir(t),store=new AttachmentStore(directory+'/images');
  const meta=await store.put('one',png,'../../captura.png','image/png');
  assert.equal(meta.name,'captura.png');assert.equal(meta.width,1);
  const reopened=new AttachmentStore(directory+'/images'),image=await reopened.get('one',meta.id);
  assert.deepEqual(image.bytes,png);assert.equal((await stat(image.path)).mode&0o777,0o600);
  await assert.rejects(reopened.get('two',meta.id),/ENOENT/);
  await assert.rejects(reopened.get('one','../../etc/passwd'),/inválido/);
  assert.ok(!JSON.stringify(meta).includes(png.toString('base64')));
});

test('anexos rejeitam conteúdo falso, MIME errado, dimensão excessiva e symlinks',async t=>{
  const directory=await dir(t),store=new AttachmentStore(directory+'/images');
  assert.throws(()=>inspectImage(Buffer.from('<svg></svg>')),/inválida/);
  assert.throws(()=>inspectImage(Buffer.alloc(MAX_IMAGE_BYTES+1)),/5 MB/);
  const huge=Buffer.from(png);huge.writeUInt32BE(9000,16);assert.throws(()=>inspectImage(huge),/8192/);
  await assert.rejects(store.put('one',png,'x.jpg','image/jpeg'),/tipo indicado/);
  const meta=await store.put('one',png,'x.png','image/png'),image=await store.get('one',meta.id);
  const altered=Buffer.from(png);altered[altered.length-1]^=1;await writeFile(image.path,altered);
  await assert.rejects(store.get('one',meta.id),/alterada/);
  await rm(image.path);await symlink(directory+'/secret',image.path);await writeFile(directory+'/secret',png);
  await assert.rejects(store.get('one',meta.id),/ELOOP/);
});

async function setup(t,noImages=false){
  const directory=await mkdtemp(path.join(os.tmpdir(),'hydraq-images-')),state=directory+'/state',fixture=name=>[path.join(root,'test/fixtures/fake-'+name+'.mjs')];
  const credentialFile=directory+'/cursor.env';await writeFile(credentialFile,'CURSOR_API_KEY=FAKE-ONLY\n',{mode:0o600});
  const env={...process.env,FAKE_CODEX_SETTINGS_LOG:directory+'/codex.jsonl',FAKE_CLAUDE_IMAGE_LOG:directory+'/claude.json',FAKE_CURSOR_IMAGE_LOG:directory+'/cursor.jsonl',FAKE_CURSOR_NO_IMAGES:String(noImages)};
  const clients={
    codex:new Hydraq({dataDir:state,defaultCwd:directory,modelMetadataPath:directory+'/unused.json',client:new CodexClient({executable:process.execPath,args:fixture('codex'),env})}),
    claude:new ClaudeCode({dataDir:state+'/claude',defaultCwd:directory,executable:process.execPath,prefixArgs:fixture('claude'),env}),
    antigravity:new Antigravity({dataDir:state+'/antigravity',defaultCwd:directory,settingsFile:directory+'/unused-agy.json',executable:process.execPath,prefixArgs:fixture('agy'),env}),
    cursor:new Cursor({dataDir:state+'/cursor',defaultCwd:directory,executable:process.execPath,prefixArgs:fixture('cursor'),credentialFile,env}),
  };
  const hub=new Providers({dataDir:state,clients,git:async()=>null,inspect:async()=>({files:{},warnings:[],complete:true})});
  await hub.load();await Promise.all(Object.keys(clients).map(id=>hub.connect(id)));
  t.after(async()=>{try{await hub.close();}finally{await new Promise(r=>setTimeout(r,30));await rm(directory,{recursive:true,force:true});}});
  const create=provider=>hub.create({provider,cwd:directory,model:{codex:'gpt-test',claude:'haiku',antigravity:'gemini-4-argon',cursor:'grok-4.7'}[provider],effort:'low'});
  const idle=()=>!hub.handoff && !hub.snapshot().conversations.some(c=>['starting','running','waiting'].includes(c.status));
  return {directory,hub,clients,create,idle};
}

test('entrega imagem original aos quatro clientes e conserva só metadados no histórico',async t=>{
  const {directory,hub,clients,create,idle}=await setup(t);
  for(const provider of ['codex','claude','cursor','antigravity']){
    const c=await create(provider),meta=await hub.uploadAttachment(c.id,png,'marca.png','image/png');
    await hub.send(c.id,'','image-'+provider,{attachments:[meta.id]});await waitFor(idle);
    const chat=clients[provider].conversation(c.id),message=chat.messages.find(m=>m.role==='user');
    assert.equal(chat.status,'completed');assert.equal(message.attachments[0].id,meta.id);
    assert.equal(chat.turns[0].inputAttachments[0].sha256,meta.sha256);
    assert.ok(!JSON.stringify(hub.snapshot()).includes(png.toString('base64')));
    if(provider==='codex'){
      const record=JSON.parse((await readFile(directory+'/codex.jsonl','utf8')).trim());
      assert.equal(record.input[1].type,'localImage');assert.deepEqual(await readFile(record.input[1].path),png);
    }else if(provider==='claude'){
      const blocks=JSON.parse(await readFile(directory+'/claude.json','utf8'));
      assert.equal(blocks[1].source.media_type,'image/png');assert.deepEqual(Buffer.from(blocks[1].source.data,'base64'),png);
    }else if(provider==='cursor'){
      const blocks=JSON.parse((await readFile(directory+'/cursor.jsonl','utf8')).trim());
      assert.equal(blocks[1].mimeType,'image/png');assert.deepEqual(Buffer.from(blocks[1].data,'base64'),png);
    }else{
      const prompt=await readFile(path.join(directory,'.fake-agy-last-'+chat.threadId),'utf8');
      const image=await hub.attachments.get(meta.group,meta.id);
      assert.match(prompt,/view_file/);assert.ok(prompt.includes(image.path));
      assert.ok(clients.antigravity.session.child.spawnargs.includes(path.dirname(image.path)));
    }
    await clients[provider].persist();
  }
});

test('passagens entregam originais mesmo com resumo e não reenviam imagens já confirmadas',async t=>{
  const {directory,hub,clients,create,idle}=await setup(t),source=await create('codex');
  const meta=await hub.uploadAttachment(source.id,png,'original.png','image/png');
  await hub.send(source.id,'Lê a imagem','first',{attachments:[meta.id]});await waitFor(idle);
  const switched=await hub.send(source.id,'Compara com o que viste','handoff',{provider:'claude',model:'haiku',effort:'low',handoffMode:'model'});
  await waitFor(idle);
  const target=clients.claude.conversation(switched.conversationId);
  assert.equal(target.status,'completed');assert.equal(target.turns[0].inputAttachments[0].id,meta.id);
  assert.equal(target.messages.find(m=>m.role==='user').attachments,undefined);
  let blocks=JSON.parse(await readFile(directory+'/claude.json','utf8'));assert.equal(blocks.filter(b=>b.type==='image').length,1);
  await hub.send(target.id,'Continua','next');await waitFor(idle);
  assert.equal(typeof JSON.parse(await readFile(directory+'/claude.json','utf8')),'string');
  await assert.rejects(hub.send(source.id,'Lê a imagem','first',{attachments:[]}),/outras imagens/);
  const again=await hub.send(source.id,'Lê a imagem','first',{attachments:[meta.id]});assert.equal(again.duplicate,true);
});

test('Cursor sem capacidade de imagem rejeita a passagem antes de gerar resumo',async t=>{
  const {hub,clients,create,idle}=await setup(t,true),source=await create('codex');
  const meta=await hub.uploadAttachment(source.id,png,'x.png','image/png');
  await hub.send(source.id,'Imagem','first',{attachments:[meta.id]});await waitFor(idle);
  await assert.rejects(hub.send(source.id,'Continua','no-vision',{provider:'cursor',model:'grok-4.7',effort:'low'}),/suporte a imagens/);
  assert.equal(clients.codex.conversation(source.id).turns.length,1);assert.equal(hub.handoff,undefined);
});

test('agy aquecido ganha acesso apenas à pasta do grupo e retoma o mesmo ID ao receber imagem',async t=>{
  const {hub,clients,create,idle}=await setup(t),c=await create('antigravity');
  await hub.send(c.id,'primeiro','warm-first');await waitFor(idle);
  const chat=clients.antigravity.conversation(c.id),id=chat.threadId;
  assert.equal(clients.antigravity.session.imageDirectory,undefined);
  const meta=await hub.uploadAttachment(c.id,png,'x.png','image/png');
  await hub.send(c.id,'Lê a imagem','warm-image',{attachments:[meta.id]});await waitFor(idle);
  assert.equal(chat.threadId,id);assert.equal(chat.status,'completed');
  const allowed=clients.antigravity.session.imageDirectory;
  assert.equal(allowed,path.dirname((await hub.attachments.get(meta.group,meta.id)).path));
  await hub.send(c.id,'continua','warm-text');await waitFor(idle);
  assert.equal(chat.threadId,id);assert.equal(clients.antigravity.session.imageDirectory,allowed);
});

test('verificar imagens no disco mantém a exclusão de pedidos concorrentes entre clientes',async t=>{
  const {hub,clients,create,idle}=await setup(t),first=await create('codex'),other=await create('claude');
  const meta=await hub.uploadAttachment(first.id,png,'x.png','image/png');
  const resolve=hub.attachments.resolve.bind(hub.attachments);let release,entered=false;
  const gate=new Promise(r=>release=r);
  hub.attachments.resolve=async(...args)=>{if(!entered&&args[1]?.length){entered=true;await gate;}return resolve(...args);};
  const sending=hub.send(first.id,'primeiro','one',{attachments:[meta.id]});
  try{await waitFor(()=>entered);await assert.rejects(hub.send(other.id,'NAO-ENVIAR','two'),e=>e.code==='WORK_RESERVED'&&/uma preparação/.test(e.message));}
  finally{release();}
  await sending;await waitFor(idle);
  assert.equal(clients.claude.conversation(other.id).messages.length,0);
});

test('HTTP protege upload e leitura; imagens não usam tokens na URL nem entram no estado',async t=>{
  const {hub,create}=await setup(t),c=await create('codex');
  const server=createHttpServer({hydraq:hub,publicDir:path.join(root,'public')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeStreams();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/bootstrap',{headers:{'X-HYDRAQ-Bootstrap':'1'}})).json();
  const route=base+'/api/conversations/'+c.id+'/attachments?name=screen.png';
  assert.equal((await fetch(route,{method:'POST',body:png,headers:{'content-type':'image/png'}})).status,403);
  const response=await fetch(route,{method:'POST',body:png,headers:{'content-type':'image/png','x-hydraq-token':token}});
  assert.equal(response.status,201);const meta=await response.json();
  assert.ok(!meta.url.includes(token));assert.equal((await fetch(base+meta.url)).status,403);
  const image=await fetch(base+meta.url,{headers:{'x-hydraq-token':token}});assert.equal(image.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
  assert.equal((await fetch(route,{method:'POST',body:png,headers:{'content-type':'image/jpeg','x-hydraq-token':token}})).status,400);
  assert.equal((await fetch(base+'/attachments.js')).status,200);
});
