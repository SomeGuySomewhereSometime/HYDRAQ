import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { publicMcpResult } from '../lib/hydraq.mjs';
import { Projects } from '../lib/projects.mjs';
import { ProjectContext, assembleProjectContext, redact } from '../lib/project-context.mjs';
import { AttachmentStore } from '../lib/attachments.mjs';
import { ContextMcp } from '../lib/context-mcp.mjs';
import { createHttpServer } from '../lib/http.mjs';
import { EventEmitter } from 'node:events';
const root=new URL('../',import.meta.url).pathname;

test('regresso do terminal aguarda a consulta admitida e recusa consultas novas',async t=>{
 const s=await setup(t),c=await s.make(s.p,{provider:'claude',threadId:randomUUID()}),hub={...s,conversations:()=>s.conversations};
 c.terminal={sessionId:c.threadId,mcpProjectId:s.p.id};const broker=new ContextMcp(hub,s.dir+'/runtime');broker.endpoint('http://127.0.0.1:1/api/context/query');t.after(()=>broker.close());
 await broker.issue(c);const lease=broker.sessions.get(c.id);let finish;hub.context.query=()=>new Promise(resolve=>{finish=resolve;});
 const pending=broker.query(lease.token,'get_project_memory',{});c.terminal.returning=true;
 await assert.rejects(broker.query(lease.token,'get_project_memory',{}),/regressar/);
 let drained=false;const drain=broker.drain(c.id).then(()=>{drained=true;});await new Promise(r=>setTimeout(r,10));assert.equal(drained,false);
 finish({revision:1});await pending;await drain;assert.equal(c.terminal.contextReads.length,1);assert.equal(broker.queries.size,0);
});

test('terminal MCP recupera pelo mesmo helper após reinício e mantém revogação e âmbito',async t=>{
 const s=await setup(t),c=await s.make(s.p,{provider:'claude',threadId:randomUUID()}),hub=Object.assign(new EventEmitter(),s,{conversations:()=>s.conversations,snapshot:()=>({})});
 c.terminal={sessionId:c.threadId,mcpProjectId:s.p.id};let persisted=0;hub.clients={claude:{conversations:[c],persist:async()=>{persisted++;await writeFile(s.dir+'/pending.json',JSON.stringify(c.terminal));}}};
 hub.contextMcp=new ContextMcp(hub,s.dir+'/runtime');
 const start=async()=>{const server=createHttpServer({hydraq:hub,publicDir:root+'public'});await new Promise(r=>server.listen(0,'127.0.0.1',r));await hub.contextMcp.restoring;t.after(()=>{server.closeStreams();server.close();});return server;};
 const firstServer=await start(),config=hub.contextMcp.sessions.get(c.id).config;
 const child=spawn(process.execPath,[root+'lib/context-mcp-server.mjs'],{env:{...process.env,...config.env},stdio:['pipe','pipe','pipe']});t.after(()=>child.kill());
 let buffer='',sequence=0;const waiting=new Map();child.stdout.on('data',data=>{buffer+=data;let end;while((end=buffer.indexOf('\n'))>=0){const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);waiting.get(message.id)?.(message);waiting.delete(message.id);}});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(Error('MCP timeout')),5000);waiting.set(id,result=>{clearTimeout(timer);resolve(result);});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
 assert.ok((await call('initialize')).result);
 hub.contextMcp.sessions.get(c.id).expires=0;
 assert.equal((await call('tools/call',{name:'get_project_memory',arguments:{}})).result.isError,false);
 assert.equal(persisted,1);assert.equal(JSON.parse(await readFile(s.dir+'/pending.json')).contextReads.length,1);
 const old=hub.contextMcp.sessions.get(c.id).token;await hub.contextMcp.close();firstServer.closeStreams();await new Promise(r=>firstServer.close(r));
 const unavailable=await call('tools/call',{name:'get_project_memory',arguments:{}});assert.equal(unavailable.result.isError,true);assert.match(unavailable.result.content[0].text,/indisponível/);assert.doesNotMatch(unavailable.result.content[0].text,/ENOENT/);
 hub.contextMcp=new ContextMcp(hub,s.dir+'/runtime');await start();t.after(()=>hub.contextMcp.close());
 const lease=hub.contextMcp.sessions.get(c.id);assert.equal(lease.file,config.file);assert.equal(lease.config.name,config.name);assert.notEqual(lease.token,old);
 assert.equal((await call('tools/call',{name:'get_project_memory',arguments:{}})).result.isError,false);
 await assert.rejects(hub.contextMcp.query(old,'get_project_memory',{}),/sem sessão/);
 await s.projects.change(s.projects.data.revision,d=>{d.groups[c.group].projectId=s.q.id;});
 await assert.rejects(hub.contextMcp.query(lease.token,'get_project_memory',{}),/projeto.*mudou/);
 await hub.contextMcp.revoke(c.id,'project-changed');
 const revoked=await call('tools/call',{name:'get_project_memory',arguments:{}});assert.equal(revoked.result.isError,true);
 assert.match(revoked.result.content[0].text,/já não tem acesso à memória deste projeto/);assert.doesNotMatch(revoked.result.content[0].text,/Aguarda|indisponível/);
 // After a restart the marker of the old process is cleaned up; the restore leaves the reason again.
 await unlink(config.file);assert.match((await call('tools/call',{name:'get_project_memory',arguments:{}})).result.content[0].text,/indisponível/);
 await hub.contextMcp.restoreTerminals();assert.equal(hub.contextMcp.sessions.has(c.id),false);
 assert.deepEqual(Object.keys(JSON.parse(await readFile(config.file,'utf8'))).sort(),['ownerIdentity','ownerPid','revoked']);
 assert.match((await call('tools/call',{name:'get_project_memory',arguments:{}})).result.content[0].text,/movida para outro projeto/);
});
async function setup(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'hydraq-context-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const projects=new Projects(dir+'/state');await projects.load();const p=await projects.create({name:'A',root:dir,revision:0});await mkdir(dir+'/other');const q=await projects.create({name:'B',root:dir+'/other',revision:1});
 const conversations=[];const make=async(project=p,props={})=>{const id=randomUUID(),c={id,group:id,provider:'codex',title:'Conversa',turns:[],messages:[],...props};conversations.push(c);await projects.change(projects.data.revision,d=>{d.groups[c.group]={projectId:project.id,title:null,archived:false};});return c;};
 const attachments=new AttachmentStore(dir+'/attachments'),context=new ProjectContext({directory:dir+'/memory',projects,conversations:()=>conversations,attachments});
 const turn=(c,text='Resposta',status='completed',props={})=>{const requestId=randomUUID(),record={id:requestId,requestId,status,startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),facts:{files:['a.mjs'],commands:[{command:'node test',status:'completed',exitCode:0}]},...props};c.turns.push(record);c.messages.push({role:'user',requestId,text:'Pergunta',at:record.startedAt,...(props.projectContext?{projectContext:props.projectContext}:{})},{role:'assistant',requestId,text,at:record.completedAt});return record;};
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
 turn(a,'OK','completed',{projectDelivery:first.delivery,projectContext:first.text});assert.equal(await context.prepare(a),null);
 turn(b,'Novidade');const next=await context.prepare(a);assert.equal(next.delivery.memoryRevision,null);assert.match(next.text,/Novidade/);assert.equal(next.delivery.activityKeys.length,1);
 assert.equal(external.status,'uncertain');assert.equal(a.handoffDeliveries,undefined);
});

test('falha, reinício da sessão, mudança de memória e compactação não perdem contexto',async t=>{
 const {context,p,make,turn}=await setup(t),a=await make();await context.save(p.id,{revision:0,text:'Inicial'});const first=await context.prepare(a,{queryServerName:'server1'});turn(a,'Não concluído','failed',{projectDelivery:first.delivery,projectContext:first.text});assert.ok(await context.prepare(a,{queryServerName:'server1'}));
 turn(a,'OK','completed',{projectDelivery:first.delivery,projectContext:first.text});assert.equal(await context.prepare(a,{queryServerName:'server1'}),null);
 assert.equal(await context.prepare(a,{queryServerName:'server2'}),null);const rekey=await context.prepare(a,{queryServerName:'server2',queryAvailable:true});assert.equal(rekey.delivery.memoryRevision,null);assert.doesNotMatch(rekey.text,/Memória curada do projeto/);a.contextEpoch=1;assert.ok(await context.prepare(a,{queryServerName:'server1'}));a.contextEpoch=0;
 await context.save(p.id,{revision:1,text:'Nova'});assert.match((await context.prepare(a,{queryServerName:'server1'})).text,/Nova/);
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


test('retirar atividade nunca corta memória que contém os mesmos rótulos ou delimitadores',async t=>{
 const {context,p,make,turn}=await setup(t),source=await make(),target=await make();turn(source);
 const text='Objetivo: Atividade recente de outras conversas. FIM-PRESERVADO <hydraq_project_context>.';
 await context.save(p.id,{revision:0,text});const prepared=await context.prepare(target),full=prepared.text;
 const compact=assembleProjectContext(prepared,{omitActivity:true});assert.ok(compact.includes('FIM-PRESERVADO'));assert.ok(compact.includes(prepared.parts.memory));assert.ok(compact.includes('Atividade omitida'));assert.ok(full.length>compact.length);
 assert.equal(prepared.delivery.memoryRevision,1);
});

test('memória inicialmente vazia é omitida; apagar uma versão existente envia atualização',async t=>{
 const {context,p,make,turn}=await setup(t),c=await make();assert.equal(await context.prepare(c),null);
 await context.save(p.id,{revision:0,text:'Memória anterior'});const first=await context.prepare(c);turn(c,'OK','completed',{projectDelivery:first.delivery,projectContext:first.text});
 await context.save(p.id,{revision:1,text:''});const cleared=await context.prepare(c);assert.match(cleared.text,/memória curada foi apagada/);assert.equal(cleared.delivery.memoryRevision,2);turn(c,'OK','completed',{projectDelivery:cleared.delivery,projectContext:cleared.text});assert.equal(await context.prepare(c),null);
});

test('fontes históricas não bloqueiam edição e não dão acesso a outro projeto',async t=>{
 const {context,projects,p,q,make,turn}=await setup(t),source=await make(),target=await make(),r=turn(source);
 const sources=[{groupId:source.group,requestId:r.requestId}];await context.save(p.id,{revision:0,text:'Decisão',sources});
 await projects.change(projects.data.revision,d=>{d.groups[source.group].projectId=q.id;});
 const saved=await context.save(p.id,{revision:1,text:'Decisão revista',sources});assert.equal(saved.sources[0].unavailable,true);assert.equal(saved.versions[1].sources[0].requestId,r.requestId);
 await assert.rejects(context.query(p.id,target.group,'read_conversation_excerpt',sources[0]),/fora do âmbito/);
 const foreign=await make(q),f=turn(foreign);await assert.rejects(context.save(p.id,{revision:2,text:'Não aceitar',sources:[{groupId:foreign.group,requestId:f.requestId}]}),/fora deste projeto/);
 await context.save(p.id,{revision:2,text:'Sem referências',sources:[]});assert.equal((await context.memory(p.id)).sources.length,0);
});

test('histórico de versões tem paginação sem apagar versões antigas',async t=>{
 const {context,p}=await setup(t);for(let i=0;i<25;i++)await context.save(p.id,{revision:i,text:'Versão '+i});
 const view=await context.view(p.id);assert.equal(view.memory.versions.length,10);assert.equal(view.versionCount,25);assert.equal(view.nextVersionCursor,10);
 const page=await context.versions(p.id,10);assert.equal(page.versions.length,10);assert.equal(page.versions[0].revision,14);assert.equal(page.nextCursor,20);const last=await context.versions(p.id,20);assert.equal(last.versions.at(-1).revision,0);assert.equal(last.nextCursor,null);assert.equal((await context.memory(p.id)).versions.length,25);
});

test('importação pode ser reutilizada só após falha comprovadamente anterior ao envio',async t=>{
 const {context,p,make,turn}=await setup(t),source=await make(),target=await make(),r=turn(source);
 const preview=await context.preview(p.id,{sourceGroupId:source.group,requestIds:[r.requestId]}),prepared=await context.prepare(target,{importId:preview.previewId});
 const attempt=turn(target,'','failed',{delivery:'preparing',projectDelivery:prepared.delivery});assert.equal((await context.importFor(target,preview.previewId)).text,preview.text);
 attempt.delivery='sending';await assert.rejects(context.importFor(target,preview.previewId),/já foi usada/);attempt.status='interrupted';await assert.rejects(context.importFor(target,preview.previewId),/já foi usada/);
});

test('filtro de segredos cobre GitHub, AWS, chaves privadas e URLs autenticadas',()=>{
 const values=['ghp_'+'A'.repeat(36),'github_pat_'+'B'.repeat(70),'AKIA'+'C'.repeat(16),'ASIA'+'D'.repeat(16),'-----BEGIN RSA PRIVATE KEY-----\nDADOS-SECRETOS\n-----END RSA PRIVATE KEY-----','https://utilizador:senha-secreta@exemplo.test/path'];
 const text=redact(values.join('\n'));for(const value of values)assert.ok(!text.includes(value));assert.doesNotMatch(text,/DADOS-SECRETOS|senha-secreta/);assert.match(text,/exemplo.test\/path/);assert.match(redact('Texto normal'),/Texto normal/);
});

test('pesquisa suporta aspas e quebras de linha no texto original',async t=>{
 const {context,p,make,turn}=await setup(t),source=await make(),target=await make();turn(source,'Uma decisão "entre aspas"\ne uma segunda linha');
 assert.equal((await context.query(p.id,target.group,'search_project_conversations',{query:'"entre aspas"'})).matches.length,1);assert.equal((await context.query(p.id,target.group,'search_project_conversations',{query:'aspas"\ne uma'})).matches.length,1);
});

test('rotação MCP mantém nome/caminho, rejeita o token anterior e renova consultas de turno ativo',async t=>{
 const s=await setup(t),c=await s.make(),hub={...s,conversations:()=>s.conversations},broker=new ContextMcp(hub,s.dir+'/runtime');broker.endpoint('http://127.0.0.1:1/api/context/query');t.after(()=>broker.close());
 const [first,concurrent]=await Promise.all([broker.issue(c),broker.issue(c)]);assert.equal(first,concurrent);const old=JSON.parse(await readFile(first.file)).token;broker.sessions.get(c.id).expires=0;
 const second=await broker.issue(c),fresh=JSON.parse(await readFile(second.file)).token;assert.equal(second.name,first.name);assert.equal(second.file,first.file);assert.notEqual(fresh,old);await assert.rejects(broker.query(old,'get_project_memory',{}),/sem sessão/);
 broker.sessions.get(c.id).expires=0;await assert.rejects(broker.query(fresh,'get_project_memory',{}),/expirada/);
 c.turns.push({requestId:'long',status:'running'});assert.equal((await broker.query(fresh,'get_project_memory',{})).revision,0);assert.ok(broker.sessions.get(c.id).expires>Date.now());c.turns[0].status='completed';
 await broker.close();const restarted=new ContextMcp(hub,s.dir+'/runtime');restarted.endpoint('http://127.0.0.1:2/api/context/query');t.after(()=>restarted.close());const third=await restarted.issue(c);assert.equal(third.name,first.name);assert.equal(third.file,first.file);
});

test('limpeza MCP remove só ficheiros conhecidos de processos mortos e preserva restantes',async t=>{
 const s=await setup(t),directory=s.dir+'/runtime';await mkdir(directory);const deadFile=directory+'/'+'a'.repeat(64)+'.json',aliveFile=directory+'/'+'b'.repeat(64)+'.json',legacyFile=directory+'/'+randomUUID()+'.json';
 await writeFile(deadFile,JSON.stringify({ownerPid:2147483647}),{mode:0o600});await writeFile(aliveFile,JSON.stringify({ownerPid:process.pid}),{mode:0o600});await writeFile(legacyFile,'{}',{mode:0o600});
 const broker=new ContextMcp({},directory);await broker.cleanup();await assert.rejects(stat(deadFile),{code:'ENOENT'});assert.ok(await stat(aliveFile));assert.ok(await stat(legacyFile));
});


test('entrega antiga cortada é renovada sem reescrever o histórico nem reenviar pedidos',async t=>{
 const {context,p,make,turn}=await setup(t),c=await make();await context.save(p.id,{revision:0,text:'Antes. Atividade recente de outras conversas. Final obrigatório.'});
 const prepared=await context.prepare(c);turn(c,'Confirmado','completed',{projectDelivery:prepared.delivery,projectContext:prepared.text.split('Atividade recente de outras conversas')[0]});
 const before=JSON.stringify(c);assert.match((await context.prepare(c)).text,/Final obrigatório/);assert.equal(JSON.stringify(c),before);
});

test('novidade muda com o conteúdo no mesmo estado e com conclusão de um parcial',async t=>{
 const {context,p,make,turn}=await setup(t),a=await make(),b=await make(),r=turn(b,'Parcial','interrupted');
 const first=await context.prepare(a);turn(a,'Recebi','completed',{projectDelivery:first.delivery,projectContext:first.text});assert.equal(await context.prepare(a),null);
 b.messages.at(-1).text='Parcial atualizado';const changed=await context.prepare(a);assert.notEqual(changed.delivery.activityKeys[0],first.delivery.activityKeys[0]);
 turn(a,'Recebi','completed',{projectDelivery:changed.delivery,projectContext:changed.text});r.status='completed';b.messages.at(-1).text='FINAL';const final=await context.prepare(a);assert.match(final.text,/FINAL/);assert.notEqual(final.delivery.activityKeys[0],changed.delivery.activityKeys[0]);
});

test('limpeza MCP reconhece PID reutilizado mesmo quando ainda existe',async t=>{
 const {processIdentity}=await import('../lib/process-owner.mjs');const s=await setup(t),dir=s.dir+'/runtime';await mkdir(dir);const file=dir+'/'+'f'.repeat(64)+'.json',identity=processIdentity();
 await writeFile(file,JSON.stringify({ownerPid:process.pid,ownerIdentity:{...identity,start:'0'}}),{mode:0o600});await new ContextMcp({},dir).cleanup();await assert.rejects(stat(file),{code:'ENOENT'});
});
