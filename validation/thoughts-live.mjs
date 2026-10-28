// Opt-in subscription run of the reasoning text and task lists with real clients: Grok 4.7 through Cursor (one
// read-only request with a task list) and Gemini 3.8 Flash through Antigravity (two requests in one conversation,
// so the step numbers of the second are checked against agy's transcript). Photographs each card with the reasoning
// open. Fresh project folder and HYDRAQ data; the clients' own transcripts are only read.
// node validation/thoughts-live.mjs --run [evidence-directory]
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {chromium} from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {Providers} from '../lib/providers.mjs';
import {Antigravity} from '../lib/antigravity.mjs';
import {Cursor} from '../lib/cursor.mjs';
import {createHttpServer} from '../lib/http.mjs';
import {reasoningText,actionDuration,thoughtLabel} from '../public/actions.js';

if(!process.argv.includes('--run'))throw Error('Passa --run explicitamente: este ensaio usa as contas dos clientes.');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const evidence=path.resolve(process.argv.find((arg,i)=>i>1&&!arg.startsWith('--'))||'.hydraq/thoughts-live-2026-10-28');
await mkdir(evidence,{recursive:true});
const directory=await mkdtemp('/tmp/hydraq-thoughts-live-');
const notes='# Notas\nPrimeira linha.\nSegunda linha.\nTerceira linha.\n';
await writeFile(directory+'/notas.md',notes);
const clients={cursor:new Cursor({dataDir:directory+'/cursor',defaultCwd:directory}),antigravity:new Antigravity({dataDir:directory+'/antigravity',defaultCwd:directory})};
const hub=new Providers({dataDir:directory+'/hub',defaultCwd:directory,clients,git:async()=>[]});
const checks=[],runs=[];let server,browser;
const check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),detail});console.log((ok?'PASS ':'FAIL ')+name+(detail===undefined?'':' — '+JSON.stringify(detail).slice(0,400)));};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const idle=c=>!['starting','running','waiting'].includes(c.status);
const thoughtsOf=(c,turn)=>c.items.filter(i=>i.turnId===turn.id&&i.type==='reasoning');
async function ask(provider,c,prompt,model){
 const requestId='thoughts-'+runs.length,seen=[];
 await hub.send(c.id,prompt,requestId,model);
 const end=Date.now()+300000;
 // What the card's reasoning said while the client worked, as the page receives it.
 while(Date.now()<end){const shown=hub.snapshot().conversations.find(x=>x.id===c.id)?.progress;if(shown?.thought&&seen.at(-1)!==shown.thought)seen.push(shown.thought);if(c.turns.at(-1)?.requestId===requestId&&idle(c))break;await sleep(250);}
 const turn=c.turns.at(-1);
 // agy may write its last summary just after the result.
 await sleep(3000);
 runs.push({provider,status:turn.status,live:seen.length,thoughts:thoughtsOf(c,turn).map(i=>({id:i.id.slice(37),chars:reasoningText(i).length,durationMs:i.durationMs??null,text:reasoningText(i).slice(0,240)})),plan:turn.plan?.steps||null,tools:c.items.filter(i=>i.turnId===turn.id&&i.type!=='reasoning').map(i=>({tool:i.tool,state:i.status,duration:actionDuration(i)})),answer:(turn.finalAnswer||c.messages.filter(m=>m.turnId===turn.id&&m.role==='assistant').map(m=>m.text).join('\n')).slice(0,300)});
 console.log(JSON.stringify(runs.at(-1)).slice(0,1500));
 return turn;
}
async function photograph(c,name,label){
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(id=>{localStorage.setItem('hydraq.theme','atelier');localStorage.setItem('hydraq.conversation',id);},c.id);
 await page.goto('http://127.0.0.1:'+server.address().port);
 const thought=page.locator('#progress-panel .claude-thought');
 await thought.locator('summary').waitFor({timeout:15000}).catch(()=>{});
 const heading=await thought.locator('summary').textContent().catch(()=>null);
 if(heading)await thought.locator('summary').click();
 const text=await page.locator('#progress-panel .claude-thought-text').textContent().catch(()=>'');
 await page.locator('#progress-panel .progress-details > summary').click().catch(()=>{});
 await page.screenshot({path:path.join(evidence,name+'.png')});await page.close();
 check(`${name}: cartão com «${label}» e o texto`,heading===label&&text.length>0&&!errors.length,{heading,chars:text.length,errors});
}
try{
 await hub.load();await Promise.all(Object.values(clients).map(client=>client.connect()));
 server=createHttpServer({hydraq:hub,publicDir:path.join(repo,'public')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});

 // Grok 4.7: no commands, so Planear asks for nothing.
 const grok=clients.cursor.models.find(m=>m.id==='grok-4.7');if(!grok)throw Error('Grok 4.7 indisponível.');
 const grokModel={model:grok.id,effort:grok.efforts.includes('medium')?'medium':grok.defaultEffort,sandbox:'plan'};
 const gc=clients.cursor.conversation((await hub.create({provider:'cursor',cwd:directory,...grokModel})).id);gc.title='Raciocínio · Grok 4.7';
 const gt=await ask('cursor',gc,'Antes de começar, faz uma lista de tarefas com 3 passos (ler notas.md, contar as linhas que leste, responder) e vai marcando cada passo. Lê o ficheiro notas.md. Não corras comandos nem alteres ficheiros. Responde numa frase com o número de linhas.',grokModel);
 const gThoughts=thoughtsOf(gc,gt);
 check('Grok: pedido concluído',gt.status==='completed',gt.status);
 check('Grok: raciocínio com texto guardado à parte da resposta',gThoughts.some(i=>reasoningText(i))&&!gc.messages.some(m=>gThoughts.some(i=>reasoningText(i)&&m.text.includes(reasoningText(i)))),gThoughts.map(i=>reasoningText(i).length));
 check('Grok: raciocínio já visível enquanto trabalhava',runs.at(-1).live>0,runs.at(-1).live);
 check('Grok: lista com os três passos, sem perder nenhum nas atualizações parciais',gt.plan?.steps?.length===3,gt.plan?.steps);
 await photograph(gc,'card-grok-4-7',thoughtLabel('cursor'));

 // Gemini 3.8 Flash: two requests in the same conversation and the same agy process.
 const flash=clients.antigravity.models.find(m=>m.id==='gemini-3.8-flash');if(!flash)throw Error('Gemini 3.8 Flash indisponível.');
 const flashModel={model:flash.id,effort:flash.efforts.includes('medium')?'medium':flash.defaultEffort,sandbox:'plan'};
 const ac=clients.antigravity.conversation((await hub.create({provider:'antigravity',cwd:directory,...flashModel})).id);ac.title='Raciocínio · Gemini 3.8 Flash';
 // Gemini does not write a summary for every step that thought: the card is checked on the request that has one.
 const step=item=>Number(item.id.split(':').at(-2)),hasText=turn=>thoughtsOf(ac,turn).some(i=>reasoningText(i));
 const first=await ask('antigravity',ac,'Lê o ficheiro notas.md e diz quantas linhas tem. Pensa com cuidado se a contagem bate certo com o conteúdo. Não alteres ficheiros. Responde numa frase.',flashModel);
 if(hasText(first))await photograph(ac,'card-gemini-3-8-flash-1',thoughtLabel('antigravity'));
 const second=await ask('antigravity',ac,'Lê outra vez o notas.md e diz qual é a última linha. Pensa se há linhas em branco no fim. Não alteres ficheiros. Responde numa frase.',flashModel);
 if(hasText(second))await photograph(ac,'card-gemini-3-8-flash-2',thoughtLabel('antigravity'));
 const transcript=(await readFile(path.join(os.homedir(),'.gemini/antigravity-cli/brain',ac.threadId,'.system_generated/logs/transcript_full.jsonl'),'utf8')).trim().split('\n').map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
 for(const [label,turn] of [['1.º pedido',first],['2.º pedido',second]]){
  const thoughts=thoughtsOf(ac,turn);
  check(`Flash ${label}: concluído`,turn.status==='completed',turn.status);
  // Same step number, same text (or no summary in both): the stream and the transcript count steps the same way in every request.
  check(`Flash ${label}: cada raciocínio tem o resumo do mesmo passo no transcript, ou nenhum se lá não houver`,thoughts.length&&thoughts.every(i=>{const entry=transcript.find(e=>e.step_index===step(i));return entry?.type==='PLANNER_RESPONSE'&&(entry.thinking?.trim()||'').slice(0,200000)===reasoningText(i);}),thoughts.map(i=>[step(i),reasoningText(i).length]));
  check(`Flash ${label}: ferramentas com a duração do próprio agy`,ac.items.filter(i=>i.turnId===turn.id&&i.type!=='reasoning'&&i.status==='completed').every(i=>actionDuration(i)?.measured===false),ac.items.filter(i=>i.turnId===turn.id&&i.type!=='reasoning').map(i=>[i.tool,i.durationMs]));
 }
 check('Flash: pelo menos um resumo do raciocínio nos dois pedidos',hasText(first)||hasText(second));
 check('Flash: o 2.º pedido continua a numeração dos passos',Math.min(...thoughtsOf(ac,second).map(step))>Math.max(...ac.items.filter(i=>i.turnId===first.id).map(i=>Number(i.id.split(':')[1]))),{first:ac.items.filter(i=>i.turnId===first.id).map(i=>i.id.split(':')[1]),second:thoughtsOf(ac,second).map(step)});
 // The card shows the latest request: without a summary there, no reasoning section.
 if(!hasText(second)){const page=await browser.newPage();await page.addInitScript(id=>localStorage.setItem('hydraq.conversation',id),ac.id);await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('#progress-panel .progress-heading').waitFor();check('Flash: sem resumo no último pedido, o cartão não mostra o do anterior',await page.locator('#progress-panel .claude-thought').count()===0);await page.close();}

 const files=(await readdir(directory)).filter(name=>!['cursor','antigravity','hub'].includes(name));
 check('Projeto sem alterações',files.join()==='notas.md'&&await readFile(directory+'/notas.md','utf8')===notes,files);
}catch(error){check('Ensaio sem erros',false,error.message);}
finally{
 await writeFile(path.join(evidence,'summary.json'),JSON.stringify({directory,checks,runs},null,2));
 await browser?.close();server?.close();await hub.close().catch(()=>{});
 console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).map(c=>c.name),evidence}));
 setTimeout(()=>process.exit(0),1500).unref();
}
