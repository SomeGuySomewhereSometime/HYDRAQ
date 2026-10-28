// Isolated browser verification: no native model requests or active HYDRAQ data.
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {Providers} from '../lib/providers.mjs';
import {summarizeProgress} from '../lib/progress.mjs';
import {OpinionClient} from '../test/fixtures/opinion-client.mjs';
import {createHttpServer} from '../lib/http.mjs';
const root=await mkdtemp('/tmp/hydraq-progress-ui-'),out=path.resolve(process.argv[2]||root+'/evidence');await mkdir(out,{recursive:true});
const providers=['codex','claude','antigravity','cursor','opencode'];
const clients=Object.fromEntries(providers.map(provider=>[provider,new OpinionClient(provider,root+'/'+provider,{behavior:'hold'})]));
const hub=new Providers({dataDir:root+'/hub',defaultCwd:root,clients,git:async()=>[]});const results=[],errors=[];let browser,server;
const check=(name,ok)=>{results.push({name,ok:Boolean(ok)});if(!ok)throw Error(name);};
const wait=async predicate=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw Error('Simulated request did not start');await new Promise(r=>setTimeout(r,15));}};
try{
 await hub.load();const snapshot=hub.snapshot.bind(hub);hub.snapshot=()=>{const value=snapshot();value.conversations=value.conversations.map(c=>({...c,progress:summarizeProgress(c)}));return value;};
 server=createHttpServer({hydraq:hub,publicDir:path.resolve('public')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);
 const selected=[];
 for(const provider of providers){
  const client=clients[provider],settings={model:'test',effort:'low',sandbox:provider==='codex'?'read-only':'plan'},c=await client.create({cwd:root,...settings});c.title='Progresso '+provider;selected.push(c);
  await hub.send(c.id,'Pedido anterior '+provider,'old-'+provider,settings);await wait(()=>c.status==='running');client.finish(c,'Resposta anterior.');
  await hub.send(c.id,'Pedido atual '+provider,'now-'+provider,settings);await wait(()=>c.status==='running');
  c.items.push({id:'action-'+provider,turnId:c.turnId,type:'mcpToolCall',tool:'Read',server:provider,status:'inProgress',at:new Date().toISOString()});
  c.messages.push({id:'comment-'+provider,role:'assistant',phase:'commentary',turnId:c.turnId,requestId:'now-'+provider,text:'Vou verificar as fontes de '+provider+'.',at:new Date().toISOString()});client.changed();
  await page.evaluate(({id,provider})=>{localStorage.setItem('hydraq.conversation',id);localStorage.setItem('hydraq.provider',provider);}, {id:c.id,provider});await page.reload();
  const panel=page.locator('#messages #progress-panel');await panel.waitFor();
  check(provider+' card follows its current request',await page.locator('.message.user').filter({hasText:'Pedido atual '+provider}).evaluate(el=>el.nextElementSibling?.id==='progress-panel'));
  check(provider+' old request has no current card',await page.locator('.message.user').filter({hasText:'Pedido anterior '+provider}).evaluate(el=>el.nextElementSibling?.id!=='progress-panel'));
  check(provider+' no card at top of conversation',await page.locator('.conversation-panel > #progress-panel').count()===0);
  check(provider+' public commentary visible',await panel.locator('.progress-commentary').textContent().then(t=>t.includes('Vou verificar as fontes de '+provider)));
  await panel.locator('summary').click();c.items[0].status='completed';client.changed();
  await page.waitForFunction(()=>document.querySelector('#progress-panel .progress-actions li')?.dataset.status==='completed');
  check(provider+' actions stay open after update',await panel.locator('details').evaluate(el=>el.open));
  c.messages.push({id:'steer-'+provider,role:'user',kind:'steer',delivery:'accepted',turnId:c.turnId,requestId:'steer-'+provider,text:'Orientação adicional.',at:new Date().toISOString()});client.changed();
  await page.getByText('Orientação adicional.',{exact:true}).waitFor();
  check(provider+' steer does not take card from original request',await page.locator('.message.user').filter({hasText:'Pedido atual '+provider}).evaluate(el=>el.nextElementSibling?.id==='progress-panel'));
  client.finish(c,'Resposta final '+provider);await page.waitForFunction(()=>document.querySelector('#progress-panel')?.dataset.status==='completed');
  check(provider+' completed card keeps request anchor',await page.locator('.message.user').filter({hasText:'Pedido atual '+provider}).evaluate(el=>el.nextElementSibling?.id==='progress-panel'));
 }
 // A request HYDRAQ makes itself (memory proposal, handoff summary) shows as a note; the card follows it.
 const internal={model:'test',effort:'low',sandbox:'plan'},ic=await clients.claude.create({cwd:root,...internal});ic.title='Pedido interno';
 await hub.send(ic.id,'Pedido normal','internal-old',internal);await wait(()=>ic.status==='running');clients.claude.finish(ic,'Feito.');
 await hub.send(ic.id,'Propõe memória','internal-now',{...internal,internal:'memory-proposal'});await wait(()=>ic.status==='running');
 ic.messages.at(-1).internal='memory-proposal';ic.items.push({id:'internal-action',turnId:ic.turnId,type:'mcpToolCall',tool:'Read',server:'claude',status:'inProgress',at:new Date().toISOString()});clients.claude.changed();
 await page.evaluate(id=>{localStorage.setItem('hydraq.conversation',id);localStorage.setItem('hydraq.provider','claude');},ic.id);await page.reload();
 await page.locator('#messages #progress-panel').waitFor();
 check('internal request card follows its note',await page.locator('.handoff-note').evaluate(el=>el.nextElementSibling?.id==='progress-panel'&&!document.querySelector('#progress-panel').classList.contains('hidden')));
 // Without its request in the transcript, the card keeps its old place above it instead of disappearing.
 ic.messages.splice(ic.messages.findIndex(m=>m.requestId==='internal-now'),1);clients.claude.changed();
 check('card without its request stays above the transcript',await page.waitForFunction(()=>{const p=document.querySelector('.conversation-panel > #progress-panel');return p&&p.nextElementSibling?.id==='hydra-inline'&&!p.classList.contains('hidden')&&p.querySelector('strong')?.textContent==='A ler';},null,{timeout:5000}).then(()=>true,()=>false));
 clients.claude.finish(ic,'Proposta.');
 const dc=await clients.codex.create({cwd:root,model:'test',effort:'low',sandbox:'read-only'});
 const {dual}=await hub.startDual(dc.id,{provider:'claude',model:'test',effort:'low'});
 await hub.sendDual(dual.id,{requestId:'dual-progress',text:'Pedido comum Dual'});
 const other=clients.claude.conversation(dual.members.b.conversationId);await wait(()=>dc.status==='running'&&other.status==='running');
 await page.evaluate(id=>{localStorage.setItem('hydraq.conversation',id);localStorage.setItem('hydraq.provider','codex');},dc.id);await page.reload();
 await page.locator('#messages #progress-panel').waitFor();
 check('Dual card follows shared request',await page.locator('.message.user').filter({hasText:'Pedido comum Dual'}).evaluate(el=>el.nextElementSibling?.id==='progress-panel'));
 clients.codex.finish(dc,'Primeira resposta terminada.');
 await page.waitForFunction(()=>document.querySelector('#progress-panel strong')?.textContent.includes('Claude'));
 check('Dual other participant keeps card under shared request',await page.locator('.message.user').filter({hasText:'Pedido comum Dual'}).evaluate(el=>el.nextElementSibling?.id==='progress-panel'));
 clients.claude.finish(other,'Segunda resposta terminada.');await wait(()=>other.status==='completed');
 for(const theme of ['classic','atelier','mono']){
  await page.evaluate(theme=>localStorage.setItem('hydraq.theme',theme),theme);await page.reload();await page.locator('#messages #progress-panel').waitFor();
  for(const width of [1440,390]){await page.setViewportSize({width,height:900});check(theme+' '+width+' no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('#progress-panel').scrollIntoViewIfNeeded();await page.screenshot({path:out+'/'+theme+'-'+width+'.png'});}
 }
 check('no JavaScript errors',!errors.length);
 console.log(JSON.stringify({out,passed:results.length,errors}));
}finally{await writeFile(out+'/verification.json',JSON.stringify({results,errors},null,2));await browser?.close();if(server){server.closeStreams();await new Promise(r=>server.close(r));}await hub.close();await rm(root,{recursive:true,force:true});}
