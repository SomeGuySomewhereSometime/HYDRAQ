import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {StringDecoder} from 'node:string_decoder';

const MAX=8*1024*1024,hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const json=async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw Error('Configuração MCP inválida: '+path.basename(file));}};
export async function externalCatalog(hub,cwd){
 const entries=[];const add=(source,servers)=>{for(const [name,config] of Object.entries(servers||{})){
  if(name==='hydraq'||name.startsWith('hydraq_')||!config||config.enabled===false||config.disabled===true||(!config.command&&!config.url&&!config.serverUrl))continue;
  const id=source+':'+name,signature=hash(config);entries.push({id,name,source,signature,config});
 }};
 const codex=hub.clients.codex;if(codex?.client?.call&&codex.connection==='connected'){const {config}=await codex.client.call('config/read',{cwd,includeLayers:false});add('codex',config?.mcp_servers);}
 const claude=await json(path.join(os.homedir(),'.claude.json')),project=await json(path.join(cwd,'.mcp.json'));
 add('claude',{...claude.mcpServers,...project.mcpServers,...claude.projects?.[cwd]?.mcpServers});
 const agy=await json(path.join(os.homedir(),'.gemini','config','mcp_config.json'));add('antigravity',agy.mcpServers);
 return entries;
}
export const publicCatalog=entries=>entries.map(({config,...entry})=>({...entry,transport:config.command?'stdio':'http'}));
export function externalConsent(body,entries,roles,author){
 if(!body?.enabled)return null;
 if(body.confirmRisk!==true||!['principal','all'].includes(body.scope)||!Array.isArray(body.servers)||!body.servers.length||body.servers.length>8||new Set(body.servers).size!==body.servers.length)throw Error('Confirma o risco e escolhe os servidores MCP externos desta tarefa.');
 const servers=body.servers.map(id=>{const entry=entries.find(e=>e.id===id);if(!entry)throw Error('Servidor externo não configurado: '+id);if(body.serverSignatures&&body.serverSignatures[id]!==entry.signature)throw Error('A configuração externa mudou; volta a escolher os servidores e a aceitar o risco.');const {config,...meta}=entry;return meta;});
 return {enabled:true,scope:body.scope,roles:body.scope==='all'?[...roles]:[author],servers,confirmedAt:new Date().toISOString()};
}
class Connection{
 constructor(config,cwd){this.config=config;this.cwd=cwd;this.seq=0;this.pending=new Map();this.closed=false;this.controller=new AbortController();}
 async start(){
  const c=this.config;
  if(c.command){
   this.child=spawn(c.command,c.args||[],{cwd:c.cwd||this.cwd,env:{...process.env,...c.env},stdio:['pipe','pipe','pipe'],detached:true});this.child.stdin.on('error',()=>{});this.child.stderr.resume();let buffer='';const decoder=new StringDecoder('utf8');
   this.child.stdout.on('data',data=>{buffer+=decoder.write(data);if(Buffer.byteLength(buffer)>MAX){this.close();return;}let i;while((i=buffer.indexOf('\n'))>=0){const raw=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!raw.trim())continue;try{const m=JSON.parse(raw);if(m.method){if(m.id!==undefined)this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Este cliente não suporta pedidos adicionais do servidor.'}})+'\n');continue;}const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(Error(m.error.message||'Erro MCP.')):p.resolve(m.result);}}catch{this.close();}}});
   this.child.once('error',()=>this.close());this.child.once('close',()=>this.close());
  }
  const init=await this.rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'HYDRAQ-external',version:'1'}});this.protocol=init.protocolVersion||'2024-11-05';await this.notify('notifications/initialized');
 }
 async http(message){
  const c=this.config,headers={'content-type':'application/json',accept:'application/json, text/event-stream',...c.headers,...c.http_headers};
  for(const [key,env] of Object.entries(c.env_http_headers||{}))if(process.env[env])headers[key]=process.env[env];
  if(c.bearer_token_env_var&&process.env[c.bearer_token_env_var])headers.authorization='Bearer '+process.env[c.bearer_token_env_var];
  if(this.session)headers['mcp-session-id']=this.session;if(this.protocol)headers['mcp-protocol-version']=this.protocol;
  const response=await fetch(c.url||c.serverUrl,{method:'POST',headers,body:JSON.stringify(message),signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(120000)])});if(!response.ok)throw Error('Servidor MCP HTTP recusou o pedido ('+response.status+').');
  this.session=response.headers.get('mcp-session-id')||this.session;if(message.id===undefined){await response.body?.cancel();return;}
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='',total=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>MAX)throw Error('Resposta externa excedeu 8 MB.');text+=decoder.decode(value,{stream:true});text=text.replaceAll('\r\n','\n');if(response.headers.get('content-type')?.includes('text/event-stream')){let i;while((i=text.indexOf('\n\n'))>=0){const event=text.slice(0,i);text=text.slice(i+2);const raw=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(raw){const m=JSON.parse(raw);if(m.id===message.id){if(m.error)throw Error(m.error.message);return m.result;}}}}}const m=JSON.parse(text);if(m.id!==message.id)throw Error('Resposta MCP com identificador inesperado.');if(m.error)throw Error(m.error.message);return m.result;}finally{await reader.cancel().catch(()=>{});}
 }
 rpc(method,params){
  if(this.closed)return Promise.reject(Error('Ligação MCP encerrada.'));const id=++this.seq;
  if(!this.config.command)return this.http({jsonrpc:'2.0',id,method,params});
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('O servidor externo não respondeu.'));this.close();},120000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 }
 async notify(method){if(this.config.command)this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method})+'\n');else await this.http({jsonrpc:'2.0',method});}
 close(){if(this.closed)return;this.closed=true;this.controller.abort();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Ligação MCP encerrada; a ação externa pode já ter começado.'));}this.pending.clear();try{if(this.child?.pid)process.kill(-this.child.pid,'SIGKILL');}catch{}}
}
export class ExternalMcp{
 constructor(cx){this.cx=cx;this.connections=new Map();this.jobs=new Map();this.resources=new Map();}
 async catalog(cwd){return this.catalogProvider?this.catalogProvider(cwd):externalCatalog(this.cx.hub,cwd);}
 allowed(r,role){return Boolean(r.externalMcp?.enabled&&r.externalMcp.roles.includes(role)&&this.cx.active(r)&&!r.workflow?.replan);}
 async connection(r,role,id){
  if(!this.allowed(r,role))throw Error('MCP externo não autorizado para este participante e tarefa.');
  const selected=r.externalMcp.servers.find(s=>s.id===id),entry=(await this.catalog(r.cwd)).find(s=>s.id===id);if(!selected||!entry||selected.signature!==entry.signature)throw Error('A configuração do servidor externo mudou ou não foi autorizada.');
  const key=r.id+':'+id;let connection=this.connections.get(key);if(connection?.closed){this.connections.delete(key);connection=null;}
  if(!connection){connection=new Connection(entry.config,r.cwd);this.connections.set(key,connection);try{connection.ready=connection.start();await connection.ready;}catch(e){connection.close();throw e;}}
  await connection.ready;return connection;
 }
 async list(r,role,id){const connection=await this.connection(r,role,id);let cursor,tools=[];do{const page=await connection.rpc('tools/list',cursor?{cursor}:{});tools.push(...page.tools||[]);if(tools.length>500)throw Error('Catálogo MCP externo demasiado grande.');cursor=page.nextCursor;}while(cursor);return {server:id,tools,outsideSandbox:true};}
 start(r,role,args){
  if(!this.allowed(r,role)||!r.workflow?.authorized||!r.workflow.approvedPlan||!['implementing','fixing','validating'].includes(r.workflow.phase))throw Error('Ações MCP externas requerem implementação autorizada e plano aprovado.');
  if(r.workflow.phase==='validating'&&r.workflow.reviews?.[role])throw Error('A revisão já foi entregue; não podes iniciar novas ações externas.');
  if(args.arguments!==undefined&&(!args.arguments||typeof args.arguments!=='object'||Array.isArray(args.arguments)))throw Error('Os argumentos externos têm de ser um objeto.');
  if(typeof args.messageId!=='string'||!args.messageId||args.messageId.length>100||typeof args.server!=='string'||typeof args.tool!=='string'||!args.tool||JSON.stringify(args.arguments||{}).length>100000)throw Error('Chamada externa inválida.');
  const signature=hash({server:args.server,tool:args.tool,arguments:args.arguments||{}}),old=(r.externalCalls||[]).find(c=>c.role===role&&c.messageId===args.messageId);if(old){if(old.signature!==signature)throw Error('Identificador externo reutilizado.');return old;}
  if((r.externalCalls||[]).filter(c=>c.role===role).length>=40)throw Error('Limite de 40 chamadas externas por participante nesta tarefa.');
  if(!r.externalMcp.servers.some(s=>s.id===args.server))throw Error('Servidor externo não autorizado.');
  if(r.externalCalls?.some(c=>c.role===role&&(c.status==='running'||(c.resultSaved&&!c.deliveredAt))))throw Error('Aguarda e lê a tua chamada externa anterior.');
  const call={id:randomUUID(),messageId:args.messageId,signature,role,server:args.server,tool:args.tool,status:'running',at:new Date().toISOString(),outsideSandbox:true,stage:r.workflow.steps?.[r.workflow.stepIndex||0]?.id};(r.externalCalls||=[]).push(call);
  const resource='external-tools',prior=this.resources.get(resource)||Promise.resolve();
  const job=this.cx.queue.then(()=>prior.catch(()=>{})).then(async()=>{
   if(!this.allowed(r,role)||call.status!=='running')throw Error('Chamada externa cancelada antes de começar.');const connection=await this.connection(r,role,args.server);if(!this.allowed(r,role)||call.status!=='running')throw Error('Chamada externa cancelada antes de começar.');call.dispatched=true;
   const result=await connection.rpc('tools/call',{name:args.tool,arguments:args.arguments||{}});if(Buffer.byteLength(JSON.stringify(result))>MAX)throw Error('Resposta externa excedeu 8 MB.');
   if(call.status!=='running')return;const folder=path.join(this.cx.outputDirectory(r),'external');await mkdir(folder,{recursive:true,mode:0o700});await writeFile(path.join(folder,call.id+'.json'),JSON.stringify(result),{mode:0o600});call.status=result.isError?'failed':'completed';call.resultSaved=true;
  }).catch(error=>{if(call.status==='running'){call.status=call.dispatched?'uncertain':'failed';call.error=error.message;}}).finally(async()=>{call.completedAt=new Date().toISOString();this.jobs.delete(call.id);await this.cx.serial(async()=>{r.updatedAt=call.completedAt;if(!this.cx.error)await this.cx.persist();});this.cx.kick();});
  this.resources.set(resource,job);this.jobs.set(call.id,{job,r,call});job.finally(()=>{if(this.resources.get(resource)===job)this.resources.delete(resource);}).catch(()=>{});return call;
 }
 async status(r,role,id){const call=r.externalCalls?.find(c=>c.id===id&&c.role===role);if(!call)throw Error('Chamada externa não encontrada.');if(!call.resultSaved)return {call};const result=JSON.parse(await readFile(path.join(this.cx.outputDirectory(r),'external',id+'.json'),'utf8'));await this.cx.serial(async()=>{call.deliveredAt=new Date().toISOString();await this.cx.persist();});return {call,mcpResult:result};}
 cancel(r){for(const {call} of this.jobs.values())if(r.externalCalls?.includes(call)&&call.status==='running'){call.status=call.dispatched?'uncertain':'interrupted';call.error='A tarefa foi interrompida. Uma ação externa já iniciada pode continuar; não foi repetida.';}for(const [key,c] of this.connections)if(key.startsWith(r.id+':')){c.close();this.connections.delete(key);}}
 async close(){for(const c of this.connections.values())c.close();await Promise.allSettled([...this.jobs.values()].map(j=>j.job));}
}
