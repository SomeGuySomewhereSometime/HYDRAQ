import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {ClaudeCode} from '../lib/claude.mjs';
import {buildHandoff} from '../lib/handoff.mjs';
import {currentWork,reasoningText,describeAction} from '../public/actions.js';

const wait=async f=>{const end=Date.now()+6000;while(!f()){if(Date.now()>end)throw Error('Tempo excedido');await new Promise(r=>setTimeout(r,10));}};
async function setup(t){
 const root=await mkdtemp('/tmp/hydraq-claude-progress-');
 const options={dataDir:root+'/state',defaultCwd:root,executable:process.execPath,prefixArgs:[new URL('./fixtures/fake-claude.mjs',import.meta.url).pathname],env:{...process.env,FAKE_CLAUDE_ARGS_LOG:root+'/args.json'}};
 const client=new ClaudeCode(options),clients=[client];
 t.after(async()=>{for(const c of clients)await c.close();await rm(root,{recursive:true,force:true});});
 await client.load();await client.connect();const c=await client.create({cwd:root,model:'haiku',effort:'low',sandbox:'plan'});
 const send=async(text,id=text)=>{await client.send(c.id,text,id);await wait(()=>!['starting','running','waiting'].includes(c.status));return c.turns.at(-1);};
 return {root,client,c,send,options,clients};
}

test('Claude: resumos em streaming e bloco final não duplicam, nem guardam assinaturas ou blocos ocultos',async t=>{
 const {root,client,c,send}=await setup(t);const turn=await send('claude-summary');
 const args=JSON.parse(await readFile(root+'/args.json','utf8'));assert.equal(args[args.indexOf('--thinking-display')+1],'summarized');
 const thoughts=c.items.filter(i=>i.type==='reasoning');assert.equal(thoughts.length,1);
 assert.equal(reasoningText(thoughts[0]),'Vou comparar os resultados públicos.');assert.equal(thoughts[0].status,'completed');
 assert.equal(thoughts[0].summarySource,'claude-summarized');assert.ok(thoughts[0].completedAt);
 assert.equal(c.messages.filter(m=>m.role==='assistant').length,1);assert.equal(c.messages.at(-1).text,'Resposta pública.');
 assert.doesNotMatch(JSON.stringify(client.snapshot()),/SIGNATURE-NOT-FOR-DISPLAY|REDACTED-NOT-FOR-DISPLAY|CHILD-NOT-FOR-DISPLAY/);
 const target={id:'other',turns:[],messages:[]},context=buildHandoff({target,members:[c,target],git:[],budget:40000});
 assert.doesNotMatch(context.text,/Vou comparar os resultados públicos/);assert.match(context.text,/Resposta pública/);
 assert.equal(client.snapshot().conversations[0].progress.thought,'Vou comparar os resultados públicos.');
 assert.equal(currentWork(c,turn),null);
 await send('claude-summary-empty');
 assert.equal(reasoningText(c.items.findLast(i=>i.type==='reasoning')),'Vou comparar os resultados públicos.');
});

test('Claude: conserva o resumo longo inteiro e não o reutiliza no pedido seguinte',async t=>{
 const {client,c,send}=await setup(t);await send('claude-summary-long');
 assert.equal(reasoningText(c.items.find(i=>i.type==='reasoning')),'Resumo disponibilizado. '.repeat(2000).trim());
 await send('sem resumo');assert.equal(client.snapshot().conversations[0].progress.thought,null);
});

test('Claude: o estado A pensar depende do evento e termina quando o pedido é interrompido',async t=>{
 const {client,c}=await setup(t);await client.send(c.id,'claude-summary-hold','hold');
 await wait(()=>c.items.some(i=>i.type==='reasoning'&&i.summary));assert.equal(currentWork(c,c.turns.at(-1)).state,'reasoning');
 await client.interrupt(c.id);await wait(()=>c.status==='interrupted');
 assert.equal(c.items.find(i=>i.type==='reasoning').status,'interrupted');assert.equal(currentWork(c,c.turns.at(-1)),null);
});

test('Claude: apenas tarefas confirmadas formam o plano, sem duplicação e sem as listas dos subagentes',async t=>{
 const {c,send}=await setup(t);const turn=await send('claude-tasks-start');
 assert.deepEqual(turn.plan.steps,[{step:'Ler o ficheiro',status:'inProgress'},{step:'Responder',status:'pending'}]);
 assert.equal(c.tasks.length,2);assert.equal(c.items.find(i=>i.tool==='TaskUpdate'&&i.parameters.status==='completed').status,'failed');
 assert.equal(describeAction(c.items.find(i=>i.tool==='TaskUpdate')).detail,'Marcar «Ler o ficheiro» como em curso');
 const done=await send('claude-tasks-finish');assert.deepEqual(done.plan.steps,[{step:'Ler o ficheiro',status:'completed'}]);
 const next=await send('outra pergunta');assert.equal(next.plan,null);
});

test('Claude: tarefas pendentes persistem e retomam na mesma sessão após relançar o adaptador',async t=>{
 const {client,c,send,options,clients}=await setup(t);await send('claude-tasks-start');await client.close();
 const again=new ClaudeCode(options);clients.push(again);await again.load();await again.connect();
 await again.send(c.id,'continuar','after-restart');const restored=again.conversation(c.id);await wait(()=>restored.status==='completed');
 assert.deepEqual(restored.turns.at(-1).plan.steps,[{step:'Ler o ficheiro',status:'inProgress'},{step:'Responder',status:'pending'}]);
});

test('Claude: uma chamada sem resultado não cria um plano; TodoWrite confirmado continua suportado',async t=>{
 const {client,c,send}=await setup(t);await client.send(c.id,'claude-tasks-pending','pending');
 await wait(()=>c.items.length);assert.equal(c.tasks,undefined);assert.equal(c.turns.at(-1).plan,null);
 await client.interrupt(c.id);await wait(()=>c.status==='interrupted');
 const turn=await send('claude-tasks-todo');assert.deepEqual(turn.plan.steps,[{step:'Etapa antiga',status:'completed'},{step:'Etapa atual',status:'inProgress'}]);
 const next=await send('mais');assert.deepEqual(next.plan.steps,[{step:'Etapa atual',status:'inProgress'}]);
});
