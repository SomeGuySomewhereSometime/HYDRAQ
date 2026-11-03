// In a real browser, with simulated clients: a user takes a stuck participant out of a paused trio and the other two finish the task.
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {Providers} from '../lib/providers.mjs';
import {OpinionClient} from '../test/fixtures/opinion-client.mjs';
import {createHttpServer} from '../lib/http.mjs';

const root=await mkdtemp('/tmp/hydra-participants-ui-'),cwd=root+'/project',out=path.resolve(process.argv[2]||'output/hydra-participants-ui');await mkdir(cwd);await mkdir(out,{recursive:true});await writeFile(cwd+'/value.txt','before');
const clients=Object.fromEntries(['codex','claude','antigravity','cursor','opencode'].map(k=>[k,new OpinionClient(k,root+'/'+k,{behavior:'hold'})]));
const hub=new Providers({dataDir:root+'/hub',defaultCwd:cwd,clients,git:async()=>[]});const checks=[],errors=[];
const check=(name,ok)=>{checks.push({name,ok:Boolean(ok)});if(!ok)console.error('FAIL '+name);};
const until=async f=>{const end=Date.now()+10000;while(!f()){if(Date.now()>end)throw Error('Timeout');await new Promise(r=>setTimeout(r,20));}};
let server,browser;
try{
 await hub.load();const normal=await hub.create({provider:'codex',cwd,model:'test',effort:'low',sandbox:'workspace-write'});
 server=createHttpServer({hydraq:hub,publicDir:path.resolve('public')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(id=>{localStorage.setItem('hydraq.theme','atelier');localStorage.setItem('hydraq.conversation',id);localStorage.setItem('hydraq.mascotAnimation','false');},normal.id);
 await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('.mode-tile[data-mode="hydra"]').click();
 await page.locator('[data-pair="codex+claude+antigravity"]').click();
 await page.locator('#prompt').fill('Implementa a alteração de value.txt para after e testa.');await page.locator('#send').click();
 await until(()=>hub.claudex.records.length===1);const r=hub.claudex.records[0],cx=hub.claudex;
 await until(()=>r.roles.every(k=>cx.native(r,k).status==='running'));
 const call=(role,name,args={})=>cx.tool([...cx.leases].find(([,l])=>l.taskId===r.id&&l.role===role)[0],name,args),read=k=>call(k,'read_dialogue');
 const finish=roles=>{for(const role of roles)clients[role].finish(cx.native(r,role),'Fim');};
 const card=page.locator('.cx-remove');
 check('com a tarefa a correr não há como retirar um participante',await card.count()===0);

 // Two have voted; agy thinks forever. The watchdog pauses and names it.
 for(const role of r.roles)await call(role,'initial_position',{text:'Posição '+role,intent:'implement',authorizationQuote:r.messages[0].text});
 for(const role of r.roles)await call(role,'ready_to_conclude',await read(role));
 const c=(await call(r.author,'propose_final',{...await read(r.author),text:'Alterar value.txt e testar o resultado.'})).candidate;
 for(const role of ['codex','claude'])await call(role,'review_final',{...await read(role),candidateId:c.id,hash:c.hash,decision:'approve'});
 finish(['codex','claude']);
 cx.agySilenceMs=500;
 await until(()=>r.status==='paused');await until(()=>!cx.pauseDrains.has(r.id));
 check('a vigilância pausa e diz quem',r.pause.kind==='stuck'&&r.pause.stuck==='antigravity');
 await page.locator('.cx-card > summary').first().click().catch(()=>{});
 await card.first().waitFor({state:'attached'});
 const buttons=await card.first().locator('button').allTextContents();
 check('oferece os dois que não são o principal, o preso primeiro',buttons.length===2&&/Antigravity.*preso/.test(buttons[0])&&/Claude/.test(buttons[1]));
 check('o principal não aparece na lista',!buttons.some(text=>/Codex/.test(text)));
 await card.first().evaluate(element=>{let parent=element.closest('details');while(parent){parent.open=true;parent=parent.parentElement?.closest('details');}});
 await card.first().scrollIntoViewIfNeeded();await page.screenshot({path:out+'/retirar-1440.png'});
 let asked='';page.once('dialog',dialog=>{asked=dialog.message();dialog.dismiss();});
 await card.first().locator('button').first().click();await new Promise(res=>setTimeout(res,300));
 check('pede confirmação',/Retirar Antigravity/.test(asked));check('recusar a confirmação não muda nada',r.roles.length===3);
 page.once('dialog',dialog=>dialog.accept());await card.first().locator('button').first().click();
 await until(()=>r.roles.length===2);await card.first().waitFor({state:'detached'});
 check('depois de retirar já não há nada a retirar',await card.count()===0);
 check('a conversa do retirado fica livre',!clients.antigravity.conversations.some(x=>x.claudexTask===r.id));
 await page.locator('.cx-message',{hasText:'foi retirado da tarefa pelo utilizador'}).first().waitFor({state:'attached'});check('o histórico regista quem o fez',true);

 // The other two carry on from the same vote.
 await cx.resume(r.id);await until(()=>r.workflow.phase==='implementing'&&cx.native(r,'codex').status==='running');
 check('os dois votos dados bastam a dois',r.workflow.approvedPlan.id===c.id);
 for(const [theme,width] of [['atelier',1440],['mono',390]]){
  await page.evaluate(theme=>{document.body.dataset.theme=theme;},theme);await page.setViewportSize({width,height:900});await page.screenshot({path:out+'/'+theme+'-'+width+'.png'});
  check('sem overflow '+theme+' '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 }
 check('sem erros JavaScript',errors.length===0);
}catch(error){checks.push({name:'fluxo completo',ok:false,error:error.message});console.error(error);}
finally{await browser?.close();server?.closeStreams();if(server)await new Promise(r=>server.close(r));await hub.close();await rm(root,{recursive:true,force:true});await writeFile(out+'/summary.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,total:checks.length,failed:checks.filter(c=>!c.ok)}));process.exitCode=checks.every(c=>c.ok)?0:1;}
