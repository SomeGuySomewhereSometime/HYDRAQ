// Temp-only browser proof: fake clients, real private copies, validation commands and application.
// Recovery, Git confirmation and retained-copy actions exercise real coordinator states and browser clicks.
// node validation/hydra-workspace-ui.mjs /tmp/hydra-workspace-ui-proof
import {access,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {Providers} from '../lib/providers.mjs';
import {OpinionClient} from '../test/fixtures/opinion-client.mjs';
import {createHttpServer} from '../lib/http.mjs';
import {verifyWorkspaceRecovery} from './hydra-workspace-scenarios.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.resolve(process.argv[2]||await mkdtemp('/tmp/hydra-workspace-ui-proof-'));
if(!out.startsWith('/tmp/'))throw Error('Os artefactos desta validação têm de ficar em /tmp.');
await mkdir(out,{recursive:true});
const root=await mkdtemp('/tmp/hydra-workspace-ui-'),cwd=path.join(root,'project');
await mkdir(cwd);await writeFile(path.join(cwd,'value.txt'),'before');
const clients=Object.fromEntries(['codex','claude','antigravity','cursor','opencode'].map(role=>[role,new OpinionClient(role,path.join(root,role),{behavior:'hold'})]));
const hub=new Providers({dataDir:path.join(root,'hub'),defaultCwd:cwd,clients,git:async()=>[]});
const checks=[],errors=[],posts=[];
const check=(name,ok,evidence='fake-client workflow')=>{checks.push({name,ok:Boolean(ok),evidence});if(!ok)throw Error(name);};
const until=async(fn,label='condição')=>{const end=Date.now()+15000;while(!await fn()){if(Date.now()>end)throw Error('Timeout: '+label);await new Promise(resolve=>setTimeout(resolve,20));}};
const exists=file=>access(file).then(()=>true,()=>false),original=()=>readFile(path.join(cwd,'value.txt'),'utf8');
let server,browser,page,capability=false,task;
try{
 await hub.load();await hub.connectAll();
 const cx=hub.claudex,snapshot=hub.snapshot.bind(hub);
 hub.snapshot=()=>{
  const state=snapshot();
  if(!capability)delete state.claudex.workspaceModes;
  return state;
 };
 const normal=await hub.create({provider:'codex',cwd,model:'test',effort:'low',sandbox:'workspace-write'});
 server=createHttpServer({hydraq:hub,publicDir:path.join(repo,'public')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
 page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.setDefaultTimeout(12000);
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/claudex')posts.push(request.postDataJSON());});
 await page.addInitScript(id=>{
  if(sessionStorage.getItem('workspace-proof-seeded'))return;
  localStorage.setItem('hydraq.theme','atelier');localStorage.setItem('hydraq.conversation',id);
  localStorage.setItem('hydraq.mascot.animation','off');sessionStorage.setItem('workspace-proof-seeded','1');
 },normal.id);
 await page.goto(url);await page.locator('#tab-claudex').click();
 const workspace=page.locator('#cx-workspace'),copyOption=workspace.locator('option[value="copy"]');
 check('o projeto é a escolha inicial',await workspace.inputValue()==='direct');
 check('servidor sem capacidade desativa a cópia',await copyOption.evaluate(option=>option.disabled),'compatibility response fixture');
 capability=true;hub.emit('state',hub.snapshot());
 await until(()=>copyOption.evaluate(option=>!option.disabled),'capacidade de cópia');
 check('a capacidade anunciada permite escolher a cópia',await copyOption.evaluate(option=>!option.disabled));
 // Dedicated tab: a read-only request remembers the preference but creates no private directory.
 await workspace.selectOption('copy');await page.locator('#cx-cwd').fill(cwd);
 await page.locator('#cx-requestMode').selectOption('read-only');
 check('só análise e planeamento bloqueia a escolha de local',await workspace.isDisabled());
 await page.locator('#cx-prompt').fill('Apenas analisa value.txt, sem implementar alterações.');
 await page.locator('#claudex-view .cx-composer button.primary').click();
 await until(()=>cx.records.length===1,'tarefa só leitura');const readonly=cx.records[0];
 await page.locator('#claudex-view .cx-workspace-state',{hasText:'Só análise e planeamento'}).waitFor();
 check('o separador envia a escolha de cópia e dois clientes',posts[0].workspace==='copy'&&posts[0].roles.length===2);
 check('só leitura não cria uma cópia',readonly.workspaceMode==='copy'&&!readonly.workspace&&await original()==='before');
 check('uma tarefa existente bloqueia o seletor',await workspace.isDisabled());
 await page.reload();await page.locator('#tab-claudex').click();
 await until(async()=>await workspace.inputValue()==='copy'&&await workspace.isDisabled(),'escolha recuperada');
 check('recarregar recupera a escolha sem criar outra tarefa',cx.records.length===1);
 await cx.stop(readonly.id);await cx.pauseDrains.get(readonly.id);
 // Old persisted tasks have neither field. Only their presentation is changed here.
 const savedMode=readonly.workspaceMode;delete readonly.workspaceMode;await cx.persist();
 await page.reload();await page.locator('#tab-claudex').click();
 await until(async()=>await workspace.inputValue()==='direct','tarefa antiga em modo projeto');
 check('tarefas antigas sem campos de cópia aparecem no projeto',await workspace.inputValue()==='direct','legacy task fixture');
 readonly.workspaceMode=savedMode;await cx.persist();
 await page.getByRole('button',{name:'＋ Nova tarefa Hydra',exact:true}).click();
 check('uma tarefa nova volta ao projeto',await workspace.inputValue()==='direct');
 // An actual trio from the conversation, using the copy throughout the full workflow.
 await page.locator('#tab-conversations').click();
 await page.evaluate(id=>localStorage.setItem('hydraq.conversation',id),normal.id);await page.reload();
 await page.locator('.mode-tile[data-mode="hydra"]').click();
 await page.locator('[data-pair="codex+claude+antigravity"]').click();
 const workspaceChips=page.locator('#mode-setup .mode-field').filter({has:page.locator('.mode-field-label',{hasText:'Local de trabalho'})});
 await workspaceChips.getByRole('button',{name:'Cópia privada',exact:true}).click();
 check('a escolha no painel Modo acompanha o seletor',await workspace.inputValue()==='copy');
 check('o Hydra oferece apenas pares e trio válidos',await page.locator('.hydra-pair').count()===4&&await page.locator('.mode-hydra .mode-participant:visible').count()===3);
 await page.locator('#prompt').fill('Implementa a alteração de value.txt para after e testa.');await page.locator('#send').click();
 await until(()=>cx.records.length===2,'tarefa na conversa');task=cx.records[1];
 await until(()=>task.roles.every(role=>cx.native(task,role).status==='running'),'clientes na fase inicial');
 check('a conversa envia cópia privada com os três clientes',posts[1].workspace==='copy'&&posts[1].roles.length===3&&task.workspaceMode==='copy');
 check('os clientes trabalham na cópia e conhecem a origem',task.roles.every(role=>cx.native(task,role).cwd===task.workspace.copy&&cx.native(task,role).workspaceOrigin===cwd));
 await page.locator('#hydra-inline .cx-workspace-state',{hasText:'Trabalho na cópia privada'}).waitFor();
 check('o painel identifica o projeto original',await page.locator('#hydra-inline .cx-workspace-project').textContent()===cwd);
 check('a pasta visível da conversa mostra a origem',!(await page.locator('#folder-chip').getAttribute('data-tip')).includes(task.workspace.copy)&&(await page.locator('#folder-chip').getAttribute('data-tip')).includes(cwd));
 await page.screenshot({path:path.join(out,'copy-planning-1440.png')});
 await page.setViewportSize({width:390,height:900});
 check('sem overflow durante o trabalho na cópia a 390px',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'responsive UI');
 await page.screenshot({path:path.join(out,'copy-planning-390.png')});await page.setViewportSize({width:1440,height:1000});
 await page.reload();await page.locator('#hydra-inline .cx-workspace-state',{hasText:'Trabalho na cópia privada'}).waitFor();
 check('a conversa recupera a cópia bloqueada ao recarregar',await workspace.inputValue()==='copy'&&await workspace.isDisabled());
 const call=(role,name,args={})=>cx.tool([...cx.leases].find(([,lease])=>lease.taskId===task.id&&lease.role===role)?.[0],name,args);
 const read=role=>call(role,'read_dialogue');
 const finish=()=>{for(const role of task.roles)clients[role].finish(cx.native(task,role),'Fim do turno simulado.');};
 const phase=next=>until(()=>task.workflow.phase===next&&task.roles.filter(role=>!['implementing','fixing','finalizing'].includes(next)||role===task.author).every(role=>cx.native(task,role).status==='running'),next);
 const candidate=async text=>{for(const role of task.roles)if(task.ready[role]!==task.evidenceRevision){await until(()=>cx.native(task,role).status==='running','turno '+role);await call(role,'ready_to_conclude',await read(role));}return (await call(task.author,'propose_final',{...await read(task.author),text})).candidate;};
 const vote=async proposal=>{for(const role of task.roles){await until(()=>cx.native(task,role).status==='running','voto '+role);await call(role,'review_final',{...await read(role),candidateId:proposal.id,hash:proposal.hash,decision:'approve'});}};
 for(const role of task.roles)await call(role,'initial_position',{text:'Alterar e testar value.txt.',intent:'implement',authorizationQuote:task.messages[0].text,revision:task.revision});
 await vote(await candidate('Plano: alterar value.txt e testar o seu conteúdo.'));finish();await phase('implementing');
 await writeFile(path.join(task.workspace.copy,'value.txt'),'after');
 check('o original fica intacto durante a implementação',await original()==='before');
 await call(task.author,'implementation_done',{...await read(task.author),summary:'value.txt alterado apenas na cópia.'});finish();await phase('validating');
 const ids={};
 for(const role of task.roles){
  ids[role]=(await call(role,'start_test',{messageId:'workspace-test-'+role,command:'test "$(cat value.txt)" = after',purpose:'Verificar a versão preparada.'})).test.id;
  await until(()=>task.workflow.tests.find(test=>test.id===ids[role]).status!=='running','teste '+role);
 }
 check('os testes dos três clientes passam na versão preparada',task.workflow.tests.length===3&&task.workflow.tests.every(test=>test.status==='passed'));
 check('o original fica intacto durante a revisão e os testes',await original()==='before');
 for(const role of task.roles){await call(role,'read_changes');await call(role,'submit_review',{...await read(role),decision:'approve',reason:'Conteúdo confirmado pelo teste.',testIds:[ids[role]]});}
 finish();await phase('finalizing');
 check('a revisão concluída ainda não aplica ao projeto',await original()==='before');
 const final=await candidate('Alteração de value.txt concluída e testada por todos.');
 cx.applyEnvironment={HYDRAQ_APPLY_HOLD_AT:'temporary'};await vote(final);finish();
 await until(()=>exists(path.join(task.workspace.folder,'aplicacao','parado')),'aplicação retida antes da primeira escrita');
 await page.locator('#hydra-inline .cx-workspace-state',{hasText:'A aplicar ao projeto'}).waitFor();
 check('a aplicação real tem estado próprio antes de escrever',task.workspace.applying&&await original()==='before');
 check('durante a aplicação o envio e a pausa aguardam o fim',await page.locator('#send').isDisabled()&&await page.locator('#stop').isDisabled());
 check('durante a aplicação não promete desfazer uma operação em curso',await page.getByRole('button',{name:'Parar e desfazer aplicação',exact:true}).count()===0||!await page.getByRole('button',{name:'Parar e desfazer aplicação',exact:true}).isVisible());
 await page.screenshot({path:path.join(out,'applying-1440.png')});
 await writeFile(path.join(task.workspace.folder,'aplicacao','continua'),'');
 await until(()=>task.status==='completed'&&task.released,'conclusão e devolução da conversa');delete cx.applyEnvironment;
 check('o resultado só chega ao original depois da aprovação final',await original()==='after'&&task.workspace.applied.files.includes('value.txt'));
 check('a conversa regressa ao projeto quando termina',task.roles.every(role=>cx.native(task,role).cwd===cwd&&!cx.native(task,role).workspaceOrigin));
 const history=page.locator(`.cx-card[data-task="${task.id}"]`);
 await history.locator('> summary').click();await history.locator('.cx-workspace-state',{hasText:'Aplicado ao projeto'}).waitFor();
 check('o cartão histórico conserva a informação de aplicação',await history.locator('.cx-workspace-project').textContent()===cwd);
 await page.reload();await history.locator('> summary').click();await history.locator('.cx-workspace-state',{hasText:'Aplicado ao projeto'}).waitFor();
 check('a aplicação continua visível no histórico após recarregar',true);
 await page.screenshot({path:path.join(out,'applied-history-1440.png')});
 let failedHistory=false;
 const detailPattern='**/api/claudex/'+task.id;
 await page.route(detailPattern,async route=>{
  if(route.request().method()==='GET'&&!failedHistory){failedHistory=true;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Falha temporária simulada ao carregar a tarefa.'})});}
  else await route.continue();
 });
 await page.reload();await history.locator('> summary').click();
 await history.getByRole('button',{name:'Tentar carregar novamente',exact:true}).click();
 await history.locator('.cx-workspace-state',{hasText:'Aplicado ao projeto'}).waitFor();
 check('o histórico recupera a informação da cópia depois de um erro temporário',failedHistory,'HTTP 503 fault injection');
 await page.unroute(detailPattern);
 checks.push(...await verifyWorkspaceRecovery(browser,out));
 await page.locator('#tab-claudex').click();
 await page.locator('#claudex-view .cx-workspace-state',{hasText:'Aplicado ao projeto'}).waitFor();
 let releaseRead,delayedDone=false;
 await page.route('**/api/claudex/'+readonly.id,async route=>{await new Promise(resolve=>releaseRead=resolve);await route.continue();delayedDone=true;});
 await page.locator('#claudex-view .cx-history nav button').filter({hasText:readonly.title}).click();await until(()=>Boolean(releaseRead),'carregamento atrasado da outra tarefa');
 check('mudar de tarefa limpa o estado anterior enquanto carrega',await page.locator('#claudex-view .cx-workspace-state').count()===0,'delayed task detail response');
 releaseRead();await until(()=>delayedDone,'resposta atrasada terminada');await page.unroute('**/api/claudex/'+readonly.id);await page.locator('#claudex-view .cx-workspace-state').waitFor();
 await page.locator('#claudex-view .cx-history nav button').filter({hasText:task.title}).click();await page.locator('#claudex-view .cx-workspace-state',{hasText:'Aplicado ao projeto'}).waitFor();
 for(const [theme,width] of [['atelier',1440],['mono',390],['classic',1024]]){
  await page.evaluate(theme=>{document.body.dataset.theme=theme;},theme);await page.setViewportSize({width,height:900});
  await page.screenshot({path:path.join(out,`${theme}-${width}.png`)});
  check('sem overflow no separador '+theme+' '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'responsive UI');
 }
 await page.setViewportSize({width:390,height:900});await page.evaluate(id=>localStorage.setItem('hydraq.conversation',id),normal.id);await page.reload();await page.locator('#tab-conversations').click();
 await history.locator('> summary').click();await history.locator('.cx-workspace-state',{hasText:'Aplicado ao projeto'}).waitFor();
 check('sem overflow no histórico a 390px',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'responsive UI');
 await page.screenshot({path:path.join(out,'applied-history-390.png')});
 check('sem erros JavaScript',errors.length===0,'browser runtime');
}catch(error){checks.push({name:'validação completa',ok:false,error:error.stack,evidence:'harness'});console.error(error);if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{
 await browser?.close();server?.closeStreams();if(server)await new Promise(resolve=>server.close(resolve));
 await hub.close();await rm(root,{recursive:true,force:true});
 await writeFile(path.join(out,'summary.json'),JSON.stringify({checks,errors,posts,evidence:{workflow:'Fake OpinionClient clients with real temporary private copy, bubblewrap tests and file application.',recovery:'Real stopped writer, conflicts, Git confirmation, pre-plan error and retained-copy actions; no staged recovery responses.'}},null,2));
 console.log(JSON.stringify({passed:checks.filter(check=>check.ok).length,failed:checks.filter(check=>!check.ok).length,out}));
 if(checks.some(check=>!check.ok))process.exitCode=1;
}
