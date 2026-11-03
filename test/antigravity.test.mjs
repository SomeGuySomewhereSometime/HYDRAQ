import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Antigravity, parseAntigravityModels, checkAntigravitySettings } from '../lib/antigravity.mjs';
import { Providers } from '../lib/providers.mjs';
import { Hydraq } from '../lib/hydraq.mjs';
import { CodexClient } from '../lib/codex.mjs';
import { canSteer, captureDraftIntent } from '../public/composer.js';
import { createHttpServer } from '../lib/http.mjs';
import { turnFacts } from '../lib/handoff.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const waitFor=async predicate=>{const deadline=Date.now()+4000;while(!predicate()){if(Date.now()>deadline)throw new Error('Tempo excedido.');await new Promise(r=>setTimeout(r,10));}};
async function setup(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'hydraq-agy-test-'));
  const settingsFile=path.join(directory,'settings.json');
  const options={dataDir:path.join(directory,'state'),defaultCwd:directory,settingsFile,executable:process.execPath,prefixArgs:[path.join(root,'test/fixtures/fake-agy.mjs')],env:{...process.env,GEMINI_API_KEY:'must-be-removed',ANTHROPIC_API_KEY:'must-be-removed',FAKE_AGY_BRAIN:path.join(directory,'brain')}};
  const client=new Antigravity(options);
  await client.load();await client.connect();
  const cleanupClients=[client];
  t.after(async()=>{for(const instance of cleanupClients)await instance.close();await rm(directory,{recursive:true,force:true});});
  return {client,directory,options,settingsFile,cleanupClients};
}
async function chat(client,directory){return client.create({cwd:directory,model:'gemini-4-argon',effort:'low'});}

test('sucesso sem resposta é falha explícita e recusa de ferramenta mantém a sua causa',async t=>{
 const{client,directory}=await setup(t),c=await chat(client,directory);
 await client.send(c.id,'diagnostic-empty','empty');await waitFor(()=>c.status==='failed');
 assert.deepEqual(c.turns.at(-1).diagnostics.map(d=>d.code),['empty']);assert.match(c.error,/sem uma resposta/);
 const pid=client.session.child.pid;
 await client.send(c.id,'diagnostic-refused-empty','refused');await waitFor(()=>c.status==='failed');
 assert.equal(client.session.child.pid,pid);assert.deepEqual(c.turns.at(-1).diagnostics.map(d=>d.code),['permission','empty']);assert.match(c.error,/falta de autorização/);assert.doesNotMatch(c.error,/quota/i);
 assert.equal(c.turns.length,2);
});
test('recusa em stderr acompanha uma resposta válida sem a tornar falhada',async t=>{
 const{client,directory}=await setup(t),c=await chat(client,directory);
 await client.send(c.id,'diagnostic-stderr-warning','stderr');await waitFor(()=>c.status==='completed');
 assert.match(c.messages.at(-1).text,/Resposta recebida/);assert.equal(c.error,null);
 assert.equal(c.turns[0].diagnostics[0].code,'permission');assert.equal(c.turns[0].diagnostics[0].source,'stderr');
 await client.persist();const restored=JSON.parse(await readFile(path.join(client.dataDir,'state.json'),'utf8'));assert.equal(restored.conversations[0].turns[0].diagnostics[0].code,'permission');
});
test('quota estruturada ou em stderr é distinguida de capacidade e não contamina o pedido seguinte',async t=>{
 const{client,directory}=await setup(t),c=await chat(client,directory);
 await client.send(c.id,'diagnostic-quota-structured','quota-object');await waitFor(()=>c.status==='failed');assert.ok(c.turns.at(-1).diagnostics.some(d=>d.code==='quota'));
 await client.send(c.id,'diagnostic-stderr-quota','quota-stderr');await waitFor(()=>c.status==='failed');assert.equal(c.error,'Request failed');assert.equal(c.turns.at(-1).diagnostics.find(d=>d.code==='quota').source,'stderr');
 await client.send(c.id,'diagnostic-resource-busy','capacity');await waitFor(()=>c.status==='failed');assert.ok(!c.turns.at(-1).diagnostics.some(d=>d.code==='quota'));
 await client.send(c.id,'diagnostic-prose','normal');await waitFor(()=>c.status==='completed');assert.deepEqual(c.turns.at(-1).diagnostics,[]);assert.equal(c.turns.length,4);
});
test('diagnósticos históricos projetados conservam dados nativos e factos de recusas fora das ações visíveis',async t=>{
 const{client,directory}=await setup(t),c=await chat(client,directory);
 c.turns=[{id:'old-turn',requestId:'old',status:'completed',facts:{declined:2,commands:[],files:[]}}];c.status='completed';
 const original=JSON.stringify(c);const snapshot=client.snapshot().conversations[0];
 assert.deepEqual(snapshot.turns[0].diagnostics.map(d=>d.code),['permission','empty']);assert.match(snapshot.turns[0].diagnostics[0].message,/2 ferramenta/);
 assert.equal(JSON.stringify(c),original,'projetar diagnóstico não reescreve histórico');
 delete c.turns[0].facts;c.items=[{id:'old-tool',turnId:'old-turn',permissionDenied:true,tool:'run_command'}];
 const withoutFacts=JSON.stringify(c);assert.equal(client.snapshot().conversations[0].turns[0].diagnostics[0].code,'permission');assert.equal(JSON.stringify(c),withoutFacts);
});

test('write_file com Path nativo entra nos factos de ficheiros alterados',async t=>{
 const{client,directory}=await setup(t),c=await chat(client,directory);await client.send(c.id,'write-file-path','native-write');await waitFor(()=>c.status==='completed');assert.deepEqual(turnFacts(c,c.turns.at(-1)).files,['/tmp/sum.mjs']);
});

test('catálogo limpa ANSI/spinner, agrupa raciocínio dos modelos nativos e rejeita modelos API personalizados',()=> {
  const models=parseAntigravityModels('\r⠋ Fetching available models...\r\x1b[32mgemini-4-argon-high\x1b[0m\tGemini 4 Argon (High)\ngemini-4-argon-low\tGemini 4 Argon (Low)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\ngemma-4-26b\tGemma 4 26B\ncustom-paid\tAPI');
  assert.equal(models.length,3);
  assert.deepEqual(models[0].efforts,['low','high']);
  assert.equal(models[1].id,'claude-opus-5-5');
  assert.equal(models[1].supportsReasoningEffortUpdates,null);
  assert.equal(models[2].id,'gemma-4-26b');
  assert.deepEqual(models[2].efforts,['medium']);
  assert.throws(()=>parseAntigravityModels('Login required'),/não devolveu/);
});

test('créditos adicionais e configurações inválidas bloqueiam o envio sem alterar opções globais',async t=> {
  const {client,directory,settingsFile}=await setup(t);
  const c=await chat(client,directory);
  await writeFile(settingsFile,JSON.stringify({useG1Credits:true}));
  await assert.rejects(client.send(c.id,'pedido','credits'),/Use G1 Credits/);
  assert.equal(c.messages.length,0);
  await writeFile(settingsFile,'{invalid');
  await assert.rejects(checkAntigravitySettings(settingsFile),/verificar/);
  await writeFile(settingsFile,JSON.stringify({customModels:{paid:{}}}));
  await assert.rejects(checkAntigravitySettings(settingsFile),/catálogo nativo/);
});

test('streaming aquece o mesmo processo e sessão, mostra erros de ferramenta e mantém contadores nativos e deltas por turno',async t=> {
  const {client,directory}=await setup(t);
  const c=await chat(client,directory);
  await client.send(c.id,'primeiro','a');await waitFor(()=>c.status==='completed');
  const pid=client.session.child.pid;
  const id=c.threadId;
  assert.equal(client.snapshot().conversations[0].progress.counts.failed,1);
  assert.equal(c.items[0].permissionDenied,true);
  assert.match(c.messages.at(-1).text,/Resposta 1/);
  assert.equal(c.messages.at(-1).requestId,'a');
  assert.equal(c.nativeUsage.input_tokens,100);
  assert.equal(c.turns[0].nativeTurnUsage.input_tokens,100);
  assert.ok(c.messages.filter(m=>m.role==='assistant').every(m=>m.text.trim()));
  assert.equal(c.turns[0].usage,null);
  await client.send(c.id,'segundo','b');await waitFor(()=>c.status==='completed');
  assert.equal(client.session.child.pid,pid);
  assert.equal(c.threadId,id);
  assert.match(c.messages.at(-1).text,/Resposta 2/);
  assert.equal(c.nativeUsage.input_tokens,200);
  assert.equal(c.turns[1].nativeTurnUsage.input_tokens,100);
  assert.equal(c.turns[1].nativeTurnUsage.output_tokens,10);
  await client.send(c.id,'segundo','b');assert.equal(c.turns.length,2);
  await assert.rejects(client.send(c.id,'alterado','b'),/outro texto/);
});

test('classifica alterações de ficheiros, pesquisa web, subagentes, modo accept-edits e evita duplicar respostas multi-passo',async t=> {
  const {client,directory}=await setup(t);
  const c=await client.create({cwd:directory,model:'gemini-4-argon',effort:'low',sandbox:'accept-edits'});
  await client.send(c.id,'rich-tools','rich-1');await waitFor(()=>c.status==='completed');
  assert.equal(c.permissionMode,'accept-edits');
  const types=c.items.map(i=>i.type);
  assert.deepEqual(types,['fileChange','webSearch','subagent']);
  assert.equal(c.items[0].changes[0].path,'/tmp/exemplo.js');
  assert.equal(c.items[1].query,'antigravity docs');
  assert.deepEqual(c.items[2].subagents,['Codebase Researcher']);
  const assistantMessages=c.messages.filter(m=>m.role==='assistant');
  assert.equal(assistantMessages.length,2);
  assert.equal(assistantMessages[0].phase,'commentary');
  assert.equal(assistantMessages[1].phase,'final_answer');
  assert.equal(assistantMessages[1].requestId,'rich-1');
  const progress=client.snapshot().conversations[0].progress;
  assert.equal(progress.counts.completed,3);
  assert.equal(progress.actions.find(a=>a.type==='subagent').detail,'Delegar num subagente Codebase Researcher');
});

test('troca para Claude e retoma após reinício pelo ID nativo, sem mover a conversa para Codex',async t=> {
  const {client,directory,options,cleanupClients}=await setup(t);
  const c=await chat(client,directory);
  await client.send(c.id,'primeiro','a');await waitFor(()=>c.status==='completed');
  const id=c.threadId,pid=client.session.child.pid;
  await client.send(c.id,'mudar','b',{model:'claude-opus-5-5',effort:'high'});await waitFor(()=>c.status==='completed');
  assert.equal(c.threadId,id);assert.notEqual(client.session.child.pid,pid);
  assert.match(c.messages.at(-1).text,/Resposta 2.*claude-opus-5-5-high/);
  await client.close();
  const reopened=new Antigravity(options);cleanupClients.push(reopened);await reopened.load();await reopened.connect();
  const restored=reopened.conversation(c.id);
  await reopened.send(c.id,'continuar','c');await waitFor(()=>restored.status==='completed');
  assert.equal(restored.threadId,id);assert.match(restored.messages.at(-1).text,/Resposta 3/);
});

test('sem steer no Antigravity; interrupção termina apenas o processo próprio e impede mudança em execução',async t=> {
  const {client,directory}=await setup(t);
  const c=await chat(client,directory);
  await client.send(c.id,'hold','a');await waitFor(()=>c.threadId);
  assert.equal(canSteer(c),false);
  assert.equal(captureDraftIntent(null,'texto',c).kind,'send');
  await assert.rejects(client.steer(c.id,'orientar'),/não suporta/);
  await assert.rejects(client.send(c.id,'outro','b',{model:'claude-opus-5-5',effort:'high'}),/em curso/);
  await client.interrupt(c.id);await waitFor(()=>c.status==='interrupted');
  assert.equal(client.session,null);
});

test('queda nativa não reenvia nem declara conclusão; reinício conserva o estado incerto',async t=> {
  const {client,directory,options,cleanupClients}=await setup(t);
  const c=await chat(client,directory);
  await client.send(c.id,'disconnect','a');await waitFor(()=>c.status==='uncertain');
  assert.equal(c.turns.length,1);
  await assert.rejects(client.send(c.id,'continuar','b'),/incerto/);
  await client.close();
  const reopened=new Antigravity(options);cleanupClients.push(reopened);await reopened.load();
  assert.equal(reopened.conversation(c.id).status,'uncertain');
});

test('clientes independentes preservam histórico Codex e encaminham pedidos, bloqueando tarefas simultâneas',async t=> {
  const {client:agy,directory,cleanupClients}=await setup(t);
  const codex=new Hydraq({dataDir:path.join(directory,'codex'),defaultCwd:directory,client:new CodexClient({executable:process.execPath,args:[path.join(root,'test/fixtures/fake-codex.mjs')]})});
  const hub=new Providers({clients:{codex,antigravity:agy}});cleanupClients.push(codex);await codex.load();await hub.connect('codex');
  const c=await hub.create({provider:'codex',cwd:directory,model:'gpt-test',effort:'low'});
  const a=await hub.create({provider:'antigravity',cwd:directory,model:'claude-opus-5-5',effort:'high',sandbox:'plan'});
  assert.equal(a.provider,'antigravity');
  await hub.send(c.id,'hold','hold');
  await assert.rejects(hub.send(a.id,'outro','b'),/em curso/);
  assert.equal(agy.conversation(a.id).messages.length,0);
  await hub.interrupt(c.id);await waitFor(()=>codex.conversation(c.id).status==='interrupted');
  await hub.send(a.id,'claude','a');await waitFor(()=>agy.conversation(a.id).status==='completed');
  const snapshot=hub.snapshot();
  assert.equal(snapshot.conversations.length,2);
  assert.equal(snapshot.conversations.find(chat=>chat.id===c.id).provider,'codex');
  assert.equal(snapshot.providers.antigravity.capabilities.steer,false);
  assert.equal(snapshot.providers.codex.capabilities.steer,true);
});

test('resultado de outra sessão ou resposta inválida não confirma conclusão nem causa reenvio',async t=> {
  const {client,directory}=await setup(t);
  for(const text of ['foreign-result','bad-response']) {
    const c=await chat(client,directory);
    await client.send(c.id,text,text);await waitFor(()=>c.status==='uncertain');
    assert.match(c.error,/conversa nativa|Resposta nativa inválida/);
    assert.equal(c.turns.length,1);
    assert.ok(c.threadId.startsWith('native-'));
  }
});

test('erro explícito nativo apresenta a razão, sem mudar modelo nem repetir o pedido',async t=> {
  const {client,directory}=await setup(t);
  const c=await chat(client,directory);
  await client.send(c.id,'native-error','error');await waitFor(()=>c.status==='failed');
  assert.equal(c.error,'Quota nativa esgotada');assert.equal(c.turns.length,1);assert.equal(c.model,'gemini-4-argon');
});

test('histórico gravado a meio de uma resposta reabre como incerto e sem indicador de streaming ativo',async t=> {
  const {client,directory,options,cleanupClients}=await setup(t);
  const c=await chat(client,directory);
  await client.send(c.id,'partial-hold','partial');await waitFor(()=>c.messages.some(m=>m.streaming));await client.persist();
  const reopened=new Antigravity(options);cleanupClients.push(reopened);await reopened.load();
  const restored=reopened.conversation(c.id);
  assert.equal(restored.status,'uncertain');assert.equal(restored.turns.length,1);
  assert.ok(restored.messages.every(m=>!m.streaming));
  await client.interrupt(c.id);await waitFor(()=>c.status==='interrupted');
});

test('HTTP escolhe cliente por conversa e encaminha autorizações Codex pelo identificador completo',async t=> {
  const {client:agy,directory,cleanupClients}=await setup(t);
  const codex=new Hydraq({dataDir:path.join(directory,'codex'),defaultCwd:directory,client:new CodexClient({executable:process.execPath,args:[path.join(root,'test/fixtures/fake-codex.mjs')]})});
  cleanupClients.push(codex);await codex.load();
  const hub=new Providers({clients:{codex,antigravity:agy}});await hub.connect('codex');
  const server=createHttpServer({hydraq:hub,publicDir:path.join(root,'public')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeStreams();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const {token}=await(await fetch(base+'/api/bootstrap',{headers:{'X-HYDRAQ-Bootstrap':'1'}})).json();
  const post=async(route,body)=>{const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','x-hydraq-token':token},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const agyChat=await post('/api/conversations',{provider:'antigravity',cwd:directory,model:'claude-opus-5-5',effort:'high',sandbox:'plan'});
  assert.equal(agyChat.status,201);assert.equal(agyChat.body.capabilities.steer,false);
  const invalid=await post('/api/conversations',{provider:'unrecognized',cwd:directory,model:'gpt-test'});
  assert.equal(invalid.status,400);
  const codexChat=await post('/api/conversations',{provider:'codex',cwd:directory,model:'gpt-test',effort:'low'});
  await post(`/api/conversations/${codexChat.body.id}/send`,{text:'approval',requestId:'approval'});
  await waitFor(()=>hub.snapshot().approvals.length);
  const approval=hub.snapshot().approvals[0];assert.ok(approval.id.startsWith('codex:'));
  assert.equal((await post('/api/respond',{id:approval.id,decision:'decline'})).status,200);
  await waitFor(()=>codex.conversation(codexChat.body.id).status==='completed');
  assert.equal((await post(`/api/conversations/${agyChat.body.id}/send`,{text:'claude',requestId:'agy-http'})).status,200);
  await waitFor(()=>agy.conversation(agyChat.body.id).status==='completed');
  assert.equal(codex.conversations.length,1);assert.equal(agy.conversations.length,1);
});

test('passo repetido pelo agy: a hora de fim é a primeira em que terminou, guardada uma vez',async t=>{
 const{client,directory}=await setup(t),c=await chat(client,directory);
 await client.send(c.id,'repeat-step','repeat');await waitFor(()=>c.status==='completed');
 const item=c.items.find(i=>i.tool==='read_file'),ms=Date.parse(item.completedAt)-Date.parse(item.at);
 assert.equal(item.status,'completed');assert.ok(ms>=80&&ms<230,`fim aos ${ms} ms, não no passo repetido`);
});

test('agy: resumos do raciocínio lidos do seu transcript, durações nativas, sem reler pedidos anteriores',async t=>{
 const{client,directory}=await setup(t),c=await chat(client,directory);
 await client.send(c.id,'think','think-1');await waitFor(()=>c.status==='completed');
 const thoughts=()=>c.items.filter(i=>i.turnId===c.turns.at(-1).id&&i.type==='reasoning');
 // The summary written before its step and the one written after the answer are both kept.
 await waitFor(()=>thoughts().length===2&&thoughts().every(i=>i.summary));
 const [before,answer]=thoughts();
 assert.equal(before.summary,'Vou ler as notas 1.');assert.equal(answer.summary,'A contagem bate certo 1.');
 assert.ok(thoughts().every(i=>i.summarySource==='antigravity-transcript'&&i.status==='completed'));
 // Thinking before a tool has agy's own time; before the answer, writing is in that time, so none is shown.
 assert.equal(before.durationMs,2500);assert.equal(before.thinkingTokens,40);assert.equal(answer.durationMs,undefined);assert.equal(answer.completedAt,undefined);
 assert.equal(c.items.find(i=>i.tool==='read_file').durationMs,250);
 assert.equal(client.snapshot().conversations[0].progress.thought,'A contagem bate certo 1.');
 assert.ok(!c.messages.some(m=>m.text.includes('A contagem bate certo')));
 // Same process, next request: only its own summaries; the transcript is never changed.
 const transcript=path.join(directory,'brain',c.threadId,'.system_generated','logs','transcript_full.jsonl'),written=await readFile(transcript,'utf8');
 await client.send(c.id,'think','think-2');await waitFor(()=>c.status==='completed');
 await waitFor(()=>thoughts().length===2&&thoughts().every(i=>i.summary));
 assert.deepEqual(thoughts().map(i=>i.summary),['Vou ler as notas 2.','A contagem bate certo 2.']);
 assert.equal(before.summary,'Vou ler as notas 1.');
 assert.ok((await readFile(transcript,'utf8')).startsWith(written));
});

test('depois de interromper, o turno seguinte começa noutro processo e não morre com o antigo',async t=>{
 // The real agy cancels the turn on SIGINT and keeps its warm process. The forced stop armed for it must not reach the next turn.
 const previous=process.env.FAKE_AGY_STOP;process.env.FAKE_AGY_STOP='warm';t.after(()=>{if(previous===undefined)delete process.env.FAKE_AGY_STOP;else process.env.FAKE_AGY_STOP=previous;});
 const {client,directory}=await setup(t);const c=await chat(client,directory);
 await client.send(c.id,'hold','a');await waitFor(()=>c.threadId&&c.status==='running');const first=client.session.child.pid;
 await client.interrupt(c.id);await waitFor(()=>c.status==='interrupted');
 await client.send(c.id,'hold','b');await waitFor(()=>c.status==='running');
 assert.notEqual(client.session.child.pid,first,'o turno novo tem o seu processo');
 await new Promise(resolve=>setTimeout(resolve,3600));
 assert.equal(c.status,'running','o turno novo continua depois do prazo do processo antigo');assert.equal(c.turns.at(-1).status,'running');
 await client.interrupt(c.id);await waitFor(()=>c.status==='interrupted');
});
