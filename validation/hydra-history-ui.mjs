// In a real browser, with simulated clients: a finished task's long test output opens in full, and deleting the task leaves the conversation clean.
import {chmod,mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {Providers} from '../lib/providers.mjs';
import {OpinionClient} from '../test/fixtures/opinion-client.mjs';
import {createHttpServer} from '../lib/http.mjs';

const root=await mkdtemp('/tmp/hydra-history-ui-'),cwd=root+'/project',out=path.resolve(process.argv[2]||'output/hydra-history-ui');await mkdir(cwd);await mkdir(out,{recursive:true});await writeFile(cwd+'/value.txt','before');
const clients=Object.fromEntries(['codex','claude','antigravity','cursor','opencode'].map(k=>[k,new OpinionClient(k,root+'/'+k,{behavior:'hold'})]));
const hub=new Providers({dataDir:root+'/hub',defaultCwd:cwd,clients,git:async()=>[]});const checks=[],errors=[];
const check=(name,ok)=>{checks.push({name,ok:Boolean(ok)});if(!ok)console.error('FAIL '+name);};
const until=async(f,label='')=>{const end=Date.now()+15000;while(!f()){if(Date.now()>end)throw Error('Timeout '+label);await new Promise(r=>setTimeout(r,20));}};
let server,browser;
try{
 await hub.load();const normal=await hub.create({provider:'codex',cwd,model:'test',effort:'low',sandbox:'workspace-write'});
 server=createHttpServer({hydraq:hub,publicDir:path.resolve('public')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(id=>{localStorage.setItem('hydraq.theme','atelier');localStorage.setItem('hydraq.conversation',id);localStorage.setItem('hydraq.mascotAnimation','false');},normal.id);
 await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('.mode-tile[data-mode="hydra"]').click();
 await page.locator('[data-pair="codex+claude+antigravity"]').click();
 await page.locator('#prompt').fill('Implementa a alteração de value.txt para after e testa.');await page.locator('#send').click();
 await until(()=>hub.claudex.records.length===1);const r=hub.claudex.records[0],cx=hub.claudex,id=r.id;
 await until(()=>r.roles.every(k=>cx.native(r,k).status==='running'));
 const call=(role,name,args={})=>cx.tool([...cx.leases].find(([,l])=>l.taskId===r.id&&l.role===role)[0],name,args),read=k=>call(k,'read_dialogue');
 const finish=()=>{for(const role of r.roles)clients[role].finish(cx.native(r,role),'Fim');};
 const turn=role=>until(()=>cx.native(r,role).status==='running','turno '+role);
 const conclude=async text=>{for(const role of r.roles)if(r.ready[role]!==r.evidenceRevision){await turn(role);await call(role,'ready_to_conclude',await read(role));}const c=(await call(r.author,'propose_final',{...await read(r.author),text})).candidate;for(const role of r.roles){await turn(role);await call(role,'review_final',{...await read(role),candidateId:c.id,hash:c.hash,decision:'approve'});}finish();};
 for(const role of r.roles)await call(role,'initial_position',{text:'Posição '+role,intent:'implement',authorizationQuote:r.messages[0].text});
 await conclude('Alterar value.txt e testar.');await until(()=>r.workflow.phase==='implementing'&&cx.native(r,r.author).status==='running','implementar');
 await writeFile(cwd+'/value.txt','after');await call(r.author,'implementation_done',{...await read(r.author),summary:'Feito.'});finish();
 await until(()=>r.workflow.phase==='validating'&&r.roles.every(k=>cx.native(r,k).status==='running'),'validar');
 const ids={};for(const role of r.roles)ids[role]=(await call(role,'start_test',{messageId:'longo',command:'test "$(cat value.txt)" = after && seq 1 9000',purpose:'Saída longa.'})).test.id;
 await until(()=>r.workflow.tests.every(t=>t.status!=='running'),'testes');
 check('a saída longa fica num ficheiro',r.workflow.tests.every(t=>t.outputFile&&t.output.length<=4200));
 for(const role of r.roles){let p=await call(role,'read_changes');while(!p.readComplete)p=await call(role,'read_changes',{offset:p.remaining.offset??0,fileOffset:p.remaining.fileOffset??0});await call(role,'submit_review',{...await read(role),decision:'approve',reason:'Verificado.',testIds:[ids[role]]});}
 finish();await until(()=>r.workflow.phase==='finalizing'&&cx.native(r,r.author).status==='running','concluir');
 await conclude('Alteração concluída e testada.');await until(()=>r.status==='completed'&&r.released,'terminar');

 const card=page.locator('.cx-card').first();await card.waitFor();await card.locator('> summary').click();
 await card.locator('.cx-draft > summary').click();await card.locator('details summary',{hasText:'Revisão e testes · ronda 1'}).click();
 const button=card.getByRole('button',{name:'Ver saída completa'}).first();await button.waitFor();
 check('o histórico mostra só o excerto antes de pedir',!(await card.locator('pre').allTextContents()).some(text=>text.includes('\n5000\n')));
 const outputFile=path.join(cx.outputDirectory(r),ids.codex+'.txt'),savedOutput=await readFile(outputFile,'utf8');await rm(outputFile);
 try{
  const failed=page.waitForResponse(response=>response.url().endsWith('/tests/'+ids.codex+'/output'));await button.click();
  check('uma saída completa perdida devolve erro explícito',(await failed).status()===409);
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Ver saída completa'&&!button.disabled));
  check('a falha conserva o botão para tentar novamente',await button.isEnabled());
  check('a falha conserva o excerto',!(await card.locator('pre').allTextContents()).some(text=>text.includes('\n5000\n')));
  await page.screenshot({path:out+'/saida-indisponivel-1440.png'});
 }finally{await writeFile(outputFile,savedOutput);}
 await button.click();await card.locator('pre',{hasText:'\n5000\n'}).first().waitFor();check('a saída completa abre no cartão',true);
 await page.screenshot({path:out+'/saida-1440.png'});

 let asked='';page.once('dialog',dialog=>{asked=dialog.message();dialog.dismiss();});
 await card.getByRole('button',{name:'Apagar tarefa'}).click();await new Promise(res=>setTimeout(res,300));
 check('apagar pede confirmação',/Apagar esta tarefa/.test(asked));check('recusar não apaga',hub.claudex.records.length===1);
 const outputs=path.dirname(cx.outputDirectory(r));await chmod(outputs,0);
 try{
  const failed=page.waitForResponse(response=>response.url().endsWith('/'+id+'/deleteTask'));page.once('dialog',dialog=>dialog.accept());await card.getByRole('button',{name:'Apagar tarefa',exact:true}).click();
  check('a limpeza recusada devolve erro explícito',(await failed).status()===409);
  await card.getByRole('button',{name:'Tentar apagar tarefa novamente'}).waitFor();
  check('a tarefa continua no cartão depois da falha',hub.claudex.records.length===1&&await card.count()===1);
  check('o cartão explica a limpeza incompleta',(await card.innerText()).includes('A limpeza ficou incompleta'));
  await page.screenshot({path:out+'/limpeza-incompleta-1440.png'});
 }finally{await chmod(outputs,0o700);}
 check('a falha não anuncia apagadas as saídas que continuam no disco',(await readdir(cx.outputDirectory(r))).length>0);
 page.once('dialog',dialog=>dialog.accept());await card.getByRole('button',{name:'Tentar apagar tarefa novamente'}).click();
 await until(()=>hub.claudex.records.length===0,'apagar');await page.locator('.cx-card').waitFor({state:'detached'});
 check('o cartão desaparece',await page.locator('.cx-card').count()===0);
 check('a saída deixa de estar no disco',!(await readdir(path.join(root,'hub/claudex/outputs')).catch(()=>[])).includes(id));
 // The page shows its welcome text until the first render: wait for the conversation itself.
 await page.reload();const published=await page.locator('#messages',{hasText:'Alteração concluída e testada.'}).waitFor({timeout:8000}).then(()=>true,()=>false);
 const shown=await page.locator('#messages').innerText();
 check('a resposta publicada continua na conversa',published);
 check('os pedidos internos do Hydra não aparecem',!/FASE ATUAL|Hydra: tarefa|continuação da tarefa/.test(shown));
 for(const [theme,width] of [['atelier',1440],['mono',390]]){
  await page.evaluate(theme=>{document.body.dataset.theme=theme;},theme);await page.setViewportSize({width,height:900});await page.screenshot({path:out+'/'+theme+'-'+width+'.png'});
  check('sem overflow '+theme+' '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 }
 check('sem erros JavaScript',errors.length===0);
}catch(error){checks.push({name:'fluxo completo',ok:false,error:error.message});console.error(error);}
finally{await browser?.close();server?.closeStreams();if(server)await new Promise(r=>server.close(r));await hub.close();await rm(root,{recursive:true,force:true});await writeFile(out+'/summary.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,total:checks.length,failed:checks.filter(c=>!c.ok)}));process.exitCode=checks.every(c=>c.ok)?0:1;}
