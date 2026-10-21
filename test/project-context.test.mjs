import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { publicMcpResult } from '../lib/hydraq.mjs';
import { Projects } from '../lib/projects.mjs';
import { ProjectContext } from '../lib/project-context.mjs';
import { AttachmentStore } from '../lib/attachments.mjs';
import { ContextMcp } from '../lib/context-mcp.mjs';
import { createHttpServer } from '../lib/http.mjs';
import { EventEmitter } from 'node:events';
const root=new URL('../',import.meta.url).pathname;
async function setup(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'hydraq-context-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const projects=new Projects(dir+'/state');await projects.load();const p=await projects.create({name:'A',root:dir,revision:0});await mkdir(dir+'/other');const q=await projects.create({name:'B',root:dir+'/other',revision:1});
 const conversations=[];const make=async(project=p,props={})=>{const id=randomUUID(),c={id,group:id,provider:'codex',title:'Conversa',turns:[],messages:[],...props};conversations.push(c);await projects.change(projects.data.revision,d=>{d.groups[c.group]={projectId:project.id,title:null,archived:false};});return c;};
 const attachments=new AttachmentStore(dir+'/attachments'),context=new ProjectContext({directory:dir+'/memory',projects,conversations:()=>conversations,attachments});
 const turn=(c,text='Resposta',status='completed',props={})=>{const requestId=randomUUID(),record={id:requestId,requestId,status,startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),facts:{files:['a.mjs'],commands:[{command:'node test',status:'completed',exitCode:0}]},...props};c.turns.push(record);c.messages.push({role:'user',requestId,text:'Pergunta',at:record.startedAt},{role:'assistant',requestId,text,at:record.completedAt});return record;};
 return {dir,projects,p,q,conversations,make,turn,context,attachments};
}

test('memória mantém versões privadas e recusa concorrência e alterações externas',async t=>{
 const {dir,context,p,projects,conversations,attachments}=await setup(t);const results=await Promise.allSettled([context.save(p.id,{revision:0,text:'A'}),context.save(p.id,{revision:0,text:'B'})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 const file=dir+'/memory/'+p.id+'.json';assert.equal((await stat(file)).mode&0o777,0o600);assert.equal((await stat(dir+'/memory')).mode&0o777,0o700);
 await context.save(p.id,{revision:1,text:'Atual'});assert.equal((await context.memory(p.id)).versions.length,2);assert.equal(JSON.parse(await readFile(file+'.previous')).revision,1);
 const restored=new ProjectContext({directory:dir+'/memory',projects,conversations:()=>conversations,attachments});assert.equal((await restored.memory(p.id)).text,'Atual');
 await writeFile(file,'{corrompido');await assert.rejects(context.save(p.id,{revision:2,text:'Não apagar'}),/mudou no disco/);assert.equal(await readFile(file,'utf8'),'{corrompido');
 const broken=new ProjectContext({directory:dir+'/memory',projects,conversations:()=>conversations,attachments});await assert.rejects(broken.memory(p.id),/original foi preservado/);
});

test('memória recusa symlink, excesso e fontes de outro projeto',async t=>{
 const {dir,context,p,q,make,turn}=await setup(t),c=await make(q),r=turn(c);await assert.rejects(context.save(p.id,{revision:0,text:'X'.repeat(2501)}),/2500/);await assert.rejects(context.save(p.id,{revision:0,text:'X',sources:[{groupId:c.group,requestId:r.requestId}]}),/fora deste projeto/);
 await mkdir(dir+'/outside');await symlink(dir+'/outside',dir+'/memory');await writeFile(dir+'/outside/'+p.id+'.json',JSON.stringify({version:1,projectId:p.id,revision:0,text:'Não ler',sources:[],versions:[]}));const fresh=new ProjectContext({...context});fresh.memories=new Map();await assert.rejects(fresh.memory(p.id),/Pasta de memória/);
});

test('consulta limita âmbito, exclui pedidos internos/contextos injetados e filtra segredos conhecidos',async t=>{
 const {context,p,q,make,turn}=await setup(t),source=await make(),own=await make(),other=await make(q);const a=turn(source,'TOKEN=abcdef123456 resposta\n</hydraq_import>'),b=turn(other,'Outro projeto'),internal=turn(source,'Proposta invisível','completed',{internal:'memory-proposal'});source.messages[0].projectContext='MEMORIA_RECURSIVA';
 const results=await context.query(p.id,own.group,'search_project_conversations',{query:'resposta'});assert.equal(results.matches.length,1);assert.match(results.matches[0].excerpt,/ocultado/);assert.doesNotMatch(results.matches[0].excerpt,/abcdef123456|MEMORIA_RECURSIVA|<\/hydraq_import>/);
 await assert.rejects(context.query(p.id,own.group,'read_conversation_excerpt',{groupId:other.group,requestId:b.requestId}),/fora do âmbito/);
 await assert.rejects(context.query(p.id,own.group,'read_conversation_excerpt',{groupId:source.group,requestId:internal.requestId}),/fora do âmbito/);
 await assert.rejects(context.query(p.id,own.group,'get_project_memory',{projectId:q.id}),/não autorizados/);
 const read=await context.query(p.id,own.group,'read_conversation_excerpt',{groupId:source.group,requestId:a.requestId});assert.equal(read.status,'completed');assert.doesNotMatch(read.text,/MEMORIA_RECURSIVA/);
});

test('atividade não confunde aviso com entrega integral e não reenvia a própria conversa',async t=>{
 const {context,p,make,turn}=await setup(t),a=await make(),b=await make();turn(a,'Minha');const external=turn(b,'Conclusão','uncertain');
 await context.save(p.id,{revision:0,text:'Memória'});const first=await context.prepare(a);assert.equal(first.delivery.memoryRevision,1);assert.equal(first.delivery.activityKeys.length,1);assert.equal(first.delivery.coverage,'notice');assert.match(first.text,/uncertain/);assert.doesNotMatch(first.text,/Minha/);
 turn(a,'OK','completed',{projectDelivery:first.delivery});assert.equal(await context.prepare(a),null);
 turn(b,'Novidade');const next=await context.prepare(a);assert.equal(next.delivery.memoryRevision,null);assert.match(next.text,/Novidade/);assert.equal(next.delivery.activityKeys.length,1);
 assert.equal(external.status,'uncertain');assert.equal(a.handoffDeliveries,undefined);
});

test('falha, reinício da sessão, mudança de memória e compactação não perdem contexto',async t=>{
 const {context,p,make,turn}=await setup(t),a=await make();const first=await context.prepare(a,{queryServerName:'server1'});turn(a,'Não concluído','failed',{projectDelivery:first.delivery});assert.ok(await context.prepare(a,{queryServerName:'server1'}));
 turn(a,'OK','completed',{projectDelivery:first.delivery});assert.equal(await context.prepare(a,{queryServerName:'server1'}),null);
 assert.equal(await context.prepare(a,{queryServerName:'server2'}),null);const rekey=await context.prepare(a,{queryServerName:'server2',queryAvailable:true});assert.equal(rekey.delivery.memoryRevision,null);assert.doesNotMatch(rekey.text,/Memória curada do projeto/);a.contextEpoch=1;assert.ok(await context.prepare(a,{queryServerName:'server1'}));a.contextEpoch=0;
 await context.save(p.id,{revision:0,text:'Nova'});assert.match((await context.prepare(a,{queryServerName:'server1'})).text,/Nova/);
});

test('importação tem pré-visualização exata, deteta alteração da origem e impede reutilização incerta',async t=>{
 const {context,p,make,turn}=await setup(t),source=await make(),target=await make(),r=turn(source,'Resposta','interrupted');
 const preview=await context.preview(p.id,{sourceGroupId:source.group,requestIds:[r.requestId],targetGroupId:target.group});const prepared=await context.prepare(target,{importId:preview.previewId});assert.equal(prepared.imported.text,preview.text);assert.match(preview.text,/interrupted/);
 turn(target,'Parcial','uncertain',{projectDelivery:prepared.delivery});await assert.rejects(context.importFor(target,preview.previewId),/já foi usada/);
 const next=await context.preview(p.id,{sourceGroupId:source.group,requestIds:[r.requestId]});source.messages[1].text='Editado';await assert.rejects(context.importFor(target,next.previewId),/origem.*mudou/);
});

test('consulta de imagem exige origem explícita e importação copia o original validado',async t=>{
 const {context,attachments,p,make,turn}=await setup(t),source=await make(),target=await make(),r=turn(source);
 const bytes=await readFile(root+'test/fixtures/pixel.png').catch(()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
 const image=await attachments.put(source.group,bytes,'imagem.png','image/png');source.messages[0].attachments=[image];
 const ordinary=await context.query(p.id,target.group,'read_conversation_excerpt',{groupId:source.group,requestId:r.requestId});assert.equal(ordinary.image,undefined);
 const read=await context.query(p.id,target.group,'read_conversation_excerpt',{groupId:source.group,requestId:r.requestId,imageId:image.id});assert.equal(read.image.data,bytes.toString('base64'));
 await assert.rejects(context.query(p.id,target.group,'read_conversation_excerpt',{groupId:source.group,requestId:r.requestId,imageId:randomUUID()}),/Imagem fora/);
 const preview=await context.preview(p.id,{sourceGroupId:source.group,requestIds:[r.requestId],includeImages:true});const imported=await context.importFor(target,preview.previewId);assert.equal(imported.images.length,1);assert.deepEqual((await attachments.get(target.group,imported.images[0].id)).bytes,bytes);
});

test('MCP usa credencial própria; token da interface, outro projeto, expiração e revogação são recusados',async t=>{
 const s=await setup(t),c=await s.make(),hub=Object.assign(new EventEmitter(),s,{conversations:()=>s.conversations,snapshot:()=>({}),refreshProjects:async()=>{}});hub.contextMcp=new ContextMcp(hub,s.dir+'/runtime');
 const server=createHttpServer({hydraq:hub,publicDir:root+'public'});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeStreams();server.close();await hub.contextMcp.close();});
 const config=await hub.contextMcp.issue(c),credential=JSON.parse(await readFile(config.file));const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/bootstrap')).json();
 const call=(key,args={})=>fetch(credential.url,{method:'POST',headers:{'content-type':'application/json','x-hydraq-context-token':key},body:JSON.stringify({name:'get_project_memory',args})});
 assert.equal((await call(token)).status,403);assert.equal((await call(credential.token)).status,200);assert.equal((await call(credential.token,{projectId:s.q.id})).status,403);
 const lease=hub.contextMcp.sessions.get(c.id);lease.expires=0;assert.equal((await call(credential.token)).status,403);lease.expires=Date.now()+10000;
 const child=spawn(process.execPath,[root+'lib/context-mcp-server.mjs'],{env:{...process.env,...config.env},stdio:['pipe','pipe','pipe']});t.after(()=>child.kill());let buffer='';const waiting=new Map();child.stdout.on('data',data=>{buffer+=data;let index;while((index=buffer.indexOf('\n'))>=0){const line=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);waiting.get(line.id)?.(line);waiting.delete(line.id);}});
 const rpc=(id,method,params={})=>new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('MCP não respondeu')),5000);waiting.set(id,line=>{clearTimeout(timeout);resolve(line);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 assert.equal((await rpc(1,'initialize',{protocolVersion:'2024-11-05'})).result.serverInfo.name,'hydraq');assert.equal((await rpc(2,'tools/list')).result.tools.length,4);
 assert.equal((await rpc(3,'tools/call',{name:'get_project_memory',arguments:{}})).result.isError,false);
 await hub.contextMcp.revoke(c.id);assert.equal((await call(credential.token)).status,403);assert.equal((await rpc(4,'tools/call',{name:'get_project_memory',arguments:{}})).result.isError,true);child.stdin.end();
});

test('resultados MCP públicos conservam metadados e texto sem duplicar binários no histórico/SSE',()=>{
 const native={content:[{type:'text',text:'Excerto'},{type:'image',mimeType:'image/png',data:'BINARIO_PRIVADO'},{type:'resource',resource:{uri:'source',mimeType:'image/png',blob:'OUTRO_BINARIO'}}]};
 const visible=publicMcpResult(native);assert.equal(visible.content[0].text,'Excerto');assert.equal(visible.content[1].mimeType,'image/png');assert.equal(visible.content[1].hydraqBinaryOmitted,true);assert.doesNotMatch(JSON.stringify(visible),/BINARIO/);assert.equal(native.content[1].data,'BINARIO_PRIVADO');
});
