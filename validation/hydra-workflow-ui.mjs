import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {Providers} from '../lib/providers.mjs';
import {OpinionClient} from '../test/fixtures/opinion-client.mjs';
import {createHttpServer} from '../lib/http.mjs';
const root=await mkdtemp('/tmp/hydra-workflow-ui-'),cwd=root+'/project',out=path.resolve(process.argv[2]||'output/hydra-workflow-ui');await mkdir(cwd);await mkdir(out,{recursive:true});await writeFile(cwd+'/value.txt','before');
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
 check('trio selecionável na conversa',await page.locator('[data-pair="codex+claude+antigravity"]').getAttribute('aria-pressed')==='true');
 check('três modelos no painel',await page.locator('.mode-hydra .mode-participant:visible').count()===3);
 await page.locator('.mode-hydra .mode-field').filter({has:page.locator('.mode-field-label',{hasText:'Principal · coordena o plano e a conclusão'})}).locator('[data-value="claude"]').click();
 await page.locator('#prompt').fill('Implementa a alteração de value.txt para after e testa.');await page.locator('#send').click();
 await until(()=>hub.claudex.records.length===1);const r=hub.claudex.records[0],cx=hub.claudex;
 await until(()=>r.roles.every(k=>cx.native(r,k).status==='running'));check('tarefa usa três modelos e principal escolhido',r.roles.length===3&&r.author==='claude'&&r.workflow.version===2);
 const call=(role,name,args={})=>cx.tool([...cx.leases].find(([,l])=>l.taskId===r.id&&l.role===role)[0],name,args),read=k=>call(k,'read_dialogue'),finish=()=>{for(const role of r.roles)clients[role].finish(cx.native(r,role),'Fim');};
 const candidate=async()=>{for(const role of r.roles)if(r.ready[role]!==r.evidenceRevision){await until(()=>cx.native(r,role).status==='running');await call(role,'ready_to_conclude',await read(role));}return (await call(r.author,'propose_final',{...await read(r.author),text:'Alterar value.txt e testar o resultado.'})).candidate;};
 const votes=async c=>{for(const role of r.roles){await until(()=>cx.native(r,role).status==='running');await call(role,'review_final',{...await read(role),candidateId:c.id,hash:c.hash,decision:role==='antigravity'?'changes':'approve',reason:role==='antigravity'?'Prefiro outra abordagem.':'Concordo.'});}finish();await until(()=>r.workflow.objection&&cx.native(r,r.author).status==='running');await call(r.author,'answer_objection',{...await read(r.author),decision:'keep',reason:'Mantenho: é o que o pedido descreve.'});finish();};
 for(const role of r.roles)await call(role,'initial_position',{text:'Posição '+role,intent:'implement',authorizationQuote:r.messages[0].text});await votes(await candidate());
 await until(()=>r.workflow.phase==='implementing'&&cx.native(r,'claude').status==='running');await page.locator('.cx-badge',{hasText:'Implementação por etapas'}).waitFor();
 check('fase de implementação visível',await page.locator('#hydra-inline .cx-participant').count()===3);
 await page.screenshot({path:out+'/implementing-1440.png'});
 await writeFile(cwd+'/value.txt','after');await call('claude','implementation_done',{...await read('claude'),summary:'Alteração aplicada.'});finish();await until(()=>r.workflow.phase==='validating'&&r.roles.every(k=>cx.native(r,k).status==='running'));
 const ids={};for(const role of r.roles)ids[role]=(await call(role,'start_test',{messageId:'test',command:'test "$(cat value.txt)" = after',purpose:'Confirmar o conteúdo.'})).test.id;await until(()=>r.workflow.tests.every(t=>t.status==='passed'));
 // A mistaken command, replaced with a reason: it stays visible.
 const mistake=(await call('claude','start_test',{messageId:'engano',command:'grep -q nada value.txt',purpose:'Procurar um texto.'})).test;await until(()=>r.workflow.tests.find(t=>t.id===mistake.id).status==='failed');
 const replacement=(await call('claude','start_test',{messageId:'corrige',command:'test -f value.txt',purpose:'Confirmar o ficheiro.',supersedes:mistake.id,supersedeReason:'O grep procurava outro texto.'})).test;await until(()=>r.workflow.tests.find(t=>t.id===replacement.id).status==='passed');
 for(const role of r.roles){await call(role,'read_changes');await call(role,'submit_review',{...await read(role),decision:'approve',reason:'Verificado.',testIds:[ids[role],...(role==='claude'?[replacement.id]:[])]});}
 await page.locator('.cx-badge',{hasText:'Revisão e testes de todos'}).waitFor();await page.locator('#hydra-inline .cx-participant small',{hasText:'(substituído)'}).waitFor();
 // The page renders the tests as their results arrive: wait for all four, do not count once.
 check('resultados de testes visíveis, com o teste substituído',await page.waitForFunction(()=>[...document.querySelectorAll('#hydra-inline .cx-participant small')].filter(e=>e.textContent.includes('Teste: Passou')).length===4,null,{timeout:5000}).then(()=>true,()=>false));
 await page.screenshot({path:out+'/validation-1440.png'});finish();await until(()=>r.workflow.phase==='finalizing'&&cx.native(r,r.author).status==='running');await votes(await candidate());await until(()=>r.status==='completed');
 await page.locator('.cx-card-state',{hasText:'Aprovado por maioria'}).waitFor();check('conclusão identifica maioria',true);
 await page.reload();await page.locator('.cx-card-state',{hasText:'Aprovado por maioria'}).waitFor();check('histórico preservado ao recarregar',true);
 await page.locator('.cx-card > summary').click();await page.locator('.cx-card').getByText('Revisão e testes · ronda 1',{exact:true}).waitFor({state:'attached'});check('evidência de revisão disponível no histórico',true);
 await page.locator('.cx-card').getByText('Substitui um teste anterior: O grep procurava outro texto.').waitFor({state:'attached'});check('motivo da substituição no histórico',true);
 for(const [theme,width] of [['atelier',1440],['mono',390],['classic',1024]]){
  await page.evaluate(theme=>{document.body.dataset.theme=theme;},theme);await page.setViewportSize({width,height:900});await page.screenshot({path:out+'/'+theme+'-'+width+'.png'});
  check('sem overflow '+theme+' '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 }
 check('sem erros JavaScript',errors.length===0);
}catch(error){checks.push({name:'fluxo completo',ok:false,error:error.message});console.error(error);}
finally{await browser?.close();server?.closeStreams();if(server)await new Promise(r=>server.close(r));await hub.close();await rm(root,{recursive:true,force:true});await writeFile(out+'/summary.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).length,out}));if(checks.some(c=>!c.ok))process.exitCode=1;}
