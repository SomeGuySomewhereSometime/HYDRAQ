import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,mkdir,readFile,writeFile,rm}from'node:fs/promises';import path from'node:path';import{fileURLToPath}from'node:url';
import{OpenCode}from'../lib/opencode.mjs';import{OpenCodeRuntime,parseOpenCodeModels}from'../lib/opencode-runtime.mjs';import{filterModels}from'../public/model-picker.js';
import{turnFacts}from'../lib/handoff.mjs';
const fixture=fileURLToPath(new URL('./fixtures/fake-opencode.mjs',import.meta.url));
const wait=async fn=>{const end=Date.now()+8000;while(!fn()){if(Date.now()>end)throw Error('Timeout');await new Promise(r=>setTimeout(r,10))}};
const native=(id='free',more={})=>({id,name:id,providerID:'opencode',enabled:true,status:'active',cost:[{input:0,output:0,cache:{read:0,write:0}}],capabilities:{input:['text','image']},variants:[{id:'low'}],...more});

test('OpenCode conta escrita confirmada com caminho só em rawInput, mas não ferramentas falhadas',async t=>{
 const{root,make}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await client.send(c.id,'raw-write','raw-ok');await wait(()=>c.status==='completed');assert.deepEqual(turnFacts(c,c.turns.at(-1)).files,[root+'/project/sum.mjs']);
 await client.send(c.id,'raw-failed','raw-bad');await wait(()=>c.status==='completed');assert.deepEqual(turnFacts(c,c.turns.at(-1)).files,[]);
});
async function setup(t){const root=await mkdtemp('/tmp/hydraq-opencode-test-');await mkdir(root+'/project');const options={dataDir:root+'/state',defaultCwd:root+'/project',executable:process.execPath,prefixArgs:[fixture],env:{...process.env,FAKE_OPENCODE_LOG:root+'/log'}};const clients=[];const make=async()=>{const runtime=new OpenCodeRuntime({directory:root+'/state/native',executable:process.execPath,args:[fixture],env:options.env,manifest:false,minimumSettleMs:0,settleMs:1000});const c=new OpenCode({...options,runtime});clients.push(c);await c.load();await c.connect();return c;};t.after(async()=>{for(const c of clients)await c.close();await rm(root,{recursive:true,force:true})});return{root,make,clients,log:async()=> (await readFile(root+'/log','utf8')).trim().split('\n').map(JSON.parse)};}

test('OpenCode: só fornecedor opencode, todos os escalões/caches gratuitos, preços desconhecidos recusados',()=>{
 const values=[native(),native('nvidia',{providerID:'nvidia'}),native('paid',{cost:[{input:0,output:1,cache:{read:0,write:0}}]}),native('tiers',{cost:[...native().cost,{input:1,output:0,cache:{read:0,write:0}}]}),native('unknown',{cost:[]}),native('disabled',{enabled:false}),native('cache',{cost:[{input:0,output:0,cache:{read:1,write:0}}]})];
 const out=parseOpenCodeModels(values);assert.deepEqual(out.map(m=>m.id),['opencode/free']);assert.deepEqual(out[0].efforts,['default','low']);assert.equal(out[0].images,true);
});
test('seletor: pesquisa, favoritos/recentes e exclusão de outro fornecedor',()=>{const m=parseOpenCodeModels([native('alfa'),native('beta'),native('gama')]);assert.deepEqual(filterModels(m,'', ['opencode/gama'],['opencode/beta']).map(x=>x.nativeId),['gama','beta','alfa']);assert.equal(filterModels(m,'BETA')[0].id,'opencode/beta');assert.equal(filterModels([...m,{id:'nvidia/x',name:'x',providerID:'nvidia',free:true}],'x').length,0);});
test('sessão ACP OpenCode: retoma, troca de modelo, esforço, plan e imagens sem replay',async t=>{
 const {root,make,log}=await setup(t);let client=await make();assert.equal(client.models.length,2);assert.ok(client.models.every(m=>m.free&&m.id.startsWith('opencode/')));const c=await client.create({cwd:root+'/project',model:'opencode/test-free',effort:'low',sandbox:'plan'});await client.send(c.id,'primeiro','a',{images:[{bytes:Buffer.from('image'),mimeType:'image/png'}]});await wait(()=>c.status==='completed');assert.equal(c.turns[0].usage.inputTokens,12);assert.equal(c.turns[0].costUSD,0);const sid=c.threadId;await client.close();client=await make();await client.send(c.id,'segundo','b',{model:'opencode/second-free',effort:'high'});const r=client.conversation(c.id);await wait(()=>r.status==='completed');assert.equal(r.threadId,sid);const records=await log();assert.equal(records.length,2);assert.equal(records[1].model,'opencode/second-free');assert.equal(records[1].effort,'high');assert.equal(records[1].mode,'plan');assert.equal(records[0].prompt[1].type,'image');assert.equal(r.messages.filter(m=>m.role==='assistant').length,2);
 await client.send(c.id,'segundo','b');assert.equal((await log()).length,2);
});
test('autorizações, recusa antes da ferramenta e perguntas respondem sem auto-aprovar',async t=>{
 const {root,make}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});await client.send(c.id,'permission','p');await wait(()=>c.status==='waiting');let approval=[...client.approvals.values()][0];await client.respond(approval.id,{optionId:'reject'});await wait(()=>c.status==='completed');assert.equal(c.items.find(i=>i.nativeId==='tool-1').permissionDenied,true);
 await client.send(c.id,'question','q');await wait(()=>c.status==='waiting');approval=[...client.approvals.values()][0];await assert.rejects(client.respond(approval.id,{action:'accept',content:{}}),/Falta/);await client.respond(approval.id,{action:'accept',content:{answer:'npm'}});await wait(()=>c.status==='completed');assert.match(c.turns.at(-1).finalAnswer,/npm/);
});
test('cancelamento conserva parcial; morte a meio fica incerta; compactação renova contexto',async t=>{
 const {root,make}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});await client.send(c.id,'wait','w');await wait(()=>c.messages.some(m=>m.text==='Parcial'));await client.interrupt(c.id);await wait(()=>c.status==='interrupted');assert.equal(c.messages.at(-1).text,'Parcial');await client.send(c.id,'compact','cp');await wait(()=>c.status==='completed');assert.equal(c.contextEpoch,1);await client.send(c.id,'die','d');await wait(()=>c.status==='uncertain');assert.equal(c.turns.at(-1).delivery,'sending');await assert.rejects(client.send(c.id,'novo','n'),/incerto/);
});
test('catálogo: consultas agrupadas, cache por pasta e lista anterior conservada em erro',async t=>{
 const directory=await mkdtemp('/tmp/hydraq-opencode-cache-');t.after(()=>rm(directory,{recursive:true,force:true}));
 const runtime=new OpenCodeRuntime({directory,executable:'unused',manifest:false,minimumSettleMs:0,settleMs:800});let calls=0;runtime.request=async()=>{calls++;return[native()]};const [a,b]=await Promise.all([runtime.refresh('/tmp'),runtime.refresh('/tmp')]);assert.equal(a,b);assert.equal(calls,2);await runtime.refresh('/tmp');assert.equal(calls,2);runtime.request=async()=>{throw Error('offline')};await assert.rejects(runtime.refresh('/tmp',{force:true}),/offline/);assert.equal(runtime.cache.get('/tmp').models[0].id,'opencode/free');assert.equal(runtime.cache.get('/tmp').error,'offline');
});

test('modelo removido ou tornado pago não troca automaticamente nem envia novo pedido',async t=>{
 const {root,make,log}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});await client.send(c.id,'antes','one');await wait(()=>c.status==='completed');client.runtime.request=async()=>[native('second-free'),native('test-free',{cost:[{input:1,output:0,cache:{read:0,write:0}}]})];await assert.rejects(client.send(c.id,'depois','two'),/gratuito/);assert.equal(c.turns.length,1);assert.equal(c.model,'opencode/test-free');assert.equal((await log()).length,1);assert.ok(!client.models.some(m=>m.id==='opencode/test-free'));
});
test('permissões de passagem mantêm planeamento e nunca ativam aprovação automática no OpenCode',async()=>{
 const {mapSandbox}=await import('../lib/handoff.mjs');for(const mode of ['plan','read-only','ask'])assert.equal(mapSandbox(mode,'opencode'),'plan');for(const mode of ['workspace-write','accept-edits'])assert.equal(mapSandbox(mode,'opencode'),'workspace-write');
});
test('catálogo guardado regressa como não confirmado até uma consulta nativa válida',async t=>{
 const directory=await mkdtemp('/tmp/hydraq-opencode-cache-');t.after(()=>rm(directory,{recursive:true,force:true}));const runtime=new OpenCodeRuntime({directory,executable:'unused',manifest:false,minimumSettleMs:0,settleMs:800});runtime.request=async()=>[native()];await runtime.refresh('/tmp');const next=new OpenCodeRuntime({directory,executable:'unused'});await next.loadCache();assert.match(next.cache.get('/tmp').error,/confirmar/);assert.equal(next.cache.get('/tmp').models[0].id,'opencode/free');
});

test('passagem Claude → OpenCode → Claude conserva o grupo, contexto e sessão nativa',async t=>{
 const {root,make,log,clients}=await setup(t),client=await make();const {ClaudeCode}=await import('../lib/claude.mjs'),{Providers}=await import('../lib/providers.mjs');
 const claude=new ClaudeCode({dataDir:root+'/claude',defaultCwd:root+'/project',executable:process.execPath,prefixArgs:[fileURLToPath(new URL('./fixtures/fake-claude.mjs',import.meta.url))]});await claude.load();clients.push(claude);const hub=new Providers({clients:{opencode:client,claude},git:async()=>null,inspect:async()=>({files:{},warnings:[],complete:true})});await hub.connect('claude');
 const source=await hub.create({provider:'claude',cwd:root+'/project',model:'haiku',effort:'low',sandbox:'plan'});await hub.send(source.id,'plano original','original');await wait(()=>claude.conversation(source.id).status==='completed');
 const move=await hub.send(source.id,'comenta o plano','to-opencode',{provider:'opencode',model:'opencode/test-free',effort:'default',handoffMode:'quick'});await wait(()=>!hub.handoff&&client.conversation(move.conversationId).status==='completed');const target=client.conversation(move.conversationId),sid=target.threadId;assert.equal(target.sandbox,'plan');assert.equal(target.group,source.id);assert.match((await log()).at(-1).text,/<hydraq_handoff>/);
 await hub.send(target.id,'regressa','back',{provider:'claude',model:'haiku',effort:'low',handoffMode:'quick'});await wait(()=>!hub.handoff&&claude.conversation(source.id).status==='completed');await hub.send(source.id,'continua','again',{provider:'opencode',handoffMode:'quick'});await wait(()=>!hub.handoff&&target.status==='completed');assert.equal(target.threadId,sid);
});
test('catálogo grande continua pesquisável sem incluir fornecedores externos',()=>{const list=parseOpenCodeModels(Array.from({length:1500},(_,i)=>native('model-'+i)));assert.equal(list.length,1500);assert.equal(filterModels(list,'model-1499').length,1);assert.equal(filterModels(list,'', ['opencode/model-1499'])[0].id,'opencode/model-1499');});

test('metadados privados: apenas OpenCode gratuito e nenhuma credencial global propagada',async t=>{
 const directory=await mkdtemp('/tmp/hydraq-opencode-registry-');t.after(()=>rm(directory,{recursive:true,force:true}));t.mock.method(globalThis,'fetch',async url=>({ok:true,json:async()=>String(url).includes('models.dev')?{opencode:{id:'opencode',name:'OpenCode',env:['OPENCODE_API_KEY'],models:{free:{name:'Free',cost:{input:0,output:0}},paid:{cost:{input:1,output:1}},obsolete:{status:'deprecated',cost:{input:0,output:0}}}},nvidia:{models:{gpu:{cost:{input:0,output:0}}}}}:{data:[{id:'free'},{id:'paid'}]}}));
 const runtime=new OpenCodeRuntime({directory,executable:'unused',env:{...process.env,OPENCODE_API_KEY:'SECRET',NVIDIA_API_KEY:'SECRET'}});await runtime.manifest();const seed=JSON.parse(await readFile(directory+'/cache/opencode/models.json','utf8'));assert.deepEqual(Object.keys(seed),['opencode']);assert.deepEqual(Object.keys(seed.opencode.models),['free']);const env=await runtime.environment('test');assert.equal(env.OPENCODE_API_KEY,undefined);assert.equal(env.NVIDIA_API_KEY,undefined);assert.ok(env.OPENCODE_DB.startsWith(directory));const config=JSON.parse(await readFile(env.XDG_CONFIG_HOME+'/opencode/opencode.json','utf8'));assert.deepEqual(config.policies.slice(0,2),[{action:'provider.use',resource:'*',effect:'deny'},{action:'provider.use',resource:'opencode',effect:'allow'}]);assert.ok(!config.permissions.some(p=>p.action==='*'&&p.effect==='allow'));
});

test('orientar OpenCode: caixa nativa sem wake, mesmo turno ACP e recibo confirmado no histórico',async t=>{
 const {root,make,log}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await client.send(c.id,'wait','initial');const turn=c.turnId,sid=c.threadId;
 const receipt=await client.steer(c.id,'NOVO-OBJETIVO','steer',turn);assert.equal(receipt.accepted,true);
 await wait(()=>c.status==='completed'&&c.messages.find(m=>m.requestId==='steer').delivery==='accepted');
 assert.equal(c.turns.length,1);assert.equal(c.threadId,sid);assert.match(c.turns[0].finalAnswer,/NOVO-OBJETIVO/);
 const admissions=(await readFile(root+'/state/native/admissions.jsonl','utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(admissions.length,1);assert.equal(admissions[0].resume,false);assert.equal(admissions[0].delivery,'steer');assert.equal((await log()).length,1);
 assert.equal((await client.steer(c.id,'NOVO-OBJETIVO','steer',turn)).duplicate,true);
 await assert.rejects(client.steer(c.id,'diferente','steer',turn),/Identificador/);
 await assert.rejects(client.steer(c.id,'tarde','late',turn),/terminou/);
});
test('orientar OpenCode perante autorização não a aprova nem despacha outro pedido',async t=>{
 const{root,make}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});
 await client.send(c.id,'permission','p');await wait(()=>c.status==='waiting');
 await client.steer(c.id,'DEPOIS-DA-DECISAO','s',c.turnId);await new Promise(r=>setTimeout(r,60));assert.equal(c.status,'waiting');assert.equal(client.approvals.size,1);
 const a=[...client.approvals.values()][0];await client.respond(a.id,{optionId:'reject'});
 await wait(()=>c.status==='completed'&&c.messages.find(m=>m.requestId==='s').delivery==='accepted');
 assert.match(c.turns[0].finalAnswer,/DEPOIS-DA-DECISAO/);assert.equal(c.turns.length,1);assert.equal(c.items.find(i=>i.nativeId==='tool-1').permissionDenied,true);
});
test('orientação que termina durante a gravação não envia bytes nem inicia outro turno',async t=>{
 const{root,make}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});await client.send(c.id,'wait','w');
 const persist=client.persist.bind(client);let first=true;client.persist=async()=>{await persist();if(first){first=false;await client.interrupt(c.id);await wait(()=>c.status==='interrupted');}};
 await assert.rejects(client.steer(c.id,'Não entregar','s',c.turnId),/terminou/);assert.equal(c.messages.find(m=>m.requestId==='s').delivery,'rejected');assert.equal(c.turns.length,1);
 await assert.rejects(readFile(root+'/state/native/admissions.jsonl'),/ENOENT/);
});
test('orientação admitida tarde é retirada e não contamina o pedido seguinte',async t=>{
 const{root,make,log}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});await client.send(c.id,'wait','w');
 const admit=client.runtime.admitSteer.bind(client.runtime);client.runtime.admitSteer=async(...args)=>{const result=await admit(...args);await client.interrupt(c.id);await wait(()=>c.status==='interrupted');return result;};
 await client.steer(c.id,'late instruction','s',c.turnId);assert.equal(c.messages.find(m=>m.requestId==='s').delivery,'rejected');
 await client.send(c.id,'Novo pedido','new');await wait(()=>c.status==='completed');assert.equal((await log()).length,2);assert.equal(c.turns.at(-1).finalAnswer,'Resposta Novo pedido');
});
test('resposta HTTP perdida fica incerta e repetir o identificador nunca reenvia',async t=>{
 const{root,make}=await setup(t),client=await make(),c=await client.create({cwd:root+'/project',model:'opencode/test-free'});await client.send(c.id,'permission','p');await wait(()=>c.status==='waiting');const turn=c.turnId;
 await assert.rejects(client.steer(c.id,'http-lost','s',turn));assert.equal(c.messages.find(m=>m.requestId==='s').delivery,'uncertain');
 assert.equal((await client.steer(c.id,'http-lost','s',turn)).duplicate,true);assert.equal((await readFile(root+'/state/native/admissions.jsonl','utf8')).trim().split('\n').length,1);
 await client.interrupt(c.id);await wait(()=>c.status==='interrupted');await client.send(c.id,'Depois da incerteza','new');await wait(()=>c.status==='completed');assert.equal(c.messages.find(m=>m.requestId==='s').delivery,'rejected');
});
test('reinício não reenvia uma orientação e limpa apenas o seu item antes do pedido novo',async t=>{
 const{root,make}=await setup(t);let client=await make();const c=await client.create({cwd:root+'/project',model:'opencode/test-free'});await client.send(c.id,'primeiro','p');await wait(()=>c.status==='completed');await client.close();
 const message={id:'local',nativeInputId:'msg_pending',nativeSessionId:c.threadId,requestId:'old-steer',role:'user',kind:'steer',mode:'steer',text:'Pendente antigo',turnId:c.turns[0].id,delivery:'sending'};c.messages.push(message);
 await writeFile(root+'/state/state.json',JSON.stringify({version:1,conversations:[c]}));await writeFile(root+'/state/native/fixture-inbox/msg_pending.json',JSON.stringify({id:'msg_pending',sessionID:c.threadId,type:'user',payload:{text:message.text},delivery:'steer'}));
 client=await make();const recovered=client.conversation(c.id);assert.equal(recovered.messages.at(-1).delivery,'uncertain');await client.send(c.id,'Novo','new');await wait(()=>recovered.status==='completed');assert.equal(recovered.messages.find(m=>m.requestId==='old-steer').delivery,'rejected');assert.equal(recovered.turns.at(-1).finalAnswer,'Resposta Novo');
 await assert.rejects(readFile(root+'/state/native/admissions.jsonl'),/ENOENT/);
});
test('fila OpenCode usa o envio normal e conserva Orientar como predefinição',async t=>{
 const {root,make}=await setup(t),client=await make(),{Providers}=await import('../lib/providers.mjs');const hub=new Providers({clients:{opencode:client},git:async()=>null,inspect:async()=>({files:{},complete:true,warnings:[]})});await hub.followups.load();try{
 const created=await hub.create({provider:'opencode',cwd:root+'/project',model:'opencode/test-free'}),c=client.conversation(created.id);await hub.send(c.id,'wait','p');const turn=c.turnId;
 assert.deepEqual(hub.snapshot().providers.opencode.capabilities.followupModes,['steer','queue']);await hub.steer(c.id,'Pedido após o atual','q',turn,'queue');await hub.steer(c.id,'Termina agora','s',turn);
 await wait(()=>c.turns.length===2&&c.status==='completed');assert.equal(c.followups[0].status,'delivered');assert.equal(c.turns[1].finalAnswer,'Resposta Pedido após o atual');
 }finally{await hub.close();}
});
