import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CodexClient } from '../lib/codex.mjs';
import { Hydraq } from '../lib/hydraq.mjs';
import { Antigravity } from '../lib/antigravity.mjs';
import { ClaudeCode } from '../lib/claude.mjs';
import { Providers } from '../lib/providers.mjs';
import { buildHandoff, mapSandbox, unseenTurns, saferSandbox, finalAnswer } from '../lib/handoff.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const waitFor=async predicate=>{const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw new Error('Tempo excedido.');await new Promise(r=>setTimeout(r,10));}};
async function setup(t,env={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'hydraq-handoff-test-'));
  const codexLog=path.join(directory,'codex-prompts.log');
  const metadataFile=path.join(directory,'models.json');
  await writeFile(metadataFile,JSON.stringify({client_version:'0.159.0',fetched_at:new Date().toISOString(),models:[]}));
  const clientEnv={...process.env,FAKE_CODEX_LOG:codexLog,FAKE_CODEX_SETTINGS_LOG:path.join(directory,'codex-settings.log'),...env};
  const codex=new Hydraq({dataDir:path.join(directory,'state'),defaultCwd:directory,modelMetadataPath:metadataFile,client:new CodexClient({executable:process.execPath,args:[path.join(root,'test/fixtures/fake-codex.mjs')],env:clientEnv})});
  const antigravity=new Antigravity({dataDir:path.join(directory,'state/antigravity'),defaultCwd:directory,settingsFile:path.join(directory,'agy.json'),executable:process.execPath,prefixArgs:[path.join(root,'test/fixtures/fake-agy.mjs')],env:clientEnv});
  const claude=new ClaudeCode({dataDir:path.join(directory,'state/claude'),defaultCwd:directory,executable:process.execPath,prefixArgs:[path.join(root,'test/fixtures/fake-claude.mjs')],env:clientEnv});
  const hub=new Providers({clients:{codex,antigravity,claude},git:async()=>[' M app.js','?? novo.txt'],inspect:async()=>({files:{},warnings:[],complete:true})});
  await hub.load();await Promise.all(['codex','antigravity','claude'].map(id=>hub.connect(id)));
  t.after(async()=>{await hub.close();await new Promise(r=>setTimeout(r,30));await rm(directory,{recursive:true,force:true});});
  const codexPrompts=async()=>(await readFile(codexLog,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const lastClaude=c=>readFile(path.join(directory,`.fake-claude-last-${c.threadId}`),'utf8');
  const lastAgy=c=>readFile(path.join(directory,`.fake-agy-last-${c.threadId}`),'utf8');
  return {directory,hub,codex,antigravity,claude,codexPrompts,lastClaude,lastAgy};
}
const idle=hub=>()=>!hub.handoff&&!hub.snapshot().conversations.some(c=>['starting','running','waiting'].includes(c.status));

test('Codex → Claude → Codex: resumo do modelo, factos observados e só o que falta a cada sessão',async t=> {
  const {directory,hub,codex,claude,codexPrompts,lastClaude}=await setup(t);
  const start=await hub.create({provider:'codex',cwd:directory,model:'gpt-test',effort:'low',sandbox:'read-only'});
  const source=codex.conversation(start.id);
  await hub.send(source.id,'hello','r1');await waitFor(idle(hub));
  const switched=await hub.send(source.id,'continua no claude','r2',{provider:'claude',model:'haiku',effort:'low',handoffMode:'model'});
  assert.notEqual(switched.conversationId,source.id);
  await waitFor(idle(hub));
  const target=claude.conversation(switched.conversationId);
  assert.equal(target.group,source.group);
  assert.equal(target.sandbox,'plan');
  assert.equal(target.handoffState,null);
  const summaryTurn=source.turns.find(turn=>turn.internal==='handoff-summary');
  assert.equal(summaryTurn.status,'completed');
  assert.ok(source.messages.filter(m=>m.requestId===summaryTurn.requestId).every(m=>m.internal==='handoff-summary'));
  assert.deepEqual(source.handoffSummaries[0].keys,[`${source.id}:r1`]);
  assert.equal(source.title,'hello');
  const prompt=await lastClaude(target);
  assert.match(prompt,/<hydraq_handoff>/);
  assert.match(prompt,/Resumo do Codex · gpt-test .*declarado pelo modelo/);
  assert.match(prompt,/Pedido do utilizador: hello/);
  assert.doesNotMatch(prompt,/pedido interno de passagem/);
  assert.match(prompt,/ M app\.js\n\?\? novo\.txt/);
  assert.match(prompt,/Novo pedido do utilizador:\ncontinua no claude$/);
  const shown=target.messages.find(m=>m.requestId==='r2');
  assert.equal(shown.text,'continua no claude');
  assert.match(shown.handoffContext,/<hydraq_handoff>/);
  assert.match(target.messages.at(-1).text,/contexto sim/);
  assert.equal(target.title,'continua no claude');

  await hub.send(target.id,'mais','r3');await waitFor(idle(hub));
  assert.equal(await lastClaude(target),'mais');

  const back=await hub.send(target.id,'volta','r4',{provider:'codex',model:'gpt-test',effort:'low',handoffMode:'model'});
  assert.equal(back.conversationId,source.id);
  await waitFor(idle(hub));
  assert.equal(target.handoffSummaries[0].text,'RESUMO-CLAUDE 3');
  assert.deepEqual(target.handoffSummaries[0].keys,[`${target.id}:r2`,`${target.id}:r3`]);
  const toCodex=(await codexPrompts()).at(-1);
  assert.match(toCodex,/Resumo do Claude Code · haiku/);
  assert.match(toCodex,/Pedido do utilizador: continua no claude/);
  assert.match(toCodex,/Pedido do utilizador: mais/);
  assert.doesNotMatch(toCodex,/Pedido do utilizador: hello/);
  assert.doesNotMatch(toCodex,/Resumo do Codex/);
  await hub.send(source.id,'final','r5');await waitFor(idle(hub));
  assert.equal((await codexPrompts()).at(-1),'final');
  await waitFor(()=>source.turns.find(turn=>turn.requestId==='r4').facts);
  assert.equal(source.turns.find(turn=>turn.requestId==='r4').facts.files.length,0);
  const duplicate=await hub.send(source.id,'volta','r4',{provider:'codex',handoffMode:'model'});
  assert.equal(duplicate.duplicate,true);
});

test('passagem rápida sem pedido extra, acesso nunca alargado e entrega só confirmada com o turno concluído',async t=> {
  const {directory,hub,antigravity,claude,lastClaude,lastAgy}=await setup(t);
  const start=await hub.create({provider:'claude',cwd:directory,model:'haiku',effort:'low',sandbox:'plan'});
  const source=claude.conversation(start.id);
  await hub.send(source.id,'bash','c1');await waitFor(idle(hub));
  await waitFor(()=>source.turns[0].facts);
  assert.deepEqual(source.turns[0].facts.commands,[{command:'npm test',exitCode:null,status:'completed'}]);
  const switched=await hub.send(source.id,'native-error','c2',{provider:'antigravity',model:'gemini-4-argon',effort:'low',handoffMode:'quick'});
  await waitFor(idle(hub));
  assert.equal(source.turns.length,1);
  const target=antigravity.conversation(switched.conversationId);
  assert.equal(target.sandbox,'plan');
  assert.equal(target.status,'failed');
  assert.match(await lastAgy(target),/Comandos \(observados\): `npm test` completed/);
  assert.equal(unseenTurns(target,[source,target]).length,1);
  await hub.send(target.id,'de novo','c3');await waitFor(idle(hub));
  assert.match(await lastAgy(target),/<hydraq_handoff>[\s\S]*Novo pedido do utilizador:\nde novo$/);
  await hub.send(target.id,'agora sem contexto','c4');await waitFor(idle(hub));
  assert.equal(await lastAgy(target),'agora sem contexto');
  await hub.send(target.id,'claude outra vez','c5',{provider:'claude',handoffMode:'quick'});await waitFor(idle(hub));
  const prompt=await lastClaude(source);
  assert.match(prompt,/Antigravity · gemini-4-argon/);
  assert.match(prompt,/Pedido do utilizador: native-error[\s\S]*Erro: Quota nativa esgotada/);
  assert.doesNotMatch(prompt,/Pedido do utilizador: bash/);
  assert.equal(mapSandbox('workspace-write','codex'),'workspace-write');
  assert.equal(mapSandbox('accept-edits','codex'),'workspace-write');
  assert.equal(mapSandbox('read-only','claude'),'plan');
});

test('resumo falhado não envia nada ao destino; novo envio leva os factos e limpa o aviso',async t=> {
  const {directory,hub,antigravity,claude,lastAgy}=await setup(t,{FAKE_CLAUDE_SUMMARY:'fail'});
  const start=await hub.create({provider:'claude',cwd:directory,model:'haiku',effort:'low'});
  const source=claude.conversation(start.id);
  await hub.send(source.id,'primeiro','f1');await waitFor(idle(hub));
  const switched=await hub.send(source.id,'continua','f2',{provider:'antigravity',model:'gemini-4-argon',effort:'low',handoffMode:'model'});
  await waitFor(idle(hub));
  const target=antigravity.conversation(switched.conversationId);
  assert.equal(target.handoffState.status,'failed');
  assert.match(target.handoffState.error,/não foi concluído \(failed\)/);
  assert.equal(target.messages.length,0);
  assert.equal(existsSync(path.join(directory,`.fake-agy-last-${target.threadId}`)),false);
  assert.equal(source.handoffSummaries,undefined);
  await assert.rejects(hub.send(source.id,'x','f3',{provider:'nenhum'}),/Cliente desconhecido/);
  await hub.send(target.id,'continua','f2');await waitFor(idle(hub));
  assert.equal(target.handoffState,null);
  assert.match(await lastAgy(target),/Pedido do utilizador: primeiro/);
});

test('contexto respeita o limite: pedidos do utilizador ficam, respostas longas são cortadas primeiro',()=> {
  const turn=(requestId,status='completed')=>({requestId,id:requestId,status,model:'m',effort:'low',startedAt:requestId});
  const long='x'.repeat(30_000);
  const source={id:'s',provider:'codex',cwd:'/p',turns:[turn('a'),turn('b')],items:[],messages:[
    {role:'user',requestId:'a',text:'restrição: não mexer em auth.js'},{role:'assistant',requestId:'a',text:long,phase:'final_answer'},
    {role:'user',requestId:'b',text:'segundo pedido'},{role:'assistant',requestId:'b',text:long,phase:'final_answer'}]};
  const target={id:'t',provider:'claude',cwd:'/p',turns:[],messages:[],items:[]};
  const context=buildHandoff({target,members:[source,target],git:null,budget:12_000});
  assert.ok(context.text.length<=12_000);
  assert.match(context.text,/restrição: não mexer em auth\.js/);
  assert.match(context.text,/segundo pedido/);
  assert.match(context.text,/cortado/);
  assert.match(context.text,/Estado git: indisponível/);
  assert.deepEqual(context.keys,['s:a','s:b']);
  assert.equal(buildHandoff({target:source,members:[source],git:[]}),null);
});

test('contexto essencial demasiado grande bloqueia sem cortar pedidos nem marcar entregas',()=> {
  const source={id:'s',provider:'codex',cwd:'/p',turns:[],items:[],messages:[]};
  for(let i=0;i<20;i++){
    const requestId=`r${i}`;
    source.turns.push({id:requestId,requestId,status:'completed',startedAt:String(i).padStart(2,'0')});
    source.messages.push({role:'user',requestId,text:`PEDIDO_${i} ${'x'.repeat(3900)}`});
  }
  const target={id:'t',cwd:'/p',turns:[],items:[],messages:[]};
  assert.throws(()=>buildHandoff({target,members:[source,target],git:[]}),/contexto essencial excede/);
  assert.equal(unseenTurns(target,[source,target]).length,20);
  source.messages[0].text='x'.repeat(4500)+' RESTRICAO_NO_FIM';
  const context=buildHandoff({target,members:[{...source,turns:source.turns.slice(0,1)}],git:[]});
  assert.match(context.text,/RESTRICAO_NO_FIM/);
});

test('passagem inclui orientações aceites, recusadas e incertas com a identificação correta',async t=> {
  const {directory,hub,codex,claude,lastClaude}=await setup(t);
  const c=await hub.create({provider:'codex',cwd:directory,model:'gpt-test',effort:'low'});
  const source=codex.conversation(c.id);
  await hub.send(c.id,'hold','s1');
  await hub.steer(c.id,'NAO_EDITAR_AUTH','s2',source.turnId);
  source.messages.push({role:'user',kind:'steer',turnId:source.turnId,requestId:'s3',delivery:'rejected',text:'ORIENTACAO_RECUSADA'});
  source.messages.push({role:'user',kind:'steer',turnId:source.turnId,requestId:'s4',delivery:'uncertain',text:'ORIENTACAO_INCERTA'});
  await hub.steer(c.id,'finish','s5',source.turnId);await waitFor(idle(hub));
  const moved=await hub.send(c.id,'continua','s6',{provider:'claude',model:'haiku',effort:'low',handoffMode:'quick'});await waitFor(idle(hub));
  const text=await lastClaude(claude.conversation(moved.conversationId));
  assert.match(text,/Orientação do utilizador \(recebida no turno\): NAO_EDITAR_AUTH/);
  assert.match(text,/Orientação do utilizador \(não entregue\): ORIENTACAO_RECUSADA/);
  assert.match(text,/Orientação do utilizador \(entrega incerta\): ORIENTACAO_INCERTA/);
});

test('retoma os três clientes com acesso mais restrito e mantém os IDs nativos',async t=> {
  const {directory,hub,codex,claude,antigravity,lastClaude,lastAgy}=await setup(t);
  const c=await hub.create({provider:'codex',cwd:directory,model:'gpt-test',effort:'low'});
  const source=codex.conversation(c.id);
  await hub.send(c.id,'primeiro','a1');await waitFor(idle(hub));const native=source.threadId;
  const moved=await hub.send(c.id,'claude','a2',{provider:'claude',model:'haiku',effort:'low',sandbox:'plan',handoffMode:'quick'});await waitFor(idle(hub));
  const target=claude.conversation(moved.conversationId);
  await hub.send(target.id,'regressa','a3',{provider:'codex',handoffMode:'quick'});await waitFor(idle(hub));
  assert.equal(source.sandbox,'read-only');assert.equal(source.turns.at(-1).sandbox,'read-only');assert.equal(source.threadId,native);
  const policies=(await readFile(path.join(directory,'codex-settings.log'),'utf8')).trim().split('\n').map(line=>JSON.parse(line).sandboxPolicy);
  assert.equal(policies[0].type,'workspaceWrite');assert.deepEqual(policies[0].writableRoots,[directory]);
  assert.deepEqual(policies.at(-1),{type:'readOnly',networkAccess:false});
  const claudeId=target.threadId, claudePid=claude.session.child.pid;
  await hub.send(target.id,'muda acesso','a4',{sandbox:'accept-edits'});await waitFor(idle(hub));
  assert.equal(target.threadId,claudeId);assert.notEqual(claude.session.child.pid,claudePid);assert.match(await lastClaude(target),/muda acesso/);
  assert.match(target.messages.at(-1).text,/modo acceptEdits/);
  const ag=await hub.create({provider:'antigravity',cwd:directory,model:'gemini-4-argon',effort:'low'});
  const agChat=antigravity.conversation(ag.id);
  await hub.send(ag.id,'primeiro','a5');await waitFor(idle(hub));const agId=agChat.threadId, agPid=antigravity.session.child.pid;
  await hub.send(ag.id,'planeia','a6',{sandbox:'plan'});await waitFor(idle(hub));
  assert.equal(agChat.threadId,agId);assert.notEqual(antigravity.session.child.pid,agPid);assert.equal(agChat.permissionMode,'plan');
  assert.equal(await lastAgy(agChat),'planeia');
  await assert.rejects(hub.send(ag.id,'inválido','bad',{sandbox:'read-only'}),/Modo de acesso inválido/);
  assert.equal(agChat.sandbox,'plan');assert.equal(agChat.turns.length,2);
  assert.equal(saferSandbox('plan','workspace-write','codex'),'read-only');
  assert.equal(saferSandbox('accept-edits','plan','claude'),'plan');
});

test('grupo incerto bloqueia até confirmação explícita; a continuação envia o aviso e os resultados parciais',async t=> {
  const {directory,hub,codex,claude,codexPrompts}=await setup(t);
  const c=await hub.create({provider:'codex',cwd:directory,model:'gpt-test',effort:'low'});
  await hub.send(c.id,'primeiro','u1');await waitFor(idle(hub));
  const moved=await hub.send(c.id,'claude','u2',{provider:'claude',model:'haiku',effort:'low',handoffMode:'quick'});await waitFor(idle(hub));
  const target=claude.conversation(moved.conversationId);
  await hub.send(target.id,'hold','u3');await waitFor(()=>target.status==='running');
  await waitFor(()=>target.messages.some(m=>m.requestId==='u3'&&m.role==='assistant'&&m.text));
  process.kill(-claude.session.child.pid,'SIGKILL');await waitFor(()=>target.status==='uncertain');
  await assert.rejects(hub.send(c.id,'continua','u4'),/conversa ligada tem estado incerto/);
  await assert.rejects(hub.send(c.id,'muda','u5',{provider:'claude'}),/estado incerto/);
  assert.equal((await hub.send(c.id,'primeiro','u1')).duplicate,true);
  assert.equal(codex.conversation(c.id).turns.length,1);
  await assert.rejects(hub.acknowledgeUncertainty(target.id,{expectedRequestId:'old'}),/estado incerto mudou/);
  await hub.acknowledgeUncertainty(target.id,{expectedRequestId:'u3'});
  assert.equal(target.status,'uncertain');assert.equal(target.turns.at(-1).status,'uncertain');
  assert.equal(JSON.parse(await readFile(path.join(directory,'state/claude/state.json'),'utf8')).conversations[0].uncertaintyReview.key,'u3');
  await assert.rejects(hub.send(target.id,'resumo','u6',{provider:'codex',handoffMode:'model'}),/passagem rápida/);
  await hub.send(target.id,'continua com inspeção','u7',{provider:'codex',handoffMode:'quick'});await waitFor(idle(hub));
  const prompt=(await codexPrompts()).at(-1);
  assert.match(prompt,/RESULTADO POR CONFIRMAR/);assert.match(prompt,/verifica o disco e os resultados antes de agir/);
  assert.match(prompt,/Pedido do utilizador: hold/);assert.match(prompt,/Resposta parcial: A trabalhar/);
  assert.equal(target.status,'uncertain');
  // A subsequent uncertainty needs its own review; the old approval cannot unlock it.
  target.turns.at(-1).requestId='new-uncertainty';
  await assert.rejects(hub.send(c.id,'continua','u8'),/conversa ligada tem estado incerto/);
});

test('Antigravity passa a resposta nativa completa e edições recusadas não aparecem como realizadas',async t=> {
  const {directory,hub,antigravity,claude}=await setup(t);
  const ag=await hub.create({provider:'antigravity',cwd:directory,model:'gemini-4-argon',effort:'low'});
  await hub.send(ag.id,'rich-tools','m1');await waitFor(idle(hub));
  const source=antigravity.conversation(ag.id);
  assert.equal(source.messages.filter(m=>m.role==='assistant').length,2);
  assert.equal(finalAnswer(source,'m1'),'Passo 1.\n\nPasso 2.');
  const c=await hub.create({provider:'claude',cwd:directory,model:'haiku',effort:'low'});
  const target=claude.conversation(c.id);
  await hub.send(c.id,'tool-approval','m2');await waitFor(()=>target.status==='waiting');
  hub.respond(hub.snapshot().approvals[0].id,{decision:'decline'});await waitFor(idle(hub));await waitFor(()=>target.turns[0].facts);
  assert.deepEqual(target.turns[0].facts.files,[]);assert.equal(target.turns[0].facts.declined,1);
  assert.match(buildHandoff({target,members:[source],git:[]}).text,/Resposta final: Passo 1\.\n\nPasso 2\./);
});

test('alterações de conteúdo durante o resumo bloqueiam o destino e não cobrem os pedidos de origem',async t=> {
  const {directory,hub,claude,antigravity}=await setup(t);
  let calls=0;
  hub.inspect=async()=>({files:{'dirty.txt':++calls===1?'hash-a':'hash-b'},complete:true,warnings:[]});
  const c=await hub.create({provider:'claude',cwd:directory,model:'haiku',effort:'low'});
  await hub.send(c.id,'primeiro','g1');await waitFor(idle(hub));
  const moved=await hub.send(c.id,'continua','g2',{provider:'antigravity',model:'gemini-4-argon',effort:'low',handoffMode:'model'});await waitFor(idle(hub));
  const source=claude.conversation(c.id),target=antigravity.conversation(moved.conversationId);
  assert.match(target.handoffState.error,/projeto mudou durante o resumo/);
  assert.equal(target.messages.length,0);assert.equal(source.handoffSummaries,undefined);
  assert.deepEqual(source.handoffSummaryChecks[0].changed,['dirty.txt']);
});

test('Parar durante a inspeção cancela a passagem antes do resumo e do envio',async t=> {
  const {directory,hub,claude,antigravity}=await setup(t);
  let release;hub.inspect=()=>new Promise(resolve=>release=resolve);
  const c=await hub.create({provider:'claude',cwd:directory,model:'haiku',effort:'low'});
  await hub.send(c.id,'primeiro','p1');await waitFor(idle(hub));
  const moved=await hub.send(c.id,'continua','p2',{provider:'antigravity',model:'gemini-4-argon',effort:'low',handoffMode:'model'});
  await hub.interrupt(moved.conversationId);release({files:{},warnings:[],complete:true});await waitFor(idle(hub));
  assert.equal(claude.conversation(c.id).turns.length,1);
  const target=antigravity.conversation(moved.conversationId);
  assert.match(target.handoffState.error,/interrompida pelo utilizador/);assert.equal(target.messages.length,0);
  assert.equal(target.handoffState.settings.sandbox,'workspace-write');
});

test('factos sobrevivem a mais de 200 ações num único pedido nos três clientes',async t=> {
  const {directory,hub,codex,claude,antigravity}=await setup(t);
  for(const [provider,client,model] of [['codex',codex,'gpt-test'],['antigravity',antigravity,'gemini-4-argon'],['claude',claude,'haiku']]){
    const c=await hub.create({provider,cwd:directory,model,effort:'low'});
    const chat=client.conversation(c.id);
    await hub.send(c.id,'many-tools',`many-${provider}`);await waitFor(idle(hub));await waitFor(()=>chat.turns[0].facts);
    assert.equal(chat.items.length,200);
    const facts=chat.turns[0].facts;
    assert.deepEqual(facts.files,['first.txt']);assert.equal(facts.commands[0].command,'command-0');
    assert.equal(facts.commands[0].status,'failed');assert.ok(facts.commands.length>=205);
    if(provider==='codex')assert.equal(facts.commands[0].exitCode,42);
  }
});

test('um pedido interrompido não confirma a entrega do contexto',()=> {
  const source={id:'s',turns:[{id:'s1',requestId:'s1',status:'completed'}]};
  const target={id:'t',turns:[{requestId:'t1',status:'interrupted'}],handoffDeliveries:[{requestId:'t1',keys:['s:s1']}]};
  assert.equal(unseenTurns(target,[source,target]).length,1);
  target.turns[0].status='completed';assert.equal(unseenTurns(target,[source,target]).length,0);
});

test('destino inválido e inspeção incompleta falham antes de gastar um pedido de resumo',async t=> {
  const {directory,hub,claude,antigravity}=await setup(t);
  const c=await hub.create({provider:'claude',cwd:directory,model:'haiku',effort:'low'});
  await hub.send(c.id,'primeiro','v1');await waitFor(idle(hub));
  await assert.rejects(hub.send(c.id,'continua','v2',{provider:'antigravity',model:'desconhecido',effort:'low'}),/catálogo/);
  assert.equal(antigravity.conversations.length,0);
  hub.inspect=async()=>({files:{},warnings:['Limite de leitura atingido.'],complete:false});
  const moved=await hub.send(c.id,'continua','v3',{provider:'antigravity',model:'gemini-4-argon',effort:'low',handoffMode:'model'});await waitFor(idle(hub));
  assert.match(antigravity.conversation(moved.conversationId).handoffState.error,/Não foi possível verificar/);
  assert.equal(claude.conversation(c.id).turns.length,1);
});

test('reinício recupera passagens pendentes como falhadas sem reenviar o pedido',async t=> {
  const {directory,hub,claude}=await setup(t);
  const c=await hub.create({provider:'claude',cwd:directory,model:'haiku',effort:'low'});
  const source=claude.conversation(c.id);
  source.handoffState={status:'summarizing',text:'não reenviar',requestId:'restart',sourceId:'other'};
  await claude.persist();
  const restarted=new ClaudeCode({dataDir:path.join(directory,'state/claude'),defaultCwd:directory,executable:process.execPath,prefixArgs:[path.join(root,'test/fixtures/fake-claude.mjs')]});
  const newHub=new Providers({clients:{claude:restarted}});
  try{
    await newHub.load();const recovered=restarted.conversation(c.id);
    assert.equal(recovered.handoffState.status,'failed');assert.match(recovered.handoffState.error,/reiniciou sem confirmar/);
    assert.equal(recovered.messages.length,0);assert.equal(newHub.handoff,undefined);
    assert.equal(restarted.session,null);
  }finally{await newHub.close();}
});

test('falha ao persistir a preparação não deixa a aplicação presa numa passagem ativa',async t=> {
  const {directory,hub,claude}=await setup(t);
  const c=await hub.create({provider:'claude',cwd:directory,model:'haiku',effort:'low'});
  await hub.send(c.id,'primeiro','d1');await waitFor(idle(hub));
  const persist=claude.persist;claude.persist=async()=>{throw new Error('Disco indisponível');};
  try{await assert.rejects(hub.send(c.id,'continua','d2',{provider:'antigravity',model:'gemini-4-argon',effort:'low'}),/Disco indisponível/);}
  finally{claude.persist=persist;}
  assert.equal(hub.handoff,null);assert.equal(hub.reservations.size,0);
  await hub.send(c.id,'ainda funciona','d3');await waitFor(idle(hub));
  assert.equal(claude.conversation(c.id).turns.at(-1).status,'completed');
});

test('contexto demasiado grande não cria registos de entrega nem pedidos no destinatário',async t=> {
  const {directory,hub,codex,claude}=await setup(t);
  const c=await hub.create({provider:'codex',cwd:directory,model:'gpt-test',effort:'low'});
  await hub.send(c.id,'primeiro','b1');await waitFor(idle(hub));
  codex.conversation(c.id).messages.find(m=>m.requestId==='b1').text='x'.repeat(45_000);
  const moved=await hub.send(c.id,'continua','b2',{provider:'claude',model:'haiku',effort:'low',handoffMode:'quick'});await waitFor(idle(hub));
  const target=claude.conversation(moved.conversationId);
  assert.match(target.handoffState.error,/contexto essencial excede/);
  assert.equal(target.handoffDeliveries,undefined);assert.equal(target.turns.length,0);
});

test('uma conclusão posterior a uma entrega incerta volta a entrar no contexto',()=> {
  const source={id:'s',provider:'claude',cwd:'/p',status:'uncertain',turns:[{id:'r',requestId:'r',status:'uncertain'}],items:[],messages:[{role:'user',requestId:'r',text:'pedido'}],uncertaintyReview:{key:'r',requestIds:['r']}};
  const target={id:'t',cwd:'/p',turns:[],items:[],messages:[]};
  const context=buildHandoff({target,members:[source,target],git:[]});
  assert.deepEqual(context.keys,['s:r:uncertain']);
  target.handoffDeliveries=[{requestId:'t1',keys:context.keys}];target.turns=[{requestId:'t1',status:'completed'}];
  assert.equal(unseenTurns(target,[source,target]).length,0);
  source.turns[0].status='completed';source.status='completed';
  assert.equal(unseenTurns(target,[source,target]).length,1);
});

test('passagem conserva os vários blocos parciais do agy após interrupção ou queda antes de result',async t=> {
  const {directory,hub,antigravity,claude,lastClaude}=await setup(t);
  for(const status of ['interrupted','uncertain']){
    const c=await hub.create({provider:'antigravity',cwd:directory,model:'gemini-4-argon',effort:'low'});
    const source=antigravity.conversation(c.id),requestId=`partial-${status}`;
    await hub.send(c.id,'multi-partial-hold',requestId);
    await waitFor(()=>source.messages.filter(m=>m.role==='assistant'&&m.requestId===requestId).length===2);
    if(status==='interrupted')await hub.interrupt(c.id);
    else process.kill(-antigravity.session.child.pid,'SIGKILL');
    await waitFor(()=>source.status===status);
    assert.equal(source.turns[0].finalAnswer,undefined);
    assert.equal(finalAnswer(source,requestId),'Primeiro bloco parcial.\n\nSegundo bloco parcial.');
    if(status==='uncertain')await hub.acknowledgeUncertainty(c.id,{expectedRequestId:requestId});
    const moved=await hub.send(c.id,'continua com os resultados parciais',`next-${status}`,{provider:'claude',model:'haiku',effort:'low',handoffMode:'quick'});
    await waitFor(idle(hub));
    const prompt=await lastClaude(claude.conversation(moved.conversationId));
    assert.match(prompt,/Resposta parcial: Primeiro bloco parcial\.\n\nSegundo bloco parcial\./);
    if(status==='uncertain')assert.match(prompt,/RESULTADO POR CONFIRMAR/);
    assert.equal(source.status,status);
  }
});

test('passagem conserva plano nativo mesmo sem edições e recupera base curta após compactação',()=>{
 const source={id:'s',provider:'codex',cwd:'/p',turns:[{id:'t',requestId:'r',status:'completed',startedAt:'2026-01-01',model:'gpt',plan:[{step:'DECISAO-SEM-EDICOES',status:'pending'}],facts:{files:[],commands:[]}}],messages:[{role:'user',requestId:'r',text:'Planeia'},{role:'assistant',requestId:'r',text:'Plano proposto'}],items:[]};
 const target={id:'d',provider:'claude',cwd:'/p',turns:[],messages:[]};const first=buildHandoff({target,members:[source,target],git:[]});assert.match(first.text,/DECISAO-SEM-EDICOES/);
 target.turns.push({requestId:'delivery',status:'completed'});target.handoffDeliveries=[{requestId:'delivery',keys:first.keys,epoch:0}];assert.equal(buildHandoff({target,members:[source,target],git:[]}),null);
 target.contextEpoch=1;const recovered=buildHandoff({target,members:[source,target],git:[]});assert.match(recovered.text,/Base curta após compactação/);assert.match(recovered.text,/DECISAO-SEM-EDICOES/);assert.deepEqual(recovered.keys,[]);
 target.turns.push({requestId:'base',status:'completed'});target.handoffDeliveries.push({requestId:'base',keys:[],epoch:1});assert.equal(buildHandoff({target,members:[source,target],git:[]}),null);
});

test('passagem renova o mesmo pedido quando parcial passa a concluído',()=>{
 const source={id:'s',provider:'codex',cwd:'/p',turns:[{id:'t',requestId:'r',status:'interrupted',model:'gpt',facts:{files:[],commands:[]}}],messages:[{role:'user',requestId:'r',text:'Pedido'},{role:'assistant',requestId:'r',text:'Parcial'}],items:[]};
 const target={id:'d',cwd:'/p',turns:[],messages:[]};const first=buildHandoff({target,members:[source,target],git:[]});target.turns.push({requestId:'delivery',status:'completed'});target.handoffDeliveries=[{requestId:'delivery',keys:first.keys,fingerprints:first.fingerprints}];assert.equal(buildHandoff({target,members:[source,target]}),null);
 source.turns[0].status='completed';source.messages[1].text='Conclusão final';assert.match(buildHandoff({target,members:[source,target]}).text,/Conclusão final/);
});

test('compactação repõe base anterior também quando há novidades por entregar',()=>{
 const source={id:'s',provider:'codex',cwd:'/p',turns:[{id:'t',requestId:'old',status:'completed',model:'gpt',facts:{files:[],commands:[]},startedAt:'2026-01-01'}],messages:[{role:'user',requestId:'old',text:'Restrição anterior importante'},{role:'assistant',requestId:'old',text:'Plano antigo'}],items:[]},target={id:'d',cwd:'/p',turns:[],messages:[]};
 const first=buildHandoff({target,members:[source,target]});target.turns.push({requestId:'received',status:'completed'});target.handoffDeliveries=[{requestId:'received',keys:first.keys,fingerprints:first.fingerprints,epoch:0}];target.contextEpoch=1;
 source.turns.push({requestId:'new',status:'completed',startedAt:'2026-01-02',facts:{files:[],commands:[]}});source.messages.push({role:'user',requestId:'new',text:'Novidade atual'});
 const next=buildHandoff({target,members:[source,target]});assert.match(next.text,/Base curta após compactação/);assert.match(next.text,/Restrição anterior importante/);assert.match(next.text,/Novidade atual/);
});
