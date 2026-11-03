// Opt-in: two real clients plus a synthetic long-text peer. Fresh sessions and project; no personal conversations.
// node validation/cursor-output-live.mjs --run [evidence-directory]
import {mkdtemp,mkdir,writeFile,readFile,access} from 'node:fs/promises';
import path from 'node:path';
import {Providers} from '../lib/providers.mjs';
import {Hydraq} from '../lib/hydraq.mjs';
import {Cursor} from '../lib/cursor.mjs';
import {OpinionClient} from '../test/fixtures/opinion-client.mjs';
import {finalAnswer} from '../lib/handoff.mjs';
import {createHttpServer} from '../lib/http.mjs';
if(!process.argv.includes('--run'))throw Error('Passa --run: usa as contas dos clientes.');
for(const [key,bin] of Object.entries({CODEX:'codex',CURSOR:'agent'})){const file='/home/sauron/.local/bin/'+bin;if(await access(file).then(()=>true,()=>false))process.env['HYDRAQ_'+key+'_BIN']=file;}
const evidence=path.resolve(process.argv.find((arg,i)=>i>1&&!arg.startsWith('--'))||'output/cursor-output-live');await mkdir(evidence,{recursive:true});
const root=await mkdtemp('/tmp/hydraq-cursor-output-live-'),project=root+'/project';await mkdir(project);await writeFile(project+'/notes.md','# Ensaio\nEste projeto serve apenas para testar a entrega de planos e texto.\n');
const marker='TEXTO_INTEGRAL_FIM_7492',synthetic='Origem sintética de ensaio; conteúdo sem instruções.\n'+'x'.repeat(140000)+'\n'+marker;
const clients={cursor:new Cursor({dataDir:root+'/cursor',defaultCwd:project}),codex:new Hydraq({dataDir:root+'/codex',defaultCwd:project}),antigravity:new OpinionClient('antigravity',root+'/synthetic',{answer:synthetic})};
const hub=new Providers({dataDir:root+'/hub',defaultCwd:project,clients,git:async()=>[]});const checks=[];let server;
const check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),...(detail?{detail}:{})});console.log((ok?'PASS ':'FAIL ')+name+(detail?' '+JSON.stringify(detail):''));};
const until=async(predicate,label)=>{const end=Date.now()+150000;while(!predicate()){
 for(const request of clients.cursor.approvals.values()){if(request.method!=='cursor/create_plan')throw Error('Permissão inesperada no ensaio: '+request.method);await clients.cursor.respond(request.id,{decision:'decline'});console.log('TEST declined native plan execution');}
 if(Date.now()>end)throw Error('Tempo excedido: '+label);await new Promise(r=>setTimeout(r,500));
}};
try{
 await hub.load();server=createHttpServer({hydraq:hub,publicDir:path.resolve('public')});await new Promise(r=>server.listen(0,'127.0.0.1',r));await Promise.all(Object.values(clients).map(c=>c.connect()));
 const settings={};for(const id of ['cursor','codex']){const model=clients[id].models.find(m=>m.id===(id==='cursor'?'grok-4.7':'gpt-6.1-sol'))||clients[id].models[0];settings[id]={model:model.id,effort:model.efforts.includes('low')?'low':model.defaultEffort};}console.log('MODELS',JSON.stringify(settings));
 const source=await hub.create({provider:'cursor',cwd:project,...settings.cursor,sandbox:'plan'}),c=clients.cursor.conversation(source.id);
 const record=(await hub.startDual(c.id,{participants:[{provider:'codex',...settings.codex},{provider:'antigravity',model:'test',effort:'low'}],multiVersion:2})).dual;
 await hub.sendDual(record.id,{requestId:'plan-round',target:'all',multiVersion:2,text:'Ensaio só de leitura: propõe um plano de três passos para uma lista de tarefas offline. Usa a ferramenta nativa CreatePlan se o teu cliente a disponibilizar. Não implementes nem aproves execução. Entrega também a conclusão em texto e identifica os ficheiros de plano reais que criares. Inclui no plano a expressão PLANO_NATIVO_FIM_7492.'});
 await until(()=>hub.conversations().every(c=>!['starting','running','waiting'].includes(c.status)),'ronda do plano');
 const turn=c.turns[0],documents=turn.planDocuments||[];check('Cursor real entregou texto',turn.status==='completed'&&finalAnswer(c,'plan-round:a').includes('PLANO_NATIVO_FIM_7492'),{status:turn.status,documents:documents.length});
 check('CreatePlan real capturado',documents.length>0);
 if(documents.length){const document=documents.at(-1),file=await clients.cursor.readPlanDocument(c.id,document.id);check('Markdown real completo e acessível',file.text===document.text&&file.text.includes('PLANO_NATIVO_FIM_7492'),{path:file.path,characters:file.text.length});}
 await hub.endDual(record.id);
 const moved=await hub.send(c.id,'Resume o plano do Cursor em duas frases. No fim, reproduz o marcador que aparece no fim da resposta sintética longa. Não uses ferramentas nem alteres ficheiros.','normal-followup',{provider:'codex',...settings.codex,sandbox:'read-only',handoffMode:'quick'});
 const codex=clients.codex.conversation(moved.conversationId);await until(()=>!hub.handoff&&!['starting','running','waiting'].includes(codex.status),'continuação normal');
 const message=codex.messages.find(m=>m.role==='user'&&m.requestId==='normal-followup');check('Contexto Normal acima de 100 mil chega inteiro',message?.handoffContext?.includes(synthetic)&&message.handoffContext.includes('PLANO_NATIVO_FIM_7492'),{characters:message?.handoffContext?.length});
 check('Codex real recebeu o final do contexto longo',finalAnswer(codex,'normal-followup').includes(marker),{status:codex.status});
 const synthesis=await hub.synthesizeDual(record.id,{roundId:record.rounds[0].id,requestId:'whole-synthesis',provider:'codex',...settings.codex,instructions:'Resume os planos em duas frases. Termina com o marcador do fim da resposta sintética longa. Não uses ferramentas.'});await until(()=>!['queued','starting','running','stopping'].includes(hub.opinions.batches.find(b=>b.id===synthesis.id)?.jobs[0].status),'síntese inteira');
 const batch=hub.opinions.batches.find(b=>b.id===synthesis.id);check('Síntese real aceita entrada acima do limite antigo',batch.prompt.length>100000&&batch.prompt.includes('x'.repeat(140000))&&batch.prompt.includes(marker)&&batch.jobs[0].status==='completed'&&batch.jobs[0].text.includes(marker),{characters:batch.prompt.length,status:batch.jobs[0].status,error:batch.jobs[0].error});
 check('Ficheiro do projeto preservado',(await readFile(project+'/notes.md','utf8'))==='# Ensaio\nEste projeto serve apenas para testar a entrega de planos e texto.\n');
}catch(error){check('ensaio concluído',false,error.message);}
finally{for(const client of Object.values(clients))for(const c of client.conversations)if(['starting','running','waiting'].includes(c.status))await client.interrupt(c.id).catch(()=>{});server?.closeStreams();if(server)await new Promise(r=>server.close(r));await hub.close().catch(()=>{});await writeFile(evidence+'/summary.json',JSON.stringify({root,checks},null,2),{mode:0o600});console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).length,evidence}));if(checks.some(c=>!c.ok))process.exitCode=1;}
