import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {ClaudeCode} from '../lib/claude.mjs';
import {Antigravity} from '../lib/antigravity.mjs';
import {Hydraq} from '../lib/hydraq.mjs';
import {CodexClient} from '../lib/codex.mjs';
import {Providers} from '../lib/providers.mjs';
import {followupModes} from '../lib/followups.mjs';
import {followupOptions,captureDraftIntent,draftMode} from '../public/composer.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait=async fn=>{const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('Estado não chegou');await new Promise(r=>setTimeout(r,10));}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function setup(t,provider='claude',extra={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'hydraq-followups-'));await mkdir(dir+'/project');
 const options={dataDir:dir+'/state/'+provider,defaultCwd:dir+'/project',executable:process.execPath,prefixArgs:[root+'/test/fixtures/fake-'+(provider==='claude'?'claude':'agy')+'.mjs'],env:{...process.env,...(provider==='antigravity'?{FAKE_AGY_STOP:'confirmed'}:{}),...extra},settingsFile:dir+'/settings.json'};
 const make=()=>provider==='codex'?new Hydraq({...options,client:new CodexClient({executable:process.execPath,args:[root+'/test/fixtures/fake-codex.mjs']})}):provider==='claude'?new ClaudeCode(options):new Antigravity(options);let client=make();const hubOptions={dataDir:dir+'/state',defaultCwd:dir+'/project'};
 const hubs=[];const hub=new Providers({...hubOptions,clients:{[provider]:client}});hubs.push(hub);await hub.load();await hub.connect(provider);
 const created=await hub.create({provider,cwd:dir+'/project',model:provider==='codex'?'gpt-test':provider==='claude'?'haiku':'gemini-4-argon',effort:'low',sandbox:'workspace-write'});const c=client.conversation(created.id);
 t.after(async()=>{for(const h of hubs)await h.close();await rm(dir,{recursive:true,force:true});});
 return{dir,hub,client,c,async reopen(){await hub.close();client=make();const h=new Providers({...hubOptions,clients:{[provider]:client}});hubs.push(h);await h.load();await h.connect(provider);return{hub:h,client,c:client.conversation(c.id)};}};
}

test('Claude orienta next no mesmo turno e não repete um identificador já recebido',async t=>{
 const{hub,client,c}=await setup(t);await hub.send(c.id,'hold','initial');await wait(()=>c.status==='running');const turn=c.turnId;
 const r=await hub.steer(c.id,'Nova orientação','steer-1',turn,'next');assert.equal(r.accepted,true);await wait(()=>c.status==='completed');
 assert.equal(c.turns.length,1);assert.equal(c.turns[0].id,turn);assert.equal(c.messages.find(m=>m.requestId==='steer-1').delivery,'accepted');assert.equal(c.messages.at(-1).text,'Nova orientação');
 const d=await client.steer(c.id,'Nova orientação','steer-1',turn,'next');assert.equal(d.duplicate,true);assert.equal(c.messages.filter(m=>m.requestId==='steer-1').length,1);
 await assert.rejects(client.steer(c.id,'outro','steer-1',turn,'next'),/Identificador/);
});
test('Claude now conserva a tarefa no resultado intermédio e soma métricas dos dois ciclos',async t=>{
 const{hub,c}=await setup(t);await hub.send(c.id,'hold','initial');await wait(()=>c.status==='running');await hub.steer(c.id,'Redirecionado','now',c.turnId,'now');
 await wait(()=>c.turns[0].nativeCycles===1);assert.equal(c.status,'running');assert.ok(c.turnId);await wait(()=>c.status==='completed');
 assert.equal(c.turns.length,1);assert.equal(c.turns[0].usage.inputTokens,2020);assert.equal(c.sessionUsage.inputTokens,2020);assert.equal(c.messages.at(-1).text,'Redirecionado');
});
test('Claude mantém autorização pendente, recusa now e entrega next sem aprovar a ferramenta',async t=>{
 const{hub,client,c}=await setup(t);await hub.send(c.id,'tool-approval','initial');await wait(()=>c.status==='waiting');
 await assert.rejects(hub.steer(c.id,'Mudar agora','now',c.turnId,'now'),/autorização/);
 await hub.steer(c.id,'Depois da recusa','next',c.turnId,'next');await sleep(30);assert.equal(c.status,'waiting');assert.equal(client.approvals.size,1);
 const request=client.snapshot().approvals[0];await client.respond(request.id,{decision:'decline'});await wait(()=>c.status==='completed');assert.equal(c.items[0].denied,true);assert.equal(c.messages.at(-1).text,'Depois da recusa');
});
test('Claude conserva entrega incerta depois de perder o processo e não inicia outro turno',async t=>{
 const{hub,c}=await setup(t);await hub.send(c.id,'hold','initial');await wait(()=>c.status==='running');await hub.steer(c.id,'steer-disconnect','lost',c.turnId,'next');await wait(()=>c.status==='uncertain');
 assert.equal(c.messages.find(m=>m.requestId==='lost').delivery,'uncertain');assert.equal(c.turns.length,1);
});
test('orientação para turno terminado é recusada sem iniciar um pedido',async t=>{
 const{hub,c}=await setup(t);await hub.send(c.id,'normal','initial');await wait(()=>c.status==='completed');
 await assert.rejects(hub.steer(c.id,'tarde','late',c.turns[0].id,'next'),/terminou/);assert.equal(c.turns.length,1);
 await assert.rejects(hub.steer(c.id,'tarde','lateq',c.turns[0].id,'queue'),/terminou/);
});
test('fila durável só envia após conclusão e usa a configuração capturada',async t=>{
 const{hub,c}=await setup(t);await hub.send(c.id,'slow','initial');await wait(()=>c.status==='running');const rid=c.turnId;
 await hub.steer(c.id,'Pedido seguinte','queued',rid,'queue');assert.equal(c.turns.length,1);assert.equal(c.followups[0].status,'queued');assert.ok(hub.workScopes().some(s=>s.kind==='followup'));
 await wait(()=>c.turns.length===2&&c.status==='completed');assert.equal(c.followups[0].status,'delivered');assert.equal(c.turns[1].model,'haiku');assert.equal(c.turns[1].sandbox,'workspace-write');assert.equal(c.messages.find(m=>m.requestId==='queued').text,'Pedido seguinte');
});
test('duas mensagens em fila são entregues por ordem, uma por turno',async t=>{
 const{hub,c}=await setup(t);await hub.send(c.id,'slow','initial');await wait(()=>c.status==='running');const id=c.turnId;
 await hub.steer(c.id,'Primeira fila','q1',id,'queue');await hub.steer(c.id,'Segunda fila','q2',id,'queue');await wait(()=>c.turns.length===3&&c.status==='completed');
 assert.deepEqual(c.turns.map(t=>t.requestId),['initial','q1','q2']);assert.ok(c.followups.every(r=>r.status==='delivered'));
});
test('cancelar fila ou carregar em Parar impede o envio posterior',async t=>{
 const{hub,c}=await setup(t);await hub.send(c.id,'slow','initial');await wait(()=>c.status==='running');
 await hub.steer(c.id,'Não enviar','cancel-q',c.turnId,'queue');await hub.cancelFollowup(c.id,c.followups[0].id);await wait(()=>c.status==='completed');await sleep(100);assert.equal(c.turns.length,1);
 await hub.send(c.id,'hold','hold');await wait(()=>c.status==='running');await hub.steer(c.id,'Também não enviar','cancel-stop',c.turnId,'queue');await hub.interrupt(c.id);await wait(()=>c.status==='interrupted');assert.equal(c.followups[1].status,'cancelled');assert.equal(c.turns.length,2);
});
test('fila fica suspensa após reinício e não é reenviada automaticamente',async t=>{
 const setupState=await setup(t);const{hub,c}=setupState;await hub.send(c.id,'hold','initial');await wait(()=>c.status==='running');await hub.steer(c.id,'Conservar para revisão','persist-q',c.turnId,'queue');
 const restarted=await setupState.reopen();await sleep(100);assert.equal(restarted.c.followups[0].status,'blocked');assert.equal(restarted.c.turns.length,1);assert.match(restarted.c.followups[0].error,/reiniciou/);
});
test('Antigravity redireciona apenas depois do resultado de paragem e fecho, retomando o mesmo ID',async t=>{
 const{hub,c}=await setup(t,'antigravity');await hub.send(c.id,'hold','initial');await wait(()=>c.threadId&&c.status==='running');const native=c.threadId;
 await hub.steer(c.id,'Nova direção','redirect',c.turnId,'redirect');await wait(()=>c.turns.length===2&&c.status==='completed');
 assert.equal(c.threadId,native);assert.equal(c.turns[0].status,'interrupted');assert.equal(c.turns[0].nativeStopConfirmed,true);assert.equal(c.turns[0].processClosed,true);assert.equal(c.followups[0].status,'delivered');
});
test('Antigravity reconhece ERROR interrupted apenas após interrupção pedida pelo utilizador',async t=>{
 const{hub,c}=await setup(t,'antigravity',{FAKE_AGY_STOP:'native'});await hub.send(c.id,'hold','initial');await wait(()=>c.threadId&&c.status==='running');await hub.steer(c.id,'Continuar','redirect',c.turnId,'redirect');await wait(()=>c.turns.length===2&&c.status==='completed');assert.equal(c.turns[0].nativeStopConfirmed,true);assert.equal(c.turns[0].status,'interrupted');assert.equal(c.turns[0].processExit.code,1);
});
test('Antigravity conserva orientação sem retoma se o processo não confirmar a paragem',async t=>{
 const{hub,c}=await setup(t,'antigravity',{FAKE_AGY_STOP:'uncertain'});await hub.send(c.id,'hold','initial');await wait(()=>c.threadId&&c.status==='running');await hub.steer(c.id,'Guardar','redirect',c.turnId,'redirect');
 await wait(()=>c.followups[0].status==='blocked');assert.equal(c.turns.length,1);assert.match(c.followups[0].error,/confirmação/);
});
test('modos por cliente conservam intenção do rascunho e não habilitam Cursor/OpenCode',()=>{
 assert.deepEqual(followupModes('codex'),['steer','queue']);assert.deepEqual(followupModes('cursor'),[]);assert.deepEqual(followupModes('opencode'),['steer','queue']);
 const c={id:'chat',provider:'antigravity',turnId:'turn',status:'running',capabilities:{steer:false,followupModes:['redirect','queue']}};
 assert.deepEqual(followupOptions(c),['redirect','queue']);const i=captureDraftIntent(null,'instrução',c,'queue');assert.equal(i.deliveryMode,'queue');assert.equal(draftMode(i,c),'steer');assert.equal(draftMode(i,{...c,status:'completed',turnId:null}),'expired-steer');
});

test('Codex mantém steer nativo e entrega queue num turno novo, sem alterar o turno inicial',async t=>{
 const{hub,client,c}=await setup(t,'codex');await hub.send(c.id,'hold','initial');await wait(()=>c.status==='running');const target=c.turnId;await hub.steer(c.id,'Pedido depois','q',target,'queue');assert.equal(c.turns.length,1);await client.steer(c.id,'finish','native-steer',target);await wait(()=>c.turns.length===2&&c.status==='completed');assert.equal(c.turns[0].id,target);assert.equal(c.followups[0].status,'delivered');assert.equal(c.messages.find(m=>m.requestId==='native-steer').delivery,'accepted');
});
test('Parar durante a preparação do envio em fila cancela antes de escrever ao cliente',async t=>{
 const{hub,c}=await setup(t);await hub.send(c.id,'slow','initial');await wait(()=>c.status==='running');let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),prepare=hub.context.prepare.bind(hub.context);hub.context.prepare=async(...args)=>{entered();await gate;return prepare(...args);};
 await hub.steer(c.id,'Não despachar','q',c.turnId,'queue');await ready;await hub.interrupt(c.id);release();await sleep(100);assert.equal(c.followups[0].status,'cancelled');assert.equal(c.turns.length,1);
});

test('cancelar durante a primeira gravação não ressuscita uma mensagem em fila',async t=>{
 const{hub,client,c}=await setup(t);await hub.send(c.id,'hold','initial');await wait(()=>c.status==='running');const persist=client.persist.bind(client);let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let first=true;client.persist=async()=>{if(first){first=false;entered();await gate;}return persist();};
 const enqueuing=hub.steer(c.id,'Cancelar antes de guardar','saving-q',c.turnId,'queue');await ready;await hub.cancelFollowup(c.id,c.followups[0].id);release();await enqueuing;assert.equal(c.followups[0].status,'cancelled');assert.equal(c.turns.length,1);await hub.interrupt(c.id);
});

test('falha na confirmação de gravação suspende a fila em vez de enviar após erro HTTP',async t=>{
 const{hub,client,c}=await setup(t);await hub.send(c.id,'slow','initial');await wait(()=>c.status==='running');const persist=client.persist.bind(client);let count=0;client.persist=async()=>{if(++count===2)throw Error('Disco indisponível no ensaio');return persist();};
 await assert.rejects(hub.steer(c.id,'Não entregar sem guardar','disk-q',c.turnId,'queue'),/Disco/);await wait(()=>c.status==='completed');await sleep(100);assert.equal(c.followups[0].status,'blocked');assert.equal(c.turns.length,1);
});
