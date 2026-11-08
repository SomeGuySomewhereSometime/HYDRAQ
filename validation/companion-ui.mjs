// Browser verification against isolated clients; no Gemini calls or user history.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chromium } from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { Providers } from '../lib/providers.mjs';
import { OpinionClient } from '../test/fixtures/opinion-client.mjs';
import { createHttpServer } from '../lib/http.mjs';
const directory = await mkdtemp(path.join(os.tmpdir(), 'hydraq-companion-ui-'));
const clients = Object.fromEntries(['codex', 'claude', 'antigravity', 'cursor', 'opencode'].map(id => [id, new OpinionClient(id, path.join(directory,id), { answer: 'Resposta delegada **confirmada**.\n\n- Só leitura\n- Sem alterações' })]));
let catalogScope;
clients.opencode.refreshModels = async cwd => {
 catalogScope = cwd;
 return { cwd, checkedAt: new Date().toISOString(), models: [{ id: 'opencode/free-test', name: 'OpenCode gratuito de ensaio', free: true }] };
};
const hub = new Providers({ dataDir: path.join(directory,'hub'), defaultCwd: directory, clients, git: async () => [] });
let browser, server, liveUpstream, upstreamConnections=0;
class FakeUpstream extends EventEmitter {
 readyState=1;
 frames=[];
 send(raw) {const frame=JSON.parse(String(raw));this.frames.push(frame);if(frame.setup)queueMicrotask(()=>frame.setup.sessionResumption?.handle ? this.emit('close',1008,Buffer.from('BidiGenerateContent session not found or expired')) : this.receive({setupComplete:{}}));}
 receive(frame) {this.emit('message',JSON.stringify(frame));}
 close() {this.readyState=3;this.emit('close',1000,Buffer.from(''));}
}
hub.companion.env={GEMINI_API_KEY:'simulated-local-test'};
hub.companion.wsFactory=()=>{upstreamConnections++;liveUpstream=new FakeUpstream();queueMicrotask(()=>liveUpstream.emit('open'));return liveUpstream;};
let checks = 0;
const check = (label, value) => { assert.ok(value, label); checks++; console.log('PASS ' + label); };
async function waitFor(read) {
 for (let attempt=0; attempt<200; attempt++) {
  const result=read();
  if (result) return result;
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 throw Error('Tempo excedido à espera da sessão Live simulada.');
}
try {
 await hub.load(); await hub.connectAll();
 const project = await hub.createProject({ name: 'Projeto de ensaio', root: directory, revision: hub.projects.data.revision });
 const source = await hub.create({ projectId: project.id, revision: hub.projects.data.revision, provider: 'codex', model: 'test' });
 const voice = await hub.companion.store.ensureActiveConversation(project.id);
 for (let i = 0; i < 110; i++) await hub.companion.store.appendMessage(project.id, voice.id, { role: i%2 ? 'assistant' : 'user', text: `Mensagem informal ${i+1}.\nSegunda linha para acompanhar a conversa.`, at: new Date(Date.now()-120000+i*1000).toISOString(), modality: 'voice' });
 server = createHttpServer({ hydraq: hub, publicDir: path.resolve('public') });
 await new Promise(r => server.listen(0,'127.0.0.1',r));
 const url = `http://127.0.0.1:${server.address().port}`;
 browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], executablePath: process.env.HYDRAQ_TEST_CHROMIUM || '/home/sauron/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
 const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
 const errors=[]; page.on('pageerror', error=>errors.push(error.message));
 await page.addInitScript(({id,projectId})=>{localStorage.setItem('hydraq.conversation',id);localStorage.setItem('hydraq.project',projectId);}, { id: source.id, projectId: project.id });
 await page.goto(url); await page.locator('#companion-launcher').click();
 await page.locator('#companion-messages .companion-msg').last().waitFor();
 check('opções recolhidas por defeito', !await page.locator('.companion-options').evaluate(el=>el.open));
 check('histórico usa a maior parte do painel', await page.locator('#companion-messages').evaluate(el=>el.clientHeight>300));
 check('mensagens multilinha preservadas', await page.locator('.companion-msg-text').first().evaluate(el=>getComputedStyle(el).whiteSpace==='pre-wrap'));
 check('conversa informal fora da conversa normal', !((await page.locator('#messages').innerText()).includes('Mensagem informal')));
 await page.locator('#companion-text-input').fill('Rascunho que deve ficar');
 await page.getByRole('button',{name:'Ampliar',exact:true}).click();
 check('ampliar mantém rascunho', await page.locator('#companion-text-input').inputValue()==='Rascunho que deve ficar');
 check('painel ampliado', (await page.locator('#companion-panel').boundingBox()).width>700);
 await page.locator('#companion-messages').evaluate(el=>{el.scrollTop=0;});
 await page.locator('#companion-panel .companion-name').click();
 await page.getByRole('button',{name:'Reduzir',exact:true}).click();
 check('leitura antiga não salta ao fundo', await page.locator('#companion-messages').evaluate(el=>el.scrollTop<30));
 await page.locator('#companion-panel').getByRole('button',{name:'Carregar mensagens anteriores'}).click();
 await page.waitForFunction(()=>document.querySelectorAll('#companion-messages .companion-msg').length===110);
 check('paginação conserva os blocos', await page.locator('#companion-messages .companion-msg').count()===110);
 await page.locator('#companion-text-input').fill('Analisa a estrutura e comenta brevemente.');
 await page.locator('#companion-panel').getByRole('button',{name:'Delegar ao Codex',exact:true}).click();
 await page.locator('#messages .companion-delegated-message').first().waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('#messages .companion-delegated-message')].some(el=>el.textContent.includes('Resposta delegada')));
 check('pedido identificado como mascote na conversa normal', (await page.locator('#messages').innerText()).includes('Hydra · Pedido da mascote → Codex'));
 check('resposta identificada na conversa normal', (await page.locator('#messages').innerText()).includes('Resposta à mascote Hydra'));
 check('diálogo informal continua isolado', !(await page.locator('#messages').innerText()).includes('Mensagem informal'));
 check('paginação conservada após atualização da tarefa', await page.locator('#companion-messages .companion-msg').count()===110);
 await page.reload(); await page.locator('#messages .companion-delegated-message').first().waitFor();
 check('pedido e resposta sobrevivem ao recarregamento', await page.locator('#messages .companion-delegated-message').count()===2);
 await page.locator('#companion-launcher').click(); await page.locator('#companion-messages').waitFor();
 await page.screenshot({path:'output/companion-desktop.png',fullPage:false});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:'output/companion-mobile.png',fullPage:false});
 check('painel cabe em móvel', await page.locator('#companion-panel').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
 check('mensagens continuam visíveis em móvel', await page.locator('#companion-messages').evaluate(el=>el.clientHeight>180));
 await page.setViewportSize({width:1440,height:1000});
 await hub.companion.store.updateConversationMetadata(project.id, voice.id, meta=>({...meta,resumption:{handle:'expired-test-handle',model:'gemini-3.8-live',voiceMode:'hands-free',updatedAt:new Date().toISOString()}}));
 await page.context().grantPermissions(['microphone'],{origin:url});
 await page.getByRole('button',{name:'Ligar voz Live',exact:true}).click();
 try { await page.getByRole('button',{name:'Desligar voz',exact:true}).waitFor({timeout:8000}); } catch(error) { console.log(JSON.stringify({errorBanner:await page.locator('.companion-error').allTextContents(),errors,upstream:!!liveUpstream}));throw error; }
 check('retoma expirada recupera sem erro de chave no browser', upstreamConnections===2 && await page.locator('.companion-error').count()===0);
 check('sessão Live recebe a conversa de origem', hub.companion.sessions.get(project.id)?.sourceGroupId===source.id);
 const declared = liveUpstream.frames.find(frame => frame.setup)?.setup.tools[0].functionDeclarations;
 check('a sessão Live anuncia a consulta de configuração', declared.some(tool => tool.name==='consultar_hydraq'));
 liveUpstream.receive({toolCall:{functionCalls:[{id:'test-models',name:'consultar_hydraq',args:{provider:'opencode'}}]}});
 const liveInfo = await waitFor(()=>liveUpstream.frames.flatMap(frame=>frame.toolResponse?.functionResponses || []).find(result=>result.id==='test-models')?.response?.output);
 check('catálogo OpenCode limitado à pasta do projeto', catalogScope===project.root && liveInfo.clients[0].catalog.models[0].id==='opencode/free-test');
 check('a consulta distingue o modelo Live e o da conversa', liveInfo.companion.liveModel==='gemini-3.8-live' && liveInfo.sourceModels[0].model===source.model);
 check('a consulta não inclui dados de conta', !Object.hasOwn(liveInfo.clients[0],'account'));

 await page.locator('#companion-text-input').fill('Rascunho durante a voz');
 await page.locator('#companion-text-input').evaluate(el=>{el.focus();el.setSelectionRange(5,10);});
 await page.locator('#companion-messages').evaluate(el=>{el.scrollTop=0;});
 liveUpstream.receive({serverContent:{outputTranscription:{text:'Uma resposta nova em direto.'}}});
 await page.getByText('Uma resposta nova em direto.',{exact:true}).waitFor();
 check('transcrição não força scroll ao fundo', await page.locator('#companion-messages').evaluate(el=>el.scrollTop<30));
 check('foco e seleção sobrevivem à transcrição', await page.locator('#companion-text-input').evaluate(el=>document.activeElement===el&&el.selectionStart===5&&el.selectionEnd===10&&el.value==='Rascunho durante a voz'));
 check('atalho para mensagens recentes visível', await page.getByRole('button',{name:'↓ Ir para as mais recentes',exact:true}).isVisible());
 const message={id:'audit-saved',role:'assistant',text:'Mensagem guardada uma única vez.',at:new Date().toISOString()};
 hub.companion.sessions.get(project.id).sendClient({type:'message_saved',message});hub.companion.sessions.get(project.id).sendClient({type:'message_saved',message});
 await page.getByText(message.text,{exact:true}).waitFor();
 check('mensagem guardada não duplica',await page.getByText(message.text,{exact:true}).count()===1);
 await page.locator('#new-chat').click();
 await waitFor(()=>hub.companion.sessions.get(project.id)?.sourceGroupId===null);
 liveUpstream.receive({toolCall:{functionCalls:[{id:'test-standalone',name:'delegar_exploracao',args:{provider:'codex',prompt:'Exploração pedida pela voz sem conversa selecionada.'}}]}});
 await page.locator('#messages .companion-delegated-message').filter({hasText:'Exploração pedida pela voz sem conversa selecionada.'}).waitFor();
 await page.locator('#messages .companion-delegated-message').filter({hasText:'Resposta delegada'}).waitFor();
 check('delegação por voz também abre a conversa própria', await page.locator('#messages .companion-delegated-message').count()===2);
 await page.getByRole('button',{name:'Desligar voz',exact:true}).click();
 await page.locator('#new-chat').click();
 await page.locator('#companion-text-input').fill('Exploração autónoma sem conversa selecionada.');
 await page.getByRole('button',{name:'Delegar ao Codex',exact:true}).click();
 await page.locator('#messages .companion-delegated-message').filter({hasText:'Exploração autónoma sem conversa selecionada.'}).waitFor();
 await page.locator('#messages .companion-delegated-message').filter({hasText:'Resposta delegada'}).waitFor();
 const selectedStandalone = await page.evaluate(()=>localStorage.getItem('hydraq.conversation'));
 const delegated = hub.snapshot().conversations.find(chat=>chat.id===selectedStandalone);
 check('sem origem, a conversa própria abre com o pedido e resposta', delegated?.organization?.companion?.sourceGroupId===null && await page.locator('#messages .companion-delegated-message').count()===2);

 check('sem erros JavaScript', errors.length===0);
 console.log(`${checks} verificações aprovadas.`);
} finally {
 await browser?.close(); server?.closeStreams(); if(server) await new Promise(r=>server.close(r)); await hub.close(); await rm(directory,{recursive:true,force:true});
}
