import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {Providers} from '../lib/providers.mjs';
import {OpinionClient} from '../test/fixtures/opinion-client.mjs';
import {createHttpServer} from '../lib/http.mjs';
const root=await mkdtemp('/tmp/hydraq-cx-ui-'),out=path.resolve(process.argv[2]||root+'/evidence');await mkdir(out,{recursive:true});
const clients=Object.fromEntries(['codex','claude','antigravity','cursor','opencode'].map(role=>{const c=new OpinionClient(role,root+'/'+role,{behavior:'hold'});c.defaultCwd=root;return [role,c];}));
for(const [role,id,name] of [['codex','gpt-6.1-sol','GPT-6.1 Sol'],['claude','opus','Claude Opus 5.5']])clients[role].models.push({...clients[role].models[0],id,name});
const hub=new Providers({dataDir:root+'/hub',defaultCwd:root,clients,git:async()=>[]});let browser,server;const results=[],errors=[];
const check=(name,ok)=>{results.push({name,ok:Boolean(ok)});if(!ok)throw Error(name);};
try{
 await hub.load();server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto('http://127.0.0.1:'+server.address().port);await page.getByRole('button',{name:'ClaudeX',exact:true}).click();check('preferred pair selected',await page.locator('#cx-codexModel').inputValue()==='gpt-6.1-sol'&&await page.locator('#cx-claudeModel').inputValue()==='opus');await page.locator('#cx-codexModel').selectOption('test');await page.locator('#cx-claudeModel').selectOption('test');
 check('separate workspace visible',await page.locator('#claudex-view').isVisible()&&!await page.locator('#chat-workspace').isVisible());
 check('default guard values',await page.locator('#cx-guardTurns').inputValue()==='30'&&await page.locator('#cx-guardMinutes').inputValue()==='60');
 await page.locator('#cx-guardTurns').fill('0');await page.locator('#cx-guardMinutes').fill('0');
 await page.locator('#cx-prompt').fill('Planear um organizador offline.');await page.getByRole('button',{name:'Iniciar ClaudeX',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cx-badge').textContent==='Em diálogo');
 const r=hub.claudex.records[0],call=(role,name,args={})=>hub.claudex.tool([...hub.claudex.leases].find(([,l])=>l.taskId===r.id&&l.role===role)[0],name,args);
 await page.waitForTimeout(200);for(const role of ['codex','claude'])await call(role,'initial_position',{text:'Posição '+role});
 await call('claude','read_dialogue');
 const nativeClaude=hub.claudex.native(r,'claude');nativeClaude.items.push({type:'mcpToolCall',tool:'Read',turnId:nativeClaude.turnId,status:'inProgress',at:new Date().toISOString()});
 await page.locator('.cx-participant[data-client=claude] .cx-tool-activity').waitFor();
 check('live tool shown',await page.locator('.cx-participant[data-client=claude] .cx-tool-activity').textContent()==='Em execução: Read');
 check('confirmed dialogue read shown',/Última leitura: mensagem 3 · \d/.test(await page.locator('.cx-participant[data-client=claude] .cx-last-read').textContent()));
 check('unread participant distinguished',await page.locator('.cx-participant[data-client=codex] .cx-last-read').textContent()==='Ainda não leu o diálogo');
 nativeClaude.items.at(-1).status='completed';await page.locator('.cx-participant[data-client=claude] .cx-tool-activity').waitFor({state:'detached'});
 check('completed tool removed',await page.locator('.cx-tool-activity').count()===0);
 delete r.read.claude.at;await page.getByText('Última leitura: mensagem 3 · hora não registada',{exact:true}).waitFor();
 check('legacy read has no invented time',true);
 check('disabled guards reach coordinator',r.guards.turns===0&&r.guards.minutes===0);
 check('guards frozen while active',await page.locator('#cx-guardTurns').isDisabled()&&await page.locator('#cx-guardMinutes').isDisabled());
 const snapshot=hub.claudex.snapshot;hub.claudex.snapshot=function(){const value=snapshot.call(this);delete value.protocolVersion;return value;};hub.emit('state',hub.snapshot());
 await page.getByText('Reinicia o servidor HYDRAQ para ativar esta versão do ClaudeX. O histórico continua disponível.',{exact:true}).waitFor();
 check('old server disables mutation controls',await page.getByRole('button',{name:'Atualizar o pedido dos dois',exact:true}).isDisabled()&&await page.getByRole('button',{name:'Pausar os dois',exact:true}).isDisabled());
 check('old server shows restart notice',await page.locator('#claudex-view [role=alert]').isVisible());
 check('old server preserves task history access',await page.getByRole('button',{name:/^Planear um organizador offline/}).count()===1&&await page.locator('.cx-participant').count()===2);
 hub.claudex.snapshot=snapshot;hub.emit('state',hub.snapshot());await page.waitForFunction(()=>[...document.querySelectorAll('#claudex-view button')].some(b=>b.textContent==='Pausar os dois'&&!b.disabled));
 check('compatible server restores mutation controls',!await page.getByRole('button',{name:'Atualizar o pedido dos dois',exact:true}).isDisabled()&&!await page.getByRole('button',{name:'Pausar os dois',exact:true}).isDisabled());
 const beforeIds=Object.fromEntries(['codex','claude'].map(role=>[role,[r.members[role].conversationId,hub.claudex.native(r,role).threadId]]));
 const interrupt=clients.codex.interrupt.bind(clients.codex);clients.codex.interrupt=async()=>{throw Error('Falha de interrupção simulada');};
 await page.getByRole('button',{name:'Pausar os dois',exact:true}).click();await page.getByRole('button',{name:'Voltar a tentar parar',exact:true}).waitFor();
 check('failed interruption visible and resume blocked',await page.locator('.cx-badge').textContent()==='Interrupção por confirmar'&&await page.getByRole('button',{name:'Retomar a mesma tarefa',exact:true}).isDisabled());
 clients.codex.interrupt=interrupt;await page.getByRole('button',{name:'Voltar a tentar parar',exact:true}).click();await page.waitForFunction(()=>[...document.querySelectorAll('#claudex-view button')].some(b=>b.textContent==='Retomar a mesma tarefa'&&!b.disabled));
 check('retry confirms interruption',!r.pause.interruptionPending);

 check('pause releases task and enables guards',r.status==='paused'&&!await page.locator('#cx-guardTurns').isDisabled());
 await page.locator('#cx-guardTurns').fill('45');await page.locator('#cx-guardMinutes').fill('90');hub.emit('state',hub.snapshot());await page.waitForTimeout(1500);
 check('paused guard edits survive refresh',await page.locator('#cx-guardTurns').inputValue()==='45'&&await page.locator('#cx-guardMinutes').inputValue()==='90');
 await page.getByRole('button',{name:'Retomar a mesma tarefa',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cx-badge').textContent==='Em diálogo');
 while(clients.codex.logs.length<2||clients.claude.logs.length<2)await page.waitForTimeout(20);
 check('resume keeps task and native sessions',hub.claudex.records.length===1&&['codex','claude'].every(role=>JSON.stringify([r.members[role].conversationId,hub.claudex.native(r,role).threadId])===JSON.stringify(beforeIds[role])));
 check('resume applies edited guard values',r.guards.turns===45&&r.guards.minutes===90);
 await call('claude','send_to_peer',{messageId:'offline',type:'discovery',text:'O sistema tem de funcionar offline e exportar JSON.'});
 await page.locator('.cx-message').filter({hasText:'exportar JSON'}).waitFor();check('attributed live exchange visible',await page.locator('.cx-message[data-client=claude]').filter({hasText:'exportar JSON'}).count()===1);
 await page.locator('#cx-prompt').fill('Também deve permitir importar JSON.');await page.getByRole('button',{name:'Atualizar o pedido dos dois'}).click();await page.locator('.cx-message').filter({hasText:'importar JSON'}).waitFor();check('shared user revision',r.revision===2);
 for(const role of ['codex','claude'])await call(role,'ready_to_conclude',await call(role,'read_dialogue'));
 const v=await call('codex','read_dialogue');const c=(await call('codex','propose_final',{...v,text:'Plano comum: funcionar offline, exportar e importar JSON.\n\nValidar a recuperação e a portabilidade.'})).candidate;
 for(const role of ['codex','claude']){const v=await call(role,'read_dialogue');await call(role,'review_final',{candidateId:c.id,hash:c.hash,revision:v.revision,reviewedThrough:v.reviewedThrough,decision:'approve'});clients[role].finish(hub.claudex.native(r,role),'Contribuição terminada.');}
 await page.getByRole('heading',{name:/^(Resposta comum · aprovada pelos dois|Acordo confirmado)$/}).waitFor();check('single published artifact',await page.locator('.cx-result').getByText('Plano comum:',{exact:false}).count()===1);
 for(const theme of ['classic','atelier','linho','mono']){await page.evaluate(theme=>{localStorage.setItem('hydraq.theme',theme);},theme);await page.reload();await page.getByRole('heading',{name:/^(Resposta comum · aprovada pelos dois|Acordo confirmado)$/}).waitFor();check(theme+' applied',await page.locator('body').getAttribute('data-theme')===theme);for(const width of [1440,390]){await page.setViewportSize({width,height:900});await page.waitForTimeout(100);check(theme+' '+width+' no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:out+'/'+theme+'-'+width+'.png',fullPage:true});}}
 await page.locator('.cx-result').scrollIntoViewIfNeeded();check('mobile result reachable',await page.locator('.cx-result').evaluate(el=>{const r=el.getBoundingClientRect();return r.top<innerHeight&&r.bottom>0;}));await page.screenshot({path:out+'/mono-mobile-result.png'});
 await page.locator('#cx-prompt').scrollIntoViewIfNeeded();check('mobile composer reachable',await page.locator('#cx-prompt').evaluate(el=>{const r=el.getBoundingClientRect();return r.top<innerHeight&&r.bottom>0;}));
 await page.setViewportSize({width:1440,height:1000});
 for(const refused of [false,true]){
  const title=refused?'Verificar divergência recusada':'Verificar divergências aprovadas';
  const created=await hub.claudex.create({requestId:crypto.randomUUID(),text:title,cwd:root,members:{codex:{model:'test',effort:'low'},claude:{model:'test',effort:'low'}}});const task=hub.claudex.record(created.task.id);
  const startedBy=Date.now()+6000;while(!['codex','claude'].every(role=>task.members[role].turns&&hub.claudex.native(task,role).status==='running')){if(Date.now()>startedBy)throw Error('Participantes não iniciaram');await page.waitForTimeout(20);}
  const tool=(role,name,args={})=>hub.claudex.tool([...hub.claudex.leases].find(([,l])=>l.taskId===task.id&&l.role===role)[0],name,args);
  for(const role of ['codex','claude'])await tool(role,'initial_position',{text:role==='codex'?'SQLite oferece transações.':'JSON oferece portabilidade.'});
  await tool('claude','declare_impasse',{...await tool('claude','read_dialogue'),text:'Prioridades diferentes sem opção comum.'});
  for(const role of ['codex','claude'])await tool(role,'ready_to_conclude',await tool(role,'read_dialogue'));
  const candidate=(await tool('codex','propose_final',{...await tool('codex','read_dialogue'),outcome:'divergences',text:'Codex prefere SQLite. Claude prefere JSON. A escolha continua aberta.'})).candidate;
  for(const role of ['codex','claude'])await tool(role,'review_final',{...await tool(role,'read_dialogue'),candidateId:candidate.id,hash:candidate.hash,decision:refused&&role==='claude'?'disagree':'approve',...(refused&&role==='claude'?{reason:'A minha posição não está representada com rigor.'}:{})});
  if(!refused)for(const role of ['codex','claude'])clients[role].finish(hub.claudex.native(task,role),'Fim');
  await page.getByRole('button',{name:new RegExp('^'+title)}).click();
  const label=refused?'Posições atribuídas · sem acordo':'Acordo sobre as divergências';await page.getByRole('heading',{name:label,exact:true}).waitFor();
  check(refused?'refused divergence has no false approval':'dual-approved divergence outcome labelled',await page.locator('.cx-result').getByRole('heading').textContent()===label);
  if(refused)check('refused positions remain attributed',await page.locator('.cx-result').textContent().then(text=>text.includes('SQLite')&&text.includes('JSON')));
 }
 await page.getByRole('button',{name:'Conversas',exact:true}).click();check('normal chat preserved',await page.locator('#chat-workspace').isVisible()&&!await page.locator('#claudex-view').isVisible());
 await page.getByRole('button',{name:'Colaboração',exact:true}).click();check('existing collaboration preserved',await page.locator('#collaboration-view').isVisible()&&!await page.locator('#claudex-view').isVisible());
 check('no JS errors',errors.length===0);console.log(JSON.stringify({out,results,errors}));
}finally{await writeFile(out+'/verification.json',JSON.stringify({results,errors},null,2));await browser?.close();if(server){server.closeStreams();await new Promise(r=>server.close(r));}await hub.close();await rm(root,{recursive:true,force:true});}
