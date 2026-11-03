// Opt-in smoke test: real subscriptions, synthetic prompts and fresh sessions in /tmp.
// node validation/multi-live.mjs --run [evidence-directory]
import {mkdtemp,mkdir,readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {Providers} from '../lib/providers.mjs';
import {Hydraq} from '../lib/hydraq.mjs';
import {ClaudeCode} from '../lib/claude.mjs';
import {Antigravity} from '../lib/antigravity.mjs';
import {Cursor} from '../lib/cursor.mjs';
import {finalAnswer} from '../lib/handoff.mjs';
import {createHttpServer} from '../lib/http.mjs';
if(!process.argv.includes('--run'))throw Error('Passa --run: este ensaio usa as contas dos clientes.');
for(const [id,bin] of Object.entries({CODEX:'codex',CLAUDE:'claude',AGY:'agy',CURSOR:'agent'})){const file='/home/sauron/.local/bin/'+bin;if(await access(file).then(()=>true,()=>false))process.env['HYDRAQ_'+id+'_BIN']=file;}
const evidence=path.resolve(process.argv.find((arg,i)=>i>1&&!arg.startsWith('--'))||'output/multi-live');await mkdir(evidence,{recursive:true});
const directory=await mkdtemp('/tmp/hydraq-multi-live-'),project=directory+'/project';await mkdir(project);await writeFile(project+'/notes.txt','Ensaio isolado do modo Multi.\n');
const clients={codex:new Hydraq({dataDir:directory+'/codex',defaultCwd:project}),claude:new ClaudeCode({dataDir:directory+'/claude',defaultCwd:project}),antigravity:new Antigravity({dataDir:directory+'/antigravity',defaultCwd:project}),cursor:new Cursor({dataDir:directory+'/cursor',defaultCwd:project})};
const hub=new Providers({dataDir:directory+'/hub',defaultCwd:project,clients,git:async()=>[]}),checks=[];let server;
const check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),...(detail?{detail}:{})});console.log((ok?'PASS ':'FAIL ')+name+(detail?' '+JSON.stringify(detail):''));};
const until=async(predicate,label)=>{const end=Date.now()+120000;while(!predicate()){if(Date.now()>end)throw Error('Tempo excedido: '+label);await new Promise(r=>setTimeout(r,500));}};
try{
 await hub.load();server=createHttpServer({hydraq:hub,publicDir:path.resolve('public')});await new Promise(r=>server.listen(0,'127.0.0.1',r));await Promise.all(Object.values(clients).map(c=>c.connect()));
 const preferred={codex:'gpt-6.1-sol',claude:'sonnet',antigravity:'gemini-3.8-flash',cursor:'grok-4.7'},settings={};
 for(const [id,client] of Object.entries(clients)){const model=client.models.find(m=>m.id===preferred[id])||client.models.find(m=>m.isDefault)||client.models[0];if(!model)throw Error('Catálogo vazio: '+id);settings[id]={model:model.id,effort:model.efforts.includes('low')?'low':model.defaultEffort||model.efforts[0]};}
 console.log('MODELS',JSON.stringify(settings));
 const chat=await hub.create({provider:'codex',cwd:project,...settings.codex,sandbox:'read-only'}),record=(await hub.startDual(chat.id,{participants:['claude','antigravity','cursor'].map(provider=>({provider,...settings[provider]})),multiVersion:2})).dual;
 const round=async(requestId,text,target='all')=>{await hub.sendDual(record.id,{requestId,text,target,multiVersion:2});const r=hub.dual.record(record.id).rounds.at(-1);await until(()=>r.targets.every(k=>{const d=r.deliveries[k],c=clients[d.provider].conversation(d.conversationId);return c.turns.some(t=>t.requestId===d.requestId)&&!['starting','running','waiting'].includes(c.status);}),requestId);return r;};
 const first=await round('multi-real-all','Responde apenas: MULTI_REAL_OK. Não uses ferramentas nem alteres ficheiros.');
 check('quatro clientes reais responderam',first.targets.every(k=>{const d=first.deliveries[k],c=clients[d.provider].conversation(d.conversationId);return c.turns.find(t=>t.requestId===d.requestId)?.status==='completed'&&finalAnswer(c,d.requestId).includes('MULTI_REAL_OK');}),first.targets.map(k=>{const d=first.deliveries[k],c=clients[d.provider].conversation(d.conversationId);return {provider:d.provider,status:c.status,error:c.error||null};}));
 const before=Object.fromEntries(Object.entries(clients).map(([id,c])=>[id,c.conversations.flatMap(c=>c.turns).length]));
 const second=await round('multi-real-subset','Responde apenas: CONTEXTO_MULTI_OK. Não uses ferramentas nem alteres ficheiros.',['a','c']);
 check('subconjunto executa só Codex e Antigravity',clients.claude.conversations.flatMap(c=>c.turns).length===before.claude&&clients.cursor.conversations.flatMap(c=>c.turns).length===before.cursor&&second.targets.length===2);
 check('contexto anterior entregue pelos três colegas',second.targets.every(k=>{const d=second.deliveries[k],c=clients[d.provider].conversation(d.conversationId),message=c.messages.find(m=>m.role==='user'&&m.requestId===d.requestId);return d.coverage==='complete'&&Object.keys(d.peerCoverage||{}).length===3&&message.handoffContext?.includes('MULTI_REAL_OK');}));
 const result=await hub.synthesizeDual(record.id,{requestId:'multi-real-synthesis',roundId:first.id,provider:'antigravity',...settings.antigravity,instructions:'Uma linha com a expressão MULTI_REAL_OK.'});await until(()=>!['queued','starting','running','stopping'].includes(hub.opinions.batches.find(b=>b.id===result.id)?.jobs[0].status),'síntese');const batch=hub.opinions.batches.find(b=>b.id===result.id);check('síntese real de quatro respostas',batch.jobs[0].status==='completed'&&batch.jobs[0].text.includes('MULTI_REAL_OK'),{status:batch.jobs[0].status,error:batch.jobs[0].error||null});
 await hub.changeDualRoster(record.id,{key:'d',requestId:'multi-real-remove',revision:record.revision,multiVersion:2},true);await hub.changeDualRoster(record.id,{provider:'cursor',...settings.cursor,requestId:'multi-real-add',revision:record.revision,multiVersion:2});check('saída e reentrada reutilizam a sessão Cursor',clients.cursor.conversations.length===1&&Object.keys(record.members).length===4);
 check('ficheiro de ensaio preservado',(await readFile(project+'/notes.txt','utf8'))==='Ensaio isolado do modo Multi.\n');
}catch(error){check('ensaio concluído',false,error.message);}
finally{
 for(const client of Object.values(clients))for(const c of client.conversations)if(['starting','running','waiting'].includes(c.status))await client.interrupt(c.id).catch(()=>{});
 server?.closeStreams();if(server)await new Promise(r=>server.close(r));await hub.close().catch(()=>{});await writeFile(evidence+'/summary.json',JSON.stringify({directory,checks},null,2),{mode:0o600});console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).length,evidence}));if(checks.some(c=>!c.ok))process.exitCode=1;
}
