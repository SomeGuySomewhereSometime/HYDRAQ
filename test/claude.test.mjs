import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ClaudeCode, parseClaudeModels, claudeTurnUsage } from '../lib/claude.mjs';
import { Providers } from '../lib/providers.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const waitFor=async predicate=>{const deadline=Date.now()+4000;while(!predicate()){if(Date.now()>deadline)throw new Error('Tempo excedido.');await new Promise(r=>setTimeout(r,10));}};
async function setup(t,env={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'hydraq-claude-test-'));
  const options={dataDir:path.join(directory,'state'),defaultCwd:directory,executable:process.execPath,prefixArgs:[path.join(root,'test/fixtures/fake-claude.mjs')],env:{...process.env,ANTHROPIC_API_KEY:'must-be-removed',...env}};
  const client=new ClaudeCode(options);
  await client.load();
  const cleanup=[client];
  t.after(async()=>{for(const instance of cleanup)await instance.close();await rm(directory,{recursive:true,force:true});});
  return {client,directory,options,cleanup};
}

test('catálogo do initialize ignora o alias default, ordena esforços e mapeia a cache por pedido',()=> {
  const models=parseClaudeModels([{value:'default',resolvedModel:'claude-opus-5-5'},{value:'opus',resolvedModel:'claude-opus-5-5',displayName:'Opus',supportsEffort:true,supportedEffortLevels:['max','low','high']},{value:'haiku',resolvedModel:'claude-haiku-5-5',supportsEffort:false}]);
  assert.deepEqual(models.map(m=>m.id),['opus','haiku']);
  assert.deepEqual(models[0].efforts,['low','high','max']);
  assert.equal(models[0].isDefault,true);
  assert.deepEqual(models[1].efforts,['medium']);
  assert.throws(()=>parseClaudeModels(undefined),/catálogo/);
  const usage=claudeTurnUsage({input_tokens:10,cache_creation_input_tokens:100,cache_read_input_tokens:900,output_tokens:20,output_tokens_details:{thinking_tokens:5}});
  assert.deepEqual([usage.inputTokens,usage.cachedInputTokens,usage.uncachedInputTokens,usage.cachePercent,usage.reasoningOutputTokens],[1010,900,110,89,5]);
  assert.equal(claudeTurnUsage({input_tokens:-1}),null);
});

test('recusa contas sem subscrição claude.ai antes de qualquer pedido',async t=> {
  const {client}=await setup(t,{FAKE_CLAUDE_AUTH:'api'});
  await assert.rejects(client.connect(),/subscrição claude\.ai/);
  assert.equal(client.connection,'disconnected');
  assert.deepEqual(client.models,[]);
});

test('sessão nativa: mesmo processo, retoma por ID ao mudar de modelo e após reinício',async t=> {
  const {client,directory,options,cleanup}=await setup(t);
  await client.connect();
  assert.equal(client.account.planType,'Claude Pro');
  const c=await client.create({cwd:directory,model:'haiku',effort:'low'});
  await client.send(c.id,'primeiro','a');await waitFor(()=>c.status==='completed');
  const pid=client.session.child.pid;
  assert.equal(c.sessionStarted,true);
  assert.match(c.messages.at(-1).text,/Resposta 1 .*modelo haiku esforço low modo default/);
  assert.equal(c.messages.filter(m=>m.role==='assistant').length,1);
  assert.equal(c.messages.at(-1).phase,'final_answer');
  assert.equal(c.turns[0].usage.cachedInputTokens,900);
  await client.send(c.id,'segundo','b');await waitFor(()=>c.status==='completed');
  assert.equal(client.session.child.pid,pid);
  assert.match(c.messages.at(-1).text,/Resposta 2/);
  await client.send(c.id,'terceiro','c',{model:'opus',effort:'high'});await waitFor(()=>c.status==='completed');
  assert.notEqual(client.session.child.pid,pid);
  assert.match(c.messages.at(-1).text,/Resposta 3 .*modelo opus esforço high/);
  assert.equal(c.sessionUsage.cachedInputTokens,2700);
  await client.close();
  const restarted=new ClaudeCode(options);cleanup.push(restarted);
  await restarted.load();await restarted.connect();
  const again=restarted.conversation(c.id);
  await restarted.send(again.id,'quarto','d');await waitFor(()=>again.status==='completed');
  assert.match(again.messages.at(-1).text,/Resposta 4/);
  assert.equal(again.threadId,c.threadId);
});

test('autorizações nativas passam pela interface e recusas ficam registadas',async t=> {
  const {client,directory,cleanup}=await setup(t);
  const hub=new Providers({clients:{claude:client}});
  await hub.connect('claude');
  const c=await hub.create({provider:'claude',cwd:directory,model:'haiku',effort:'low'});
  const chat=client.conversation(c.id);
  await hub.send(c.id,'tool-approval','p1');await waitFor(()=>chat.status==='waiting');
  const [approval]=hub.snapshot().approvals;
  assert.equal(approval.id.startsWith('claude:'),true);
  assert.equal(approval.method,'claude/canUseTool');
  assert.equal(approval.params.toolName,'Write');
  assert.equal(approval.session,undefined);
  hub.respond(approval.id,{decision:'accept'});
  await waitFor(()=>chat.status==='completed');
  assert.equal(chat.messages.at(-1).text,'Permitido.');
  assert.equal(chat.items[0].type,'fileChange');
  assert.equal(chat.items[0].status,'completed');
  await hub.send(c.id,'tool-approval','p2');await waitFor(()=>chat.status==='waiting');
  hub.respond(hub.snapshot().approvals[0].id,{decision:'decline'});
  await waitFor(()=>chat.status==='completed');
  assert.equal(chat.messages.at(-1).text,'Recusado.');
  assert.equal(chat.items.at(-1).status,'declined');
  assert.throws(()=>hub.respond('claude:missing',{decision:'accept'}),/resolvido/);
  await assert.rejects(client.steer(),/fila/);
});

test('depois de aprovar um plano, o pedido seguinte volta a Planear; num pedido dual o plano não sai de Planear',async t=> {
  const {client,directory}=await setup(t,{FAKE_CLAUDE_PLAN_LOG:path.join(os.tmpdir(),`hydraq-plan-${process.pid}-${Date.now()}.json`)});
  const planLog=client.env.FAKE_CLAUDE_PLAN_LOG;t.after(()=>rm(planLog,{force:true}));
  const hub=new Providers({clients:{claude:client}});
  await hub.connect('claude');
  const c=await hub.create({provider:'claude',cwd:directory,model:'haiku',effort:'low',sandbox:'plan'});
  const chat=client.conversation(c.id),answer=id=>chat.messages.findLast(m=>m.role==='assistant'&&m.requestId===id)?.text||'';
  const pidOf=id=>/processo (\d+)/.exec(answer(id))?.[1];
  await hub.send(c.id,'olá','p0',{sandbox:'plan'});await waitFor(()=>chat.status==='completed'&&answer('p0'));
  assert.match(answer('p0'),/modo plan/);
  await hub.send(c.id,'plan-approval','p1',{sandbox:'plan'});await waitFor(()=>chat.status==='waiting');
  const [approval]=hub.snapshot().approvals;assert.equal(approval.params.toolName,'ExitPlanMode');
  hub.respond(approval.id,{decision:'accept'});await waitFor(()=>chat.status==='completed');
  // Claude Code left plan mode; HYDRAQ starts a new process so the request labelled Planear really is.
  await hub.send(c.id,'olá','p2',{sandbox:'plan'});await waitFor(()=>chat.status==='completed'&&answer('p2'));
  assert.match(answer('p2'),/modo plan/);assert.notEqual(pidOf('p2'),pidOf('p0'));
  await client.send(c.id,'plan-approval','p3',{model:'haiku',effort:'low',sandbox:'plan',planOnly:true});await waitFor(()=>chat.status==='completed'&&answer('p3'));
  assert.equal(hub.snapshot().approvals.length,0);
  const response=JSON.parse(await readFile(planLog,'utf8'));
  assert.equal(response.behavior,'deny');assert.match(response.message,/continua em Planear/);
  assert.equal(chat.items.findLast(i=>i.tool==='ExitPlanMode'||i.title==='ExitPlanMode'||i.id?.startsWith('plan_'))?.status,'completed');
  await hub.send(c.id,'olá','p4',{sandbox:'plan'});await waitFor(()=>chat.status==='completed'&&answer('p4'));
  assert.match(answer('p4'),/modo plan/);assert.equal(pidOf('p4'),pidOf('p2'));
});

test('interrupção termina o turno sem matar a sessão; queda fica incerta e não reenvia',async t=> {
  const {client,directory}=await setup(t);
  await client.connect();
  const c=await client.create({cwd:directory,model:'haiku',effort:'low',sandbox:'plan'});
  await client.send(c.id,'hold','h');await waitFor(()=>c.status==='running');
  const pid=client.session.child.pid;
  await client.interrupt(c.id);await waitFor(()=>c.status==='interrupted');
  assert.equal(c.error,null);
  await client.send(c.id,'depois','after');await waitFor(()=>c.status==='completed');
  assert.equal(client.session.child.pid,pid);
  assert.match(c.messages.at(-1).text,/modo plan/);
  await client.send(c.id,'disconnect','gone');await waitFor(()=>c.status==='uncertain');
  assert.match(c.error,/não foi reenviado/);
  await assert.rejects(client.send(c.id,'outra','x'),/incerto/);
  const last=await readFile(path.join(directory,`.fake-claude-last-${c.threadId}`),'utf8');
  assert.equal(last,'depois');
});

test('revisor mantém ferramentas de leitura e recusa escrita sem aprovação possível',async t=>{
 const {directory,options,cleanup}=await setup(t);const log=path.join(directory,'args.json'),client=new ClaudeCode({...options,readOnly:true,env:{...options.env,FAKE_CLAUDE_ARGS_LOG:log}});cleanup.push(client);await client.load();await client.connect();
 const c=await client.create({cwd:directory,model:'haiku',effort:'low',sandbox:'plan'});await client.send(c.id,'tool-approval','review');await waitFor(()=>c.status==='completed');
 assert.equal(client.approvals.size,0);assert.equal(c.messages.at(-1).text,'Recusado.');assert.equal(c.items[0].status,'declined');
 const args=JSON.parse(await readFile(log,'utf8'));assert.ok(args.includes('--restricted'));assert.ok(args.includes('--strict-mcp-config'));assert.equal(args[args.indexOf('--tools')+1],'Read,Glob,Grep');assert.equal(args[args.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
});

test('ClaudeX: ferramentas de leitura, aviso de colega sem autoria humana, e escrita recusada',async t=>{
 const {client,directory}=await setup(t);const argv=path.join(directory,'args.json');client.env.FAKE_CLAUDE_ARGS_LOG=argv;await client.connect();
 const c=await client.create({cwd:directory,model:'haiku',effort:'low',sandbox:'plan'});
 await client.send(c.id,'hold','cx1',{internal:'claudex',planOnly:true});
 const args=JSON.parse(await readFile(argv,'utf8'));assert.ok(args.includes('--strict-mcp-config'));assert.equal(args[args.indexOf('--tools')+1],'Read,Glob,Grep,WebSearch,WebFetch,AskUserQuestion');assert.equal(JSON.parse(args[args.indexOf('--settings')+1]).disableAllHooks,true);
 const packets=[],write=client.session.child.stdin.write.bind(client.session.child.stdin);client.session.child.stdin.write=(data,...rest)=>{packets.push(JSON.parse(data));return write(data,...rest);};
 await client.steer(c.id,'Aviso do coordenador','cxnotice',c.turnId,'next',{kind:'peer-notice',taskId:'cx-task'});await waitFor(()=>c.status==='completed');
 const message=c.messages.find(m=>m.requestId==='cxnotice');assert.equal(message.kind,'peer-notice');assert.equal(message.delivery,'accepted');assert.equal(message.internal,'claudex');assert.equal(packets.find(p=>p.priority)?.origin,undefined);
 await client.send(c.id,'tool-approval','cx2',{internal:'claudex',planOnly:true});await waitFor(()=>c.status==='completed');assert.equal(client.approvals.size,0);assert.ok(c.items.some(i=>i.denied));
});
