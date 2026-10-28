// Claude-only QA: the real adapter with its simulated CLI, separate data and HTTP server.
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {Providers} from '../lib/providers.mjs';
import {ClaudeCode} from '../lib/claude.mjs';
import {OpinionClient} from '../test/fixtures/opinion-client.mjs';
import {createHttpServer} from '../lib/http.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.resolve(process.argv[2]||'.hydraq/claude-progress-2026-10-28');await mkdir(out,{recursive:true});
const root=await mkdtemp('/tmp/hydraq-claude-ui-');
const claude=new ClaudeCode({dataDir:root+'/claude',defaultCwd:root,executable:process.execPath,prefixArgs:[repo+'/test/fixtures/fake-claude.mjs']});
const clients={claude,codex:new OpinionClient('codex',root+'/codex')};
const hub=new Providers({dataDir:root+'/hub',defaultCwd:root,clients,git:async()=>[]});
const checks=[],errors=[];let browser,server;
const check=(name,ok)=>{checks.push({name,ok:Boolean(ok)});if(!ok)console.error('FAIL '+name);};
const until=async f=>{const end=Date.now()+10000;while(!f()){if(Date.now()>end)throw Error('Tempo excedido');await new Promise(r=>setTimeout(r,20));}};
try{
 await hub.load();await hub.connectAll();const c=await claude.create({cwd:root,model:'haiku',effort:'low',sandbox:'plan'});
 const send=async text=>{await hub.send(c.id,text,crypto.randomUUID(),{model:'haiku',effort:'low',sandbox:'plan'});await until(()=>c.status==='completed');};
 await send('claude-summary-long');
 server=createHttpServer({hydraq:hub,publicDir:repo+'/public'});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(id=>{localStorage.setItem('hydraq.conversation',id);localStorage.setItem('hydraq.theme','atelier');},c.id);
 await page.goto('http://127.0.0.1:'+server.address().port);
 const card=page.locator('#progress-panel');await card.locator('.claude-thought summary').waitFor();
 await card.locator('.claude-thought summary').click();
 check('full Claude summary, including text above 20k',await card.locator('.claude-thought-text').textContent()==='Resumo disponibilizado. '.repeat(2000).trim());
 check('summary is separate from the public answer',(await page.locator('#messages > .message').allTextContents()).some(s=>s.includes('Resposta pública.')));
 await page.screenshot({path:out+'/claude-summary-atelier.png'});
 await page.reload();await card.locator('.claude-thought summary').waitFor();check('summary survives reload',await card.locator('.claude-thought-text').count()===1);
 await hub.send(c.id,'claude-summary-hold','summary-live',{model:'haiku',effort:'low',sandbox:'plan'});
 await page.waitForFunction(()=>document.querySelector('#progress-panel .progress-heading strong')?.textContent==='A pensar');
 check('live summary appears while the Claude thinks',await card.locator('.claude-thought-text').textContent()==='Vou comparar os resultados públicos.');
 await claude.interrupt(c.id);await until(()=>c.status==='interrupted');
 await page.waitForFunction(()=>document.querySelector('#progress-panel')?.dataset.status==='interrupted');
 check('interruption keeps the summary and stops clocks',await card.locator('.claude-thought-text').count()===1&&await card.locator('[data-elapsed-since]').count()===0);
 await send('claude-tasks-start');await card.locator('.progress-plan li').first().waitFor({state:'attached'});
 await card.locator('.progress-details summary').click();
 check('confirmed tasks become two named steps',(await card.locator('.progress-plan li span').allTextContents()).join('|')==='Ler o ficheiro|Responder');
 check('failed completion does not finish the first step',await card.locator('.progress-plan li').first().getAttribute('data-status')==='inProgress');
 check('a new request does not show the previous summary',await card.locator('.claude-thought').count()===0);
 await send('claude-tasks-finish');await page.waitForFunction(()=>document.querySelectorAll('#progress-panel .progress-plan li').length===1);
 check('completed and deleted tasks reflected',await card.locator('.progress-plan li').getAttribute('data-status')==='completed');
 await page.screenshot({path:out+'/claude-plan-atelier.png'});
 const {dual}=await hub.startDual(c.id,{provider:'codex',model:'test',effort:'low'});
 await hub.sendDual(dual.id,{text:'claude-summary',requestId:'dual-summary'});await until(()=>c.status==='completed');
 await page.locator('.dual-stage .claude-thought summary').waitFor();
 check('Claude summary shown inside its Dual panel',await page.locator('.dual-stage .claude-thought-text').textContent()==='Vou comparar os resultados públicos.');
 await page.locator('.dual-stage .claude-thought summary').click();
 c.items.findLast(i=>i.type==='reasoning').summary+=' Atualização.';claude.changed();
 await page.waitForFunction(()=>document.querySelector('.dual-stage .claude-thought-text')?.textContent.endsWith('Atualização.'));
 check('Dual keeps the summary open during updates',await page.locator('.dual-stage .claude-thought').getAttribute('open')!==null);
 await page.screenshot({path:out+'/claude-summary-dual.png'});
 // The Hydra view's Claude summary uses the same expandable text. Isolate its view from the task scheduler.
 const hydra=await page.evaluate(async()=>{
  const {ClaudeXUI}=await import('./claudex.js'),state={providers:{claude:{models:[{id:'haiku',efforts:['low']}]},codex:{models:[{id:'test',efforts:['low']}]}},claudex:{records:[]},approvals:[],projectCatalog:{projects:[]}};
  const ui=new ClaudeXUI({api:async()=>({}),getState:()=>state,area:{view:'claudex'},toast(){},markdown:t=>{const e=document.createElement('p');e.textContent=t;return e;}});clearInterval(ui.timer);
  ui.selected='fixture';ui.detail={id:'fixture',cwd:'/tmp',roles:['codex','claude'],status:'paused',author:'claude',consensus:true,guards:{turns:30,minutes:60},members:{codex:{model:'test'},claude:{model:'haiku'}},participants:{codex:{status:'idle'},claude:{status:'idle',thought:'Resumo do Claude no Hydra.'}},messages:[{type:'request',text:'Pedido comum',seq:1}],candidates:[],approvals:{}};
  ui.renderDetail();return ui.participants.querySelector('[data-client="claude"] .claude-thought-text')?.textContent;
 });
 check('Hydra Claude participant displays its summary',hydra==='Resumo do Claude no Hydra.');
 check('no JavaScript errors',errors.length===0);
}catch(error){errors.push(error.stack||error.message);check('validation completed',false);}
finally{await browser?.close();server?.close();await hub.close().catch(()=>{});await rm(root,{recursive:true,force:true});}
await writeFile(out+'/results.json',JSON.stringify({checks,errors},null,2));
console.log(JSON.stringify({out,passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).map(c=>c.name),errors}));
if(errors.length||checks.some(c=>!c.ok))process.exitCode=1;
