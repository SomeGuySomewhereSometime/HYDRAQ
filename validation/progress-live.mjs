// Opt-in subscription run of the detailed progress with real clients: one short read-only request each to Codex
// (GPT-6.1 Sol), Claude (Sonnet 5.5), Gemini 3.8 Flash and, once, Gemini 4 Argon through Antigravity. Records what the
// card said while each worked, checks the actions in words with their times and the summary, and photographs each
// card with its real data. Fresh project folder and HYDRAQ data.
// node validation/progress-live.mjs --run [evidence-directory]
import {mkdtemp,mkdir,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {Providers} from '../lib/providers.mjs';
import {Hydraq} from '../lib/hydraq.mjs';
import {ClaudeCode} from '../lib/claude.mjs';
import {Antigravity} from '../lib/antigravity.mjs';
import {createHttpServer} from '../lib/http.mjs';
import {finalAnswer} from '../lib/handoff.mjs';
import {describeAction,actionPhrase,actionDuration,requestSummary,summaryLine,turnActions} from '../public/actions.js';

if(!process.argv.includes('--run'))throw Error('Passa --run explicitamente: este ensaio usa as contas dos clientes.');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const evidence=path.resolve(process.argv.find((arg,i)=>i>1&&!arg.startsWith('--'))||'.hydraq/progress-live-2026-10-28');
await mkdir(evidence,{recursive:true});
const directory=await mkdtemp('/tmp/hydraq-progress-live-');
await writeFile(directory+'/notas.md','# Notas\nPrimeira linha.\nSegunda linha.\nTerceira linha.\nQuarta linha.\n');
const clients={codex:new Hydraq({dataDir:directory+'/codex',defaultCwd:directory}),claude:new ClaudeCode({dataDir:directory+'/claude',defaultCwd:directory}),antigravity:new Antigravity({dataDir:directory+'/antigravity',defaultCwd:directory})};
const hub=new Providers({dataDir:directory+'/hub',defaultCwd:directory,clients,git:async()=>[]});
const checks=[],runs=[];let server,browser;
const check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),detail});console.log((ok?'PASS ':'FAIL ')+name+(detail===undefined?'':' — '+JSON.stringify(detail).slice(0,400)));};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const idle=c=>!['starting','running','waiting'].includes(c.status);
const prompt='Lê o ficheiro notas.md deste projeto e corre um comando só de leitura (por exemplo wc -l notas.md) para contar as linhas. Responde numa frase com o número de linhas. Não alteres ficheiros.';
try{
 await hub.load();await Promise.all(Object.values(clients).map(client=>client.connect()));
 const pick=(role,match,effort)=>{const model=clients[role].models.find(m=>match.test(m.id)||match.test(m.name||''));if(!model)throw Error('Modelo indisponível: '+role+'/'+match);return {model:model.id,effort:model.efforts?.includes(effort)?effort:model.defaultEffort};};
 const plan=[['codex','Codex · GPT-6.1 Sol',pick('codex',/^gpt-6\.1-sol$/,'low'),'read-only'],['claude','Claude · Sonnet 5.5',pick('claude',/^sonnet$/,'low'),'plan'],['antigravity','Gemini 3.8 Flash',pick('antigravity',/^gemini-3\.8-flash$/,'low'),'plan'],['antigravity','Gemini 4 Argon',pick('antigravity',/argon/i,'low'),'plan']];
 server=createHttpServer({hydraq:hub,publicDir:path.join(repo,'public')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
 for(const [provider,label,model,sandbox] of plan){
  const chat=await hub.create({provider,cwd:directory,...model,sandbox}),c=clients[provider].conversation(chat.id);c.title='Progresso · '+label;
  const titles=[],requestId='progress-'+runs.length;
  await hub.send(c.id,prompt,requestId,{...model,sandbox});
  // What the card said while it worked, as the page receives it.
  const end=Date.now()+300000;
  while(Date.now()<end){const shown=hub.snapshot().conversations.find(x=>x.id===c.id)?.progress;if(shown?.title&&titles.at(-1)!==shown.title)titles.push(shown.title);if(c.turns.length&&idle(c))break;await sleep(250);}
  const turn=c.turns.at(-1),items=turnActions(c,turn),summary=requestSummary(c,turn);
  const actions=items.filter(i=>i.type!=='reasoning').map(i=>({kind:describeAction(i).kind,phrase:actionPhrase(i,{cwd:c.cwd}),state:i.status,duration:actionDuration(i)}));
  runs.push({label,model,status:turn.status,titles,actions,summary:summaryLine(summary),answer:finalAnswer(c,requestId).slice(0,300)});
  console.log(JSON.stringify(runs.at(-1)).slice(0,1200));
  check(`${label}: pedido concluído`,turn.status==='completed',turn.status);
  check(`${label}: ações descritas por palavras (leitura ou comando)`,actions.some(a=>['read','command','search','list'].includes(a.kind)),actions.map(a=>a.phrase));
  check(`${label}: ações com duração`,actions.some(a=>a.duration),actions.map(a=>a.duration));
  check(`${label}: resumo do pedido`,summaryLine(summary).length>0&&summary.durationMs!==null,summaryLine(summary));
  check(`${label}: o cartão mostrou o trabalho enquanto decorria`,titles.some(t=>/^A |ações em curso|a trabalhar/.test(t)),titles);
  // The card with this request's real data.
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(id=>{localStorage.setItem('hydraq.theme','atelier');localStorage.setItem('hydraq.conversation',id);},c.id);
  await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('#messages #progress-panel').waitFor();
  await page.locator('#progress-panel details summary').click().catch(()=>{});
  const shown=await page.locator('#progress-panel').textContent();
  check(`${label}: cartão real com o resumo`,shown.includes(summaryLine(summary))&&!errors.length,{errors});
  await page.screenshot({path:path.join(evidence,`card-${runs.length}-${label.replace(/[^a-z0-9]+/gi,'-').toLowerCase()}.png`)});await page.close();
 }
 const files=(await readdir(directory)).filter(name=>!['codex','claude','antigravity','hub'].includes(name));
 check('Projeto sem alterações',files.join()==='notas.md',files);
}catch(error){check('Ensaio sem erros',false,error.message);}
finally{
 await writeFile(path.join(evidence,'summary.json'),JSON.stringify({directory,checks,runs},null,2));
 await browser?.close();server?.close();await hub.close().catch(()=>{});
 console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).map(c=>c.name),evidence}));
}
