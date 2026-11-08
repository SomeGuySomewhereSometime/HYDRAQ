import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { CodexClient } from '../lib/codex.mjs';
import { Hydraq } from '../lib/hydraq.mjs';
import { createHttpServer } from '../lib/http.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fake = path.join(root,'test/fixtures/fake-codex.mjs');
const waitFor = async predicate => {
  const until = Date.now()+4000;
  while (!predicate()) {
    if (Date.now()>until) throw new Error('O estado esperado não chegou.');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
};
async function setup(t, auth = 'chatgpt') {
  const directory = await mkdtemp(path.join(os.tmpdir(),'hydraq-test-'));
  const client = new CodexClient({executable:process.execPath,args:[fake],env:{...process.env,FAKE_AUTH:auth}});
  const metadataFile = path.join(directory,'model-capabilities.json');
  await writeFile(metadataFile,JSON.stringify({client_version:'0.159.0',fetched_at:new Date().toISOString(),models:[{slug:'gpt-test',supports_reasoning_effort_updates:true},{slug:'gpt-other',supports_reasoning_effort_updates:false}]}));
  const hydraq = new Hydraq({dataDir:directory,defaultCwd:directory,client,modelMetadataPath:metadataFile});
  await hydraq.load();
  t.after(async()=> {await hydraq.close();await new Promise(resolve=>setTimeout(resolve,30));await rm(directory,{recursive:true,force:true});});
  return {directory,client,hydraq};
}
async function conversation(hydraq,directory) {
  return hydraq.create({cwd:directory,model:'gpt-test',effort:'low',sandbox:'workspace-write'});
}

test('autenticação ChatGPT, streaming, conclusão e histórico persistido', async t=> {
  const {hydraq,directory} = await setup(t);
  await hydraq.connect();
  assert.equal(hydraq.account.type,'chatgpt');
  const chat = await conversation(hydraq,directory);
  await hydraq.send(chat.id,'hello','request-1');
  await waitFor(()=>chat.status === 'completed');
  assert.equal(chat.messages.at(-1).text,'Resultado confirmado');
  assert.equal(chat.messages.filter(message=>message.role === 'assistant').length,1);
  assert.equal(chat.turnId,null);
  await hydraq.persist();
  const persisted = JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));
  assert.equal(persisted.conversations[0].threadId,chat.threadId);
  assert.equal(persisted.conversations[0].messages.at(-1).text,'Resultado confirmado');
  const duplicate = await hydraq.send(chat.id,'hello','request-1');
  assert.equal(duplicate.duplicate,true);
  assert.equal(chat.messages.filter(message=>message.role === 'user').length,1);
});

test('recusa credenciais API antes de qualquer pedido de inferência', async t=> {
  const {hydraq} = await setup(t,'apiKey');
  await assert.rejects(hydraq.connect(),/sessão ChatGPT/);
  assert.equal(hydraq.connection,'disconnected');
  assert.equal(hydraq.account,null);
  assert.deepEqual(hydraq.models,[]);
});

test('Só leitura do Codex pede a política sem escaladas e recusa um pedido de autorização inesperado', async t => {
  const {hydraq,client,directory} = await setup(t);
  await hydraq.connect();
  const chat = await conversation(hydraq,directory);
  await hydraq.send(chat.id,'hello','native-first');
  await waitFor(()=>chat.status === 'completed');
  const thread = chat.threadId, nativeProcess = client.process;
  const policies = [], configs = [];
  const call = client.call.bind(client);
  client.call = (method, params, ...rest) => {
    if (['thread/start','turn/start','thread/resume'].includes(method)) policies.push(params.approvalPolicy);
    if (method === 'thread/resume') configs.push(params.config);
    return call(method, params, ...rest);
  };
  await hydraq.send(chat.id,'approval','read-only',{sandbox:'read-only'});
  await waitFor(()=>chat.status === 'completed');
  assert.deepEqual(policies,['never','never']);
  assert.notEqual(client.process,nativeProcess);
  assert.equal(chat.threadId,thread);
  assert.equal(configs[0].mcp_servers.external.enabled,false);
  assert.equal(hydraq.approvals.size,0);
  assert.equal(chat.messages.at(-1).text,'Escalada recusada');
  policies.length=0;
  await hydraq.send(chat.id,'hello','workspace-write',{sandbox:'workspace-write'});
  await waitFor(()=>chat.status === 'completed');
  assert.deepEqual(policies,['on-request','on-request']);
  assert.equal(configs[1].mcp_servers,undefined);
});

test('uma única tarefa, interrupção e recusa de repetições concorrentes', async t=> {
  const {hydraq,directory} = await setup(t);
  await hydraq.connect();
  const chat = await conversation(hydraq,directory);
  await hydraq.send(chat.id,'hold','request-1');
  assert.equal(chat.status,'running');
  await assert.rejects(hydraq.send(chat.id,'outro pedido','request-2'),/tarefa em curso/);
  await hydraq.interrupt(chat.id);
  await waitFor(()=>chat.status === 'interrupted');
  assert.equal(chat.turnId,null);
});

test('autorização só é enviada depois de uma decisão explícita', async t=> {
  const {hydraq,directory} = await setup(t);
  await hydraq.connect();
  const chat = await conversation(hydraq,directory);
  await hydraq.send(chat.id,'approval','request-1');
  await waitFor(()=>chat.status === 'waiting');
  assert.equal(hydraq.approvals.size,1);
  const id = hydraq.snapshot().approvals[0].id;
  assert.throws(()=>hydraq.respond(id,{decision:'acceptForSession'}),/inválida/);
  hydraq.respond(id,{decision:'decline'});
  await waitFor(()=>chat.status === 'completed');
  assert.equal(chat.messages.at(-1).text,'Decisão: decline');
  assert.equal(hydraq.approvals.size,0);
  assert.throws(()=>hydraq.respond(id,{decision:'accept'}),/resolvido/);
});

test('confirmação MCP vazia e recusa chegam ao cliente original apenas após decisão explícita', async t=> {
  const { hydraq, directory } = await setup(t);
  await hydraq.connect();
  const chat = await conversation(hydraq, directory);
  for (const action of ['accept', 'decline']) {
    await hydraq.send(chat.id, 'elicitation', `mcp-${action}`);
    await waitFor(() => chat.status === 'waiting');
    const request = hydraq.snapshot().approvals[0];
    assert.equal(request.method, 'mcpServer/elicitation/request');
    assert.throws(() => hydraq.respond(request.id, { action: 'invalid' }), /inválida/);
    assert.equal(chat.status, 'waiting');
    hydraq.respond(request.id, { action, content: {} });
    await waitFor(() => chat.status === 'completed');
    assert.deepEqual(JSON.parse(chat.messages.at(-1).text), { action, content: action === 'accept' ? {} : null });
    assert.equal(hydraq.approvals.size, 0);
  }
});

test('sessão nativa ocupada falha antes do envio, explica a recuperação e conserva o mesmo ID', async t=> {
  const { hydraq, directory, client } = await setup(t);
  client.env.FAKE_CODEX_WRITER_CONFLICT = 'true';
  const log = path.join(directory, 'native-prompts.jsonl');
  client.env.FAKE_CODEX_LOG = log;
  await hydraq.connect();
  const chat = await conversation(hydraq, directory);
  await hydraq.send(chat.id, 'primeiro', 'writer-first');
  await waitFor(() => chat.status === 'completed');
  const threadId = chat.threadId, before = await readFile(log, 'utf8');
  hydraq.loaded.delete(chat.id);
  await assert.rejects(hydraq.send(chat.id, 'NAO-ENVIAR', 'writer-conflict'), /não foi enviado ao modelo/);
  assert.equal(chat.status, 'failed');
  assert.equal(chat.threadId, threadId);
  assert.equal(chat.turns.at(-1).delivery, 'preparing');
  assert.ok(chat.turns.at(-1).completedAt);
  assert.equal(chat.messages.at(-1).text, 'NAO-ENVIAR');
  assert.match(chat.error, /noutra instância/);
  assert.equal(await readFile(log, 'utf8'), before);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(await readFile(log, 'utf8'), before);
  const other = await conversation(hydraq, directory);
  await hydraq.send(other.id, 'outra sessão', 'writer-independent');
  await waitFor(() => other.status === 'completed');
});

test('queda de ligação mantém a tarefa incerta sem reenvio', async t=> {
  const {hydraq,directory,client} = await setup(t);
  await hydraq.connect();
  const chat = await conversation(hydraq,directory);
  await hydraq.send(chat.id,'hold','request-1');
  client.stop();
  await waitFor(()=>hydraq.connection === 'disconnected');
  assert.equal(chat.status,'uncertain');
  await hydraq.connect();
  await assert.rejects(hydraq.send(chat.id,'repetir','request-2'),/incerto/);
  assert.equal(chat.messages.length,1);
});

test('reabertura retoma a sessão original e conserva o contexto', async t=> {
  const {hydraq,directory} = await setup(t);
  await hydraq.connect();
  const chat = await conversation(hydraq,directory);
  await hydraq.send(chat.id,'hello','request-1');
  await waitFor(()=>chat.status === 'completed');
  const threadId = chat.threadId;
  await hydraq.persist();
  const otherClient = new CodexClient({executable:process.execPath,args:[fake]});
  const reopened = new Hydraq({dataDir:directory,defaultCwd:directory,client:otherClient});
  await reopened.load();
  try {
    await reopened.connect();
    const reopenedChat = reopened.conversation(chat.id);
    await reopened.send(chat.id,'continuar','request-2');
    await waitFor(()=>reopenedChat.status === 'completed');
    assert.equal(reopenedChat.threadId,threadId);
    assert.equal(reopenedChat.messages.filter(message=>message.role === 'user').length,2);
  } finally { await reopened.close(); }
});

test('HTTP protege mutações contra origens externas, tokens ausentes e DNS rebinding', async t=> {
  const {hydraq} = await setup(t);
  const server = createHttpServer({hydraq,publicDir:path.join(root,'public')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeStreams();server.close();});
  const url = `http://127.0.0.1:${server.address().port}`;
  // A plain read of the address (as a model's URL fetcher does) gets neither the key nor the state.
  const plain = await fetch(url+'/api/bootstrap');
  assert.equal(plain.status,403);assert.doesNotMatch(await plain.text(),/token|conversations/);
  const initial = await (await fetch(url+'/api/bootstrap',{headers:{'X-HYDRAQ-Bootstrap':'1'}})).json();
  assert.match(initial.token,/^[a-f0-9]{64}$/);
  assert.equal((await fetch(url+'/api/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(url+'/api/connect',{method:'POST',headers:{'Content-Type':'application/json','x-hydraq-token':initial.token,Origin:'https://example.com'},body:'{}'})).status,403);
  assert.equal((await fetch(url+'/api/state',{headers:{'x-hydraq-token':initial.token}})).status,200);
  const reboundStatus = await new Promise((resolve,reject)=> {
    httpRequest(url+'/api/bootstrap',{headers:{Host:'untrusted.example'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject).end();
  });
  assert.equal(reboundStatus,403);
  assert.equal((await fetch(url+'/lib/codex.mjs')).status,404);
  const formModule = await fetch(url+'/elicitation.js');
  assert.equal(formModule.status,200);
  assert.match(formModule.headers.get('content-type'),/javascript/);
  const html = await fetch(url+'/');
  assert.equal(html.status,200);
  assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});

test('HTTP encaminha steer para o turno indicado e recusa mudanças de configuração', async t=> {
  const {hydraq,directory} = await setup(t);
  await hydraq.connect();
  const chat = await hydraq.create({cwd:directory,model:'gpt-test',effort:'low'});
  await hydraq.send(chat.id,'hold','http-hold');
  const turnId = chat.turnId;
  const server = createHttpServer({hydraq,publicDir:path.join(root,'public')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeStreams();server.close();});
  const url = `http://127.0.0.1:${server.address().port}`;
  const {token} = await (await fetch(url+'/api/bootstrap',{headers:{'X-HYDRAQ-Bootstrap':'1'}})).json();
  const steer = body=>fetch(`${url}/api/conversations/${chat.id}/steer`,{method:'POST',headers:{'Content-Type':'application/json','x-hydraq-token':token},body:JSON.stringify(body)});
  for (const key of ['model','effort','cwd','sandbox']) {
    const response = await steer({text:'finish',requestId:`override-${key}`,expectedTurnId:turnId,[key]:'different'});
    assert.equal(response.status,400);
    assert.match((await response.json()).error,/não pode mudar/);
  }
  assert.equal(chat.messages.filter(message=>message.kind==='steer').length,0);
  assert.equal((await fetch(url+'/composer.js')).status,200);
  const response = await steer({text:'finish',requestId:'http-steer',expectedTurnId:turnId});
  assert.equal(response.status,200);
  assert.equal((await response.json()).accepted,true);
  await waitFor(()=>chat.status==='completed');
  assert.equal(chat.turns.length,1);
  assert.equal(chat.turns[0].id,turnId);
});

test('muda raciocínio e modelo na mesma sessão e regista as escolhas por pedido', async t=> {
  const {hydraq,directory} = await setup(t);
  await hydraq.connect();
  const chat = await conversation(hydraq,directory);
  await hydraq.send(chat.id,'settings','settings-1');
  await waitFor(()=>chat.status === 'completed');
  const threadId = chat.threadId;
  assert.equal(chat.messages.at(-1).text,'gpt-test/low');
  await hydraq.send(chat.id,'settings','settings-2',{model:'gpt-test',effort:'high'});
  await waitFor(()=>chat.status === 'completed');
  assert.equal(chat.threadId,threadId);
  assert.equal(chat.messages.at(-1).text,'gpt-test/high');
  await hydraq.send(chat.id,'settings','settings-3',{model:'gpt-other',effort:'medium'});
  await waitFor(()=>chat.status === 'completed');
  assert.equal(chat.threadId,threadId);
  assert.equal(chat.messages.at(-1).text,'gpt-other/medium');
  assert.deepEqual(chat.turns.map(turn=>[turn.model,turn.effort]),[['gpt-test','low'],['gpt-test','high'],['gpt-other','medium']]);
  assert.equal(chat.turns[2].previousModel,'gpt-test');
  assert.equal(chat.turns[2].previousEffort,'high');
  assert.equal(chat.messages.filter(message=>message.role==='assistant')[0].model,'gpt-test');
  assert.equal(chat.messages.filter(message=>message.role==='assistant')[0].effort,'low');
  await hydraq.persist();
  const saved=JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));
  assert.equal(saved.conversations[0].turns[2].model,'gpt-other');
});

test('rejeita níveis incompatíveis sem alterar configurações ou acrescentar pedidos', async t=> {
  const {hydraq,directory} = await setup(t);
  await hydraq.connect();
  const chat = await conversation(hydraq,directory);
  await assert.rejects(hydraq.send(chat.id,'hello','invalid-1',{model:'gpt-other',effort:'low'}),/não suportado/);
  await assert.rejects(hydraq.send(chat.id,'hello','invalid-2',{model:'missing'}),/catálogo/);
  assert.equal(chat.model,'gpt-test');
  assert.equal(chat.messages.length,0);
  assert.equal(chat.turns.length,0);
  await hydraq.send(chat.id,'settings','valid',{model:'gpt-other'});
  await waitFor(()=>chat.status === 'completed');
  assert.equal(chat.effort,'medium');
});

test('não muda modelo ou raciocínio durante uma tarefa ativa', async t=> {
  const {hydraq,directory} = await setup(t);
  await hydraq.connect();
  const chat = await conversation(hydraq,directory);
  await hydraq.send(chat.id,'hold','hold');
  await assert.rejects(hydraq.send(chat.id,'settings','change',{model:'gpt-other',effort:'high'}),/tarefa em curso/);
  assert.equal(chat.model,'gpt-test');
  assert.equal(chat.effort,'low');
  await hydraq.interrupt(chat.id);
});

test('distingue suporte verdadeiro, falso e desconhecido a partir dos metadados nativos', async t=> {
  const {hydraq} = await setup(t);
  await hydraq.connect();
  assert.equal(hydraq.reasoningUpdates.enabled,true);
  assert.equal(hydraq.reasoningUpdates.catalogVerified,true);
  assert.equal(hydraq.models.find(model=>model.id==='gpt-test').supportsReasoningEffortUpdates,true);
  assert.equal(hydraq.models.find(model=>model.id==='gpt-other').supportsReasoningEffortUpdates,false);
  assert.equal(hydraq.models.find(model=>model.id==='gpt-unknown').supportsReasoningEffortUpdates,null);
});

test('contadores por pedido somam chamadas internas sem confundir o último passo com o pedido todo', async t=> {
  const {hydraq,directory} = await setup(t);
  await hydraq.connect();
  const chat = await conversation(hydraq,directory);
  await hydraq.send(chat.id,'hello','usage-1');
  await waitFor(()=>chat.status === 'completed');
  assert.equal(chat.turns[0].usage.inputTokens,3000);
  assert.equal(chat.turns[0].usage.cachedInputTokens,2200);
  assert.equal(chat.turns[0].usage.uncachedInputTokens,800);
  assert.equal(chat.tokenUsage.last.inputTokens,2000);
  await hydraq.send(chat.id,'hello','usage-2');
  await waitFor(()=>chat.status === 'completed');
  assert.equal(chat.turns[1].usage.inputTokens,3000);
  assert.equal(chat.turns[1].usage.cachedInputTokens,2200);
  assert.equal(chat.turns[1].usage.outputTokens,30);
  assert.equal(chat.tokenUsage.total.inputTokens,6000);
});

test('progresso recebe plano, comentário e ações; steer conclui o mesmo turno', async t=> {
  const {hydraq,directory} = await setup(t);
  await hydraq.connect();
  const chat = await conversation(hydraq,directory);
  await hydraq.send(chat.id,'progress','progress-1');
  await waitFor(()=>hydraq.snapshot().conversations[0].progress?.completedSteps===1);
  const progress=hydraq.snapshot().conversations[0].progress;
  assert.equal(progress.title,'A alterar exemplo.mjs');
  assert.equal(progress.counts.completed,1);
  assert.equal(progress.counts.running,1);
  assert.equal(progress.steps.length,3);
  assert.equal(progress.commentary,'Vou ler o projeto e corrigir o ficheiro.');
  assert.equal(chat.items.find(item=>item.id==='command-progress').aggregatedOutput,'Conteúdo lido');
  const threadId=chat.threadId;
  const turnId=chat.turnId;
  const result=await hydraq.steer(chat.id,'finish','steer-1',turnId);
  await waitFor(()=>chat.status==='completed');
  assert.equal(result.turnId,turnId);
  assert.equal(result.accepted,true);
  assert.equal(chat.threadId,threadId);
  assert.equal(chat.turns.length,1);
  assert.equal(chat.turns[0].id,turnId);
  assert.equal(chat.messages.find(message=>message.kind==='steer').delivery,'accepted');
  assert.equal(hydraq.snapshot().conversations[0].progress.completedSteps,3);
  assert.equal(hydraq.snapshot().conversations[0].progress.counts.completed,2);
});

test('steer exige um turno ativo e não cria outro ao receber um identificador antigo', async t=> {
  const {hydraq,directory} = await setup(t);
  await hydraq.connect();
  const chat = await conversation(hydraq,directory);
  await assert.rejects(hydraq.steer(chat.id,'orientar','s1','old-turn'),/já não está ativo/);
  assert.equal(chat.messages.length,0);
  await hydraq.send(chat.id,'hold','hold');
  await assert.rejects(hydraq.steer(chat.id,'orientar','s2','old-turn'),/já não está ativo/);
  assert.equal(chat.turns.length,1);
  await hydraq.interrupt(chat.id);
});

test('orientações duplicadas ou concorrentes não são reenviadas', async t=> {
  const {hydraq,directory,client} = await setup(t);
  await hydraq.connect();
  const chat = await conversation(hydraq,directory);
  await hydraq.send(chat.id,'hold','hold');
  const turnId=chat.turnId;
  let steerCalls=0;
  const call=client.call.bind(client);
  client.call=(method,...args)=>{if(method==='turn/steer')steerCalls++;return call(method,...args);};
  const first=hydraq.steer(chat.id,'delayed','same-id',turnId);
  await waitFor(()=>steerCalls===1);
  const pendingDuplicate=await hydraq.steer(chat.id,'delayed','same-id',turnId);
  assert.equal(pendingDuplicate.delivery,'sending');
  assert.equal(pendingDuplicate.accepted,false);
  await assert.rejects(hydraq.steer(chat.id,'outra','other-id',turnId),/aguardar confirmação/);
  await first;
  const duplicate=await hydraq.steer(chat.id,'delayed','same-id',turnId);
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.accepted,true);
  assert.equal(steerCalls,1);
  assert.equal(chat.messages.filter(message=>message.kind==='steer').length,1);
  await assert.rejects(hydraq.steer(chat.id,'alterada','same-id',turnId),/outro pedido/);
  await hydraq.interrupt(chat.id);
});

test('uma corrida com o fim da tarefa mantém a orientação recusada e não inicia nova execução', async t=> {
  const {hydraq,directory} = await setup(t);
  await hydraq.connect();
  const chat = await conversation(hydraq,directory);
  await hydraq.send(chat.id,'hold','hold');
  await assert.rejects(hydraq.steer(chat.id,'race','race',chat.turnId),/No active turn/);
  assert.equal(chat.status,'completed');
  assert.equal(chat.turns.length,1);
  assert.equal(chat.messages.find(message=>message.kind==='steer').delivery,'rejected');
});

test('falta de confirmação do steer fica explícita e nunca provoca repetição automática', async t=> {
  const {hydraq,directory,client} = await setup(t);
  await hydraq.connect();
  const chat = await conversation(hydraq,directory);
  await hydraq.send(chat.id,'hold','hold');
  const turnId=chat.turnId;
  const call=client.call.bind(client);
  let count=0;
  client.call=(method,params,timeout)=>{if(method==='turn/steer'){count++;return call(method,params,30);}return call(method,params,timeout);};
  await assert.rejects(hydraq.steer(chat.id,'uncertain','uncertain',turnId),/Sem confirmação/);
  const duplicate=await hydraq.steer(chat.id,'uncertain','uncertain',turnId);
  assert.equal(duplicate.delivery,'uncertain');
  assert.equal(duplicate.accepted,false);
  assert.equal(chat.status,'running');
  assert.equal(count,1);
  await hydraq.interrupt(chat.id);
});

test('reinício não transforma uma orientação sem confirmação em recebida', async t=> {
  const {hydraq,directory} = await setup(t);
  const chat={id:'saved',threadId:'thread-old',status:'completed',turns:[],messages:[{id:'pending',role:'user',kind:'steer',delivery:'sending',text:'orientar',requestId:'pending'}],items:[]};
  hydraq.conversations.push(chat);
  await hydraq.persist();
  const other=new Hydraq({dataDir:directory,defaultCwd:directory});
  try {
    await other.load();
    assert.equal(other.conversation('saved').messages[0].delivery,'uncertain');
    assert.match(other.conversation('saved').messages[0].error,/não foi reenviada/);
  } finally {await other.close();}
});
