// Browser with simulated clients: a native question during the implementation, a replan and the finished task.
// node validation/hydra-clarification-ui.mjs [output-directory]
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {Providers} from '../lib/providers.mjs';
import {OpinionClient} from '../test/fixtures/opinion-client.mjs';
import {createHttpServer} from '../lib/http.mjs';
const root=await mkdtemp('/tmp/hydra-clarification-ui-'),cwd=root+'/project',out=path.resolve(process.argv[2]||'output/hydra-clarification-ui');await mkdir(cwd);await mkdir(out,{recursive:true});await writeFile(cwd+'/value.txt','before');
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
 await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('.mode-tile[data-mode="hydra"]').click();await page.locator('[data-pair="codex+claude+antigravity"]').click();
 await page.locator('.mode-hydra .mode-field').filter({has:page.locator('.mode-field-label',{hasText:'Principal · único implementador'})}).locator('[data-value="claude"]').click();
 await page.locator('#prompt').fill('Implementa a alteração de value.txt para after e testa.');await page.locator('#send').click();
 await until(()=>hub.claudex.records.length===1);const r=hub.claudex.records[0],cx=hub.claudex,request=r.messages[0].text;
 await until(()=>r.roles.every(k=>cx.native(r,k).status==='running'));
 const call=(role,name,args={})=>cx.tool([...cx.leases].find(([,l])=>l.taskId===r.id&&l.role===role)[0],name,args),read=k=>call(k,'read_dialogue'),finish=()=>{for(const role of r.roles)clients[role].finish(cx.native(r,role),'Fim');};
 const positions=async intent=>{for(const role of r.roles)await call(role,'initial_position',{text:'Posição '+role,intent,authorizationQuote:request,revision:r.revision});};
 const agree=async text=>{for(const role of r.roles)await call(role,'ready_to_conclude',await read(role));const c=(await call(r.author,'propose_final',{...await read(r.author),text})).candidate;for(const role of r.roles)await call(role,'review_final',{...await read(role),candidateId:c.id,hash:c.hash,decision:'approve'});finish();};
 await positions('implement');await agree('Alterar value.txt e testar o resultado.');
 await until(()=>r.workflow.phase==='implementing'&&cx.native(r,'claude').status==='running');await page.locator('.cx-badge',{hasText:'Principal a implementar'}).waitFor();

 clients.claude.approvals.set('q1',{id:'q1',method:'claude/askUserQuestion',conversationId:cx.native(r,'claude').id,params:{questions:[{question:'Qual o formato?',header:'Formato',options:[{label:'Texto simples'}]}]}});
 await hub.respond('claude:q1',{decision:'accept',answers:{'Qual o formato?':'Texto simples'}});
 await writeFile(cwd+'/value.txt','parcial');
 const messages=page.locator('#hydra-inline .cx-messages');
 await messages.getByText('Pergunta de Claude: Qual o formato?').waitFor();
 check('esclarecimento identificado na tarefa',await page.locator('#hydra-inline .cx-message',{hasText:'Tu · Esclarecimento'}).isVisible());
 check('pergunta e resposta legíveis',await messages.getByText('Resposta: Texto simples').isVisible());
 const visible=()=>page.locator('#messages').innerText();
 check('sem JSON cru na conversa',!/"decision"|"answers"/.test(await visible()));
 check('esclarecimento não aparece como pedido',await page.locator('.hydra-request').count()===1);
 await page.screenshot({path:out+'/clarification-1440.png'});

 // The principal's stop is held so that the state between the request and the new plan can be seen.
 let release;const stopped=new Promise(resolve=>release=resolve),interrupt=clients.claude.interrupt.bind(clients.claude);clients.claude.interrupt=async id=>{await stopped;return interrupt(id);};
 await call('claude','request_replan',{answerSeq:r.messages.findLast(m=>m.type==='answer').seq,reason:'A resposta muda o formato.'});
 await page.locator('.cx-badge',{hasText:'A preparar novo plano'}).waitFor();check('estado próprio com replaneamento pendente',true);
 check('replaneamento com rótulo próprio',await page.locator('#hydra-inline .cx-message',{hasText:'Claude · Replaneamento'}).isVisible());
 release();clients.claude.interrupt=interrupt;
 await until(()=>r.workflow.phase==='planning'&&r.roles.every(k=>cx.native(r,k).status==='running'));await page.locator('.cx-badge',{hasText:'Plano em discussão'}).waitFor();check('volta ao plano depois de parar',true);
 await page.screenshot({path:out+'/replan-1440.png'});

 await positions('read-only');await agree('Resposta sem alterações.');await until(()=>r.status==='completed');
 const card=page.locator('.cx-card').first();await card.waitFor();
 await card.locator('.cx-card-state',{hasText:'alterações por validar'}).waitFor();check('cartão avisa das alterações por validar',true);
 await page.locator('#messages').getByText('nenhuma revisão validou').first().waitFor();check('conclusão avisa das alterações por validar',true);
 await card.locator('summary').click();
 await card.getByText('Pergunta de Claude: Qual o formato?').waitFor();check('esclarecimento visível no cartão terminado',true);
 check('um único pedido depois de concluir',await page.locator('.hydra-request').count()===1&&!/"decision"|"answers"/.test(await visible()));
 await page.reload();await page.locator('.cx-card').first().waitFor();
 check('sem JSON cru depois de recarregar',await page.locator('.hydra-request').count()===1&&!/"decision"|"answers"/.test(await visible()));
 await page.setViewportSize({width:390,height:900});await page.locator('.cx-card summary').first().click();await page.screenshot({path:out+'/finished-390.png'});
 check('sem overflow a 390 px',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 check('sem erros JavaScript',errors.length===0);
}catch(error){checks.push({name:'fluxo completo',ok:false,error:error.message});console.error(error);}
finally{await browser?.close();server?.closeStreams();if(server)await new Promise(r=>server.close(r));await hub.close();await rm(root,{recursive:true,force:true});await writeFile(out+'/summary.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).length,out}));if(checks.some(c=>!c.ok))process.exitCode=1;}
