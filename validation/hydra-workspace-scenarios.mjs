// Real recovery/application states, temporary projects and simulated clients. Called by hydra-workspace-ui.mjs.
import {access,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Providers} from '../lib/providers.mjs';
import {OpinionClient} from '../test/fixtures/opinion-client.mjs';
import {createHttpServer} from '../lib/http.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));
export async function verifyWorkspaceRecovery(browser,out){
const exists=f=>access(f).then(()=>true,()=>false),read=f=>readFile(f,'utf8').catch(()=>null);
const wait=async(fn,label='condição',ms=20000)=>{const end=Date.now()+ms;while(!await fn()){if(Date.now()>end)throw Error('Timeout: '+label);await new Promise(r=>setTimeout(r,30));}};
const results=[];
async function scenario(name,options,fn){
 const root=await mkdtemp('/tmp/hydra-rev164-ui-'),cwd=root+'/project',checks=[],errors=[];await mkdir(cwd);await writeFile(cwd+'/value.txt','before');await options.prepare?.({root,cwd});
 const clients=Object.fromEntries(['codex','claude','antigravity','cursor','opencode'].map(k=>[k,new OpinionClient(k,root+'/'+k,{behavior:'hold'})]));
 const hub=new Providers({dataDir:root+'/hub',defaultCwd:cwd,clients,git:async()=>[]});let server,page;
 const check=(label,ok,detail)=>{checks.push({label,ok:Boolean(ok),...(ok||detail===undefined?{}:{detail})});console.log(`${ok?'OK   ':'FALHA'} ${name} · ${label}${ok||detail===undefined?'':' — '+String(detail).slice(0,260)}`);};
 try{
  await hub.load();await hub.connectAll();const cx=hub.claudex;cx.endpoint('http://127.0.0.1:1/api/claudex/tools');
  const roles=['codex','claude','antigravity'],request='Implementa a alteração de value.txt para after e testa.';
  const place=options.conversation?{conversationId:(await hub.create({provider:'codex',cwd,model:'test',effort:'low',sandbox:'workspace-write'})).id}:{cwd};
  const {task}=await cx.create({text:request,requestId:randomUUID(),roles,members:Object.fromEntries(roles.map(k=>[k,{model:'test',effort:'low'}])),author:'claude',workspace:'copy',...place}),r=cx.record(task.id);
  await wait(()=>roles.every(k=>cx.native(r,k).status==='running'),'arranque');
  const call=(role,tool,args={})=>cx.tool([...cx.leases].find(([,l])=>l.role===role&&l.taskId===r.id)?.[0],tool,args),dialogue=role=>call(role,'read_dialogue'),finish=()=>{for(const k of roles)clients[k].finish(cx.native(r,k),'Terminado.');};
  const inPhase=p=>wait(()=>r.workflow.phase===p&&roles.filter(k=>!['implementing','fixing','finalizing'].includes(p)||k===r.author).every(k=>cx.native(r,k).status==='running'),'fase '+p);
  const propose=async text=>{for(const role of roles)if(r.ready[role]!==r.evidenceRevision){await wait(()=>cx.native(r,role).status==='running','turno '+role);await call(role,'ready_to_conclude',await dialogue(role));}return (await call(r.author,'propose_final',{...await dialogue(r.author),text})).candidate;};
  const vote=async c=>{for(const role of roles){await wait(()=>cx.native(r,role).status==='running','voto '+role);await call(role,'review_final',{...await dialogue(role),candidateId:c.id,hash:c.hash,decision:'approve'});}finish();};
  const settled=()=>wait(()=>!r.pause?.draining&&!cx.pauseDrains.has(r.id)&&!cx.jobs.has(r.id)&&![...cx.dispatchOwners.values()].includes(r.id),'pausa concluída sem intervenção');
  for(const role of roles)await call(role,'initial_position',{text:'Posição',intent:'implement',authorizationQuote:request,revision:r.revision});
  await vote(await propose('Plano.'));await inPhase('implementing');
  await writeFile(r.workspace.copy+'/value.txt','after');await writeFile(r.workspace.copy+'/a-mais-longo.txt','a');await writeFile(r.workspace.copy+'/b-mais-longo.txt','b');
  await call('claude','implementation_done',{...await dialogue('claude'),summary:'Feito.'});finish();await inPhase('validating');
  const ids={};for(const role of roles)ids[role]=(await call(role,'start_test',{messageId:'c',command:'test "$(cat value.txt)" = after',purpose:'Verificar.'})).test.id;await wait(()=>r.workflow.tests.every(t=>t.status!=='running'),'testes');
  for(const role of roles){await call(role,'read_changes');await call(role,'submit_review',{...await dialogue(role),decision:'approve',reason:'Ok.',testIds:[ids[role]]});}finish();await inPhase('finalizing');
  const conclude=async()=>{await vote(await propose('Conclusão.'));};
  server=createHttpServer({hydraq:hub,publicDir:repo+'/public'});await new Promise(res=>server.listen(0,'127.0.0.1',res));
  page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({id,conversation})=>{localStorage.setItem('hydraq.theme','atelier');localStorage.setItem('hydraq.mascot.animation','off');localStorage.setItem('hydraq.claudex',id);if(conversation)localStorage.setItem('hydraq.conversation',conversation);},{id:r.id,conversation:place.conversationId||null});
  const open=async()=>{await page.goto('http://127.0.0.1:'+server.address().port);if(!options.conversation)await page.locator('#tab-claudex').click();};
  const view=options.conversation?'':'#claudex-view ';
  const ui={state:()=>page.locator(view+'.cx-workspace-state').first().textContent(),card:()=>page.locator(view+'.cx-workspace').first().textContent(),
   finish:()=>page.locator(view+'.cx-composer button',{hasText:/Parar e desfazer|Terminar tarefa/}).first(),send:()=>options.conversation?page.locator('#send'):page.locator('#claudex-view .cx-composer button.primary')};
  await fn({root,cwd,cx,r,hub,conclude,settled,page,open,ui,check,clients,roles,finish});
  check('sem erros de JavaScript',errors.length===0,errors.join(' | '));
  await page.screenshot({path:path.join(out,'real-'+name+'.png')});
 }catch(error){check('cenário sem exceção',false,error.message);if(page)await page.screenshot({path:path.join(out,'real-'+name+'-erro.png')}).catch(()=>{});}
 finally{await page?.close().catch(()=>{});server?.closeStreams?.();if(server)await new Promise(res=>server.close(res));await hub.close().catch(()=>{});await rm(root,{recursive:true,force:true}).catch(()=>{});}
 results.push({name,checks});
}
await scenario('parada-a-meio',{},async({cwd,cx,r,conclude,settled,open,ui,check})=>{
 cx.applyEnvironment={HYDRAQ_APPLY_STOP_AFTER:1};await conclude();await wait(()=>r.status==='paused','pausa');await settled();delete cx.applyEnvironment;
 check('o escritor parou mesmo a meio',await read(cwd+'/value.txt')==='after'&&!await exists(cwd+'/a-mais-longo.txt'));
 await open();await wait(async()=>/Aplicação por concluir/.test(await ui.state()),'estado na página');check('a página diz que a aplicação ficou por concluir',true);
 check('mostra a pasta de recuperação',(await ui.card()).includes('Pasta de recuperação'));check('oferece parar e desfazer',await ui.finish().textContent()==='Parar e desfazer aplicação',await ui.finish().textContent());
 await ui.finish().click();await wait(async()=>await read(cwd+'/value.txt')==='before','desfazer');await settled();check('o clique desfaz mesmo no projeto',true);
 await wait(async()=>/Trabalho guardado|Cópia privada em pausa/.test(await ui.state()),'estado depois de desfazer');const state=await ui.state();check('depois de desfazer, a página já não fala em aplicação a meio',!/por concluir|A aplicar/.test(state),state);
 check('o botão volta ao normal',!/desfazer/.test(await ui.finish().textContent().catch(()=>'')));
 await wait(()=>ui.send().isEnabled(),'retomar');await ui.send().click();await wait(()=>r.status==='completed','conclusão após retomar');check('retomar na página aplica até ao fim',await read(cwd+'/value.txt')==='after'&&await read(cwd+'/a-mais-longo.txt')==='a');
 await wait(async()=>/Aplicado ao projeto/.test(await ui.state()),'aplicado');check('a página mostra o resultado aplicado',/3 ficheiros/.test(await ui.card()),await ui.card());
});

await scenario('edicao-impede-desfazer',{},async({cwd,cx,r,conclude,settled,open,ui,check})=>{
 cx.applyEnvironment={HYDRAQ_APPLY_STOP_AFTER:1};await conclude();await wait(()=>r.status==='paused','pausa');await settled();delete cx.applyEnvironment;await writeFile(cwd+'/value.txt','EDIÇÃO TUA');
 await open();await wait(async()=>/Aplicação por concluir/.test(await ui.state()),'cartão');await ui.finish().click();await wait(()=>/parcialmente alterado/.test(r.error||''),'motivo');await settled();
 check('a edição fica',await read(cwd+'/value.txt')==='EDIÇÃO TUA');
 await wait(async()=>/desfazer/.test(await ui.finish().textContent()),'botão de desfazer');check('a página continua a oferecer desfazer',true);check('o erro diz onde está a recuperação',r.error.includes(r.workspace.folder));
 await writeFile(cwd+'/value.txt','after');await wait(()=>ui.send().isEnabled(),'retomar');await ui.send().click();await wait(()=>r.status==='completed','conclusão');check('resolvido, retomar acaba',await read(cwd+'/b-mais-longo.txt')==='b');
});

await scenario('conflito',{},async({cwd,r,conclude,settled,open,ui,check})=>{
 await writeFile(cwd+'/value.txt','EDIÇÃO TUA');await conclude();await wait(()=>r.status==='paused','pausa');await settled();await open();
 await wait(async()=>/Local de trabalho/.test(await ui.card()),'cartão');await wait(async()=>/Terminar tarefa/.test(await ui.finish().textContent()),'botão');const body=await ui.card();check('sem aplicação a meio, a página não diz que o projeto pode estar alterado',!/parcialmente/.test(body),body);check('o botão não fala em desfazer',!/desfazer/.test(await ui.finish().textContent()),await ui.finish().textContent());check('nada foi escrito',await read(cwd+'/value.txt')==='EDIÇÃO TUA'&&!await exists(cwd+'/a-mais-longo.txt'));
 check('o motivo nomeia o ficheiro',/value\.txt/.test(r.error),r.error);
 await writeFile(cwd+'/value.txt','before');await wait(()=>ui.send().isEnabled(),'retomar');await ui.send().click();await wait(()=>r.status==='completed','conclusão');check('resolvido, retomar aplica',await read(cwd+'/value.txt')==='after');
});

await scenario('confirmacao-git',{prepare:async({cwd})=>{execFileSync('git',['init','-q'],{cwd});execFileSync('git',['config','core.fsmonitor','./value.txt'],{cwd});}},async({cwd,r,conclude,settled,open,ui,check})=>{
 await conclude();await wait(()=>r.status==='paused','pausa');await settled();check('a pausa é a da confirmação',r.pause.kind==='workspace-reserved',r.pause.kind);check('nada foi escrito',await read(cwd+'/value.txt')==='before');
 await open();await wait(async()=>/Local de trabalho/.test(await ui.card()),'cartão');await wait(async()=>/Confirmar/.test(await ui.send().textContent()),'botão de confirmar',6000).catch(()=>{});const card=await ui.card();check('a página nomeia o ficheiro',card.includes('value.txt'),card);check('o botão é explícito',/Confirmar alterações e retomar/.test(await ui.send().textContent()),await ui.send().textContent());
 await wait(()=>ui.send().isEnabled(),'confirmar');await ui.send().click();await wait(()=>r.status==='completed','conclusão');check('confirmar aplica exatamente isso',await read(cwd+'/value.txt')==='after');
});

await scenario('erro-ao-aplicar',{},async({cwd,cx,r,conclude,settled,open,ui,check})=>{
 // A failure before anything is written: nothing on disk says the project changed.
 await rm(r.workspace.validated.directory+'.json');await conclude();await wait(()=>r.status==='paused','pausa');await settled();
 check('nada foi escrito',await read(cwd+'/value.txt')==='before'&&!await exists(cwd+'/a-mais-longo.txt'));
 check('sem plano, a tarefa não fica marcada como a aplicar',r.workspace.applying===false,'applying='+r.workspace.applying);
 await open();const state=await ui.state(),card=await ui.card();check('a página não diz que o projeto pode estar parcialmente alterado',!/parcialmente/.test(card),state+' · '+card);check('não oferece desfazer o que não existe',!/desfazer/.test(await ui.finish().textContent()),await ui.finish().textContent());
});

await scenario('mesma-conversa',{conversation:true},async({cwd,cx,r,clients,roles,conclude,settled,open,ui,check,page})=>{
 cx.applyEnvironment={HYDRAQ_APPLY_STOP_AFTER:1};await conclude();await wait(()=>r.status==='paused','pausa');await settled();delete cx.applyEnvironment;await open();
 await wait(async()=>/Aplicação por concluir/.test(await ui.state()),'estado na conversa');check('a conversa mostra a aplicação por concluir',true);check('a conversa mostra a pasta do projeto, não a cópia',await page.locator('#cwd').inputValue().catch(()=>'')!==r.workspace.copy);
 await ui.finish().click();await wait(async()=>await read(cwd+'/value.txt')==='before','desfazer');await wait(()=>r.released,'devolução');check('devolve a conversa, com o projeto reposto',cx.native(r,'codex').cwd===cwd);
 check('o trabalho aprovado continua na cópia',await read(r.workspace.copy+'/value.txt')==='after');
 // O que o utilizador pode fazer agora com esse trabalho.
 const turns=roles.map(role=>clients[role].logs.length);
 const history=page.locator(`.cx-card[data-task="${r.id}"]`);await history.locator('> summary').click();
 await history.getByRole('button',{name:'Aplicar ao projeto',exact:true}).waitFor();await wait(()=>history.getByRole('button',{name:'Aplicar ao projeto',exact:true}).isEnabled(),'cópia disponível');
 cx.applyEnvironment={HYDRAQ_APPLY_HOLD_AT:'temporary'};
 await history.getByRole('button',{name:'Aplicar ao projeto',exact:true}).click();await wait(()=>exists(r.workspace.folder+'/aplicacao/parado'),'aplicação manual antes de escrever');
 await history.locator('.cx-workspace-state',{hasText:'A aplicar ao projeto'}).waitFor();check('a aplicação manual mostra progresso antes de escrever',await read(cwd+'/value.txt')==='before');
 check('não oferece apagar a cópia durante a aplicação',await history.getByRole('button',{name:'Apagar cópia',exact:true}).count()===0);
 await page.screenshot({path:path.join(out,'real-saved-applying.png')});await writeFile(r.workspace.folder+'/aplicacao/continua','');
 await wait(()=>r.workspace.applied,'aplicação manual');delete cx.applyEnvironment;
 check('Aplicar ao projeto entrega a versão aprovada depois de devolver a conversa',await read(cwd+'/value.txt')==='after'&&await read(cwd+'/a-mais-longo.txt')==='a');
 check('aplicar a cópia guardada não acorda os modelos',roles.every((role,i)=>clients[role].logs.length===turns[i]));
 await wait(()=>r.workspace.removed,'cópia removida');check('depois de aplicar, a cópia desaparece sozinha',!await exists(r.workspace.folder));
 await history.locator('.cx-workspace-state',{hasText:'Aplicado ao projeto'}).waitFor();check('já aplicada, a página não oferece nem aplicar nem apagar',await history.getByRole('button',{name:'Apagar cópia',exact:true}).count()===0&&await history.getByRole('button',{name:'Aplicar ao projeto',exact:true}).count()===0);
});
await scenario('copia-guardada-projeto-mudou',{conversation:true},async({cwd,cx,r,conclude,settled,open,check,page,roles,finish})=>{
 cx.applyEnvironment={HYDRAQ_APPLY_STOP_AFTER:0};await conclude();await wait(()=>r.status==='paused','pausa');await settled();delete cx.applyEnvironment;await cx.stop(r.id);finish();await wait(()=>r.released,'devolução');await settled();
 await writeFile(cwd+'/novo-teu.txt','TEU');await open();const history=page.locator(`.cx-card[data-task="${r.id}"]`);await history.locator('> summary').click();
 await history.getByRole('button',{name:'Aplicar ao projeto',exact:true}).click();await wait(()=>r.workspace.actionError,'recusa de projeto alterado');
 check('aplicar a cópia guardada recusa um projeto alterado',/projeto mudou/.test(r.workspace.actionError)&&await read(cwd+'/value.txt')==='before'&&!await exists(cwd+'/a-mais-longo.txt'));
 await history.getByText(/O projeto mudou/).waitFor();check('a página explica por que não aplicou',true);
 check('a recusa diz uma só vez que nada foi escrito',(r.workspace.actionError.match(/Nada foi/g)||[]).length===1,r.workspace.actionError);
 const discard=history.getByRole('button',{name:'Apagar cópia',exact:true});page.once('dialog',dialog=>dialog.dismiss());await discard.click();check('cancelar a confirmação conserva a cópia',await exists(r.workspace.folder));
 page.once('dialog',dialog=>dialog.accept());await discard.click();await wait(()=>r.workspace.removed,'cópia apagada');
 check('a página apaga a cópia guardada com confirmação',!await exists(r.workspace.folder));check('apagar a cópia não muda o projeto',await read(cwd+'/novo-teu.txt')==='TEU'&&await read(cwd+'/value.txt')==='before');
});
await scenario('copia-guardada-git',{conversation:true,prepare:async({cwd})=>{execFileSync('git',['init','-q'],{cwd});execFileSync('git',['config','core.fsmonitor','./value.txt'],{cwd});}},async({cwd,cx,r,conclude,settled,open,check,page,finish})=>{
 await conclude();await wait(()=>r.status==='paused','pausa');await settled();await cx.stop(r.id);finish();await wait(()=>r.released,'devolução');await settled();await open();
 const history=page.locator(`.cx-card[data-task="${r.id}"]`);await history.locator('> summary').click();await history.getByRole('button',{name:'Aplicar ao projeto',exact:true}).click();
 const confirm=history.getByRole('button',{name:'Confirmar e aplicar',exact:true});await confirm.waitFor();check('a cópia guardada pede confirmação do que o Git usa',await read(cwd+'/value.txt')==='before');check('a confirmação nomeia o ficheiro',(await history.locator('.cx-workspace li').allTextContents()).includes('value.txt'));
 await page.screenshot({path:path.join(out,'real-saved-git-confirmation.png')});await confirm.click();await wait(()=>r.workspace.applied,'confirmado');check('confirmar aplica',await read(cwd+'/value.txt')==='after'&&await read(cwd+'/a-mais-longo.txt')==='a');
});
await scenario('pasta-privada-apagada',{conversation:true},async({cwd,cx,r,conclude,settled,open,ui,check,page})=>{
 cx.applyEnvironment={HYDRAQ_APPLY_STOP_AFTER:1};await conclude();await wait(()=>r.status==='paused','pausa');await settled();delete cx.applyEnvironment;await rm(r.workspace.folder,{recursive:true,force:true});await open();
 await wait(async()=>/Aplicação por concluir/.test(await ui.state()),'estado');check('com a pasta apagada, não oferece libertar antes de se tentar desfazer',await page.getByRole('button',{name:'Libertar o projeto',exact:true}).count()===0);
 await ui.finish().click();const release=page.getByRole('button',{name:'Libertar o projeto',exact:true});await release.waitFor();check('tentar desfazer diz que a pasta desapareceu e oferece libertar',/desapareceu/.test(await ui.card()));check('já não aponta para a pasta de recuperação',!(await ui.card()).includes('Pasta de recuperação'));
 await page.screenshot({path:path.join(out,'real-pasta-apagada.png')});
 page.once('dialog',dialog=>dialog.dismiss());await release.click();check('cancelar mantém a reserva',r.workspace.applying===true&&cx.scopes().some(item=>item.id===r.id));
 page.once('dialog',dialog=>dialog.accept());await release.click();await wait(()=>r.workspace.lost,'libertar');await wait(()=>r.released,'devolução');check('libertar tira a reserva e deixa o projeto como estava',!cx.scopes().some(item=>item.id===r.id)&&await read(cwd+'/value.txt')==='after');
 const history=page.locator(`.cx-card[data-task="${r.id}"]`);await history.locator('> summary').click();await history.locator('.cx-workspace-state',{hasText:'Projeto libertado sem desfazer'}).waitFor();check('o cartão diz que o projeto foi libertado sem desfazer',await history.getByRole('button',{name:'Libertar o projeto',exact:true}).count()===0);
});
await writeFile(path.join(out,'real-recovery.json'),JSON.stringify(results,null,2));
return results.flatMap(scenario=>scenario.checks.map(check=>({name:scenario.name+' · '+check.label,ok:check.ok,...(check.detail?{detail:check.detail}:{}),evidence:'real coordinator, writer and browser; simulated clients'})));
}
