// Real browser microphone encoder; isolated clients and simulated Groq response.
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { Providers } from '../lib/providers.mjs';
import { OpinionClient } from '../test/fixtures/opinion-client.mjs';
import { createHttpServer } from '../lib/http.mjs';
import { inspectAudio } from '../lib/dictation.mjs';
const root=await mkdtemp(path.join(os.tmpdir(),'hydraq-dictation-ui-'));
const clients=Object.fromEntries(['codex','claude','antigravity','cursor'].map(id=>[id,new OpinionClient(id,path.join(root,id))]));
const hub=new Providers({dataDir:path.join(root,'hub'),defaultCwd:root,clients,git:async()=>[]});
let browser,server,calls=0,fail=false,delay=0;
const errors=[]; const check=(name,value)=>{assert.ok(value,name);console.log('PASS '+name);};
try {
 await hub.load();await hub.connectAll();
 server=createHttpServer({hydraq:hub,publicDir:path.resolve('public'),dictation:{status:()=>({available:true}),transcribe:async(bytes,mime)=>{inspectAudio(bytes,mime);calls++;await new Promise(r=>setTimeout(r,delay));if(fail)throw Object.assign(Error('Limite de transcrição da Groq atingido.'),{status:429});return {text:'Olá HYDRAQ, isto é um ditado.',model:'whisper-large-v3'};}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const context=await browser.newContext({permissions:['microphone'],viewport:{width:1440,height:1000}});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#model option[value="test"]').waitFor({state:'attached'});
 check('Ícone sem texto junto de Enviar',await page.locator('#dictate').evaluate(el=>el.textContent===''&&el.nextElementSibling?.id==='send'&&el.querySelector('svg')!==null));
 await page.locator('#prompt').fill('Texto escrito.');await page.locator('#dictate').click();await page.getByRole('button',{name:'Terminar ditado',exact:true}).waitFor();
 check('Enviar bloqueado durante gravação',await page.locator('#send').isDisabled());
 await new Promise(r=>setTimeout(r,350));await page.locator('#dictate').click();await page.waitForFunction(()=>document.querySelector('#prompt').value.includes('Olá HYDRAQ'));
 check('Áudio real codificado e transcrição acrescentada',await page.inputValue('#prompt')==='Texto escrito. Olá HYDRAQ, isto é um ditado.');check('Sem envio automático',clients.codex.logs.length===0);
 await page.locator('#dictate').click();await page.getByRole('button',{name:'Terminar ditado',exact:true}).waitFor();await page.locator('.dictation-panel button').click();await page.waitForTimeout(100);
 check('Cancelar não envia áudio',calls===1);check('Cancelar liberta microfone',await page.evaluate(()=>document.querySelector('.dictation-panel').hidden));
 fail=true;await page.locator('#dictate').click();await page.getByRole('button',{name:'Terminar ditado',exact:true}).waitFor();await page.waitForTimeout(250);await page.locator('#dictate').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Limite de transcrição'));
 check('Quota preserva rascunho',await page.inputValue('#prompt')==='Texto escrito. Olá HYDRAQ, isto é um ditado.');
 fail=false;delay=500;await page.locator('#dictate').click();await page.getByRole('button',{name:'Terminar ditado',exact:true}).waitFor();await page.waitForTimeout(250);await page.locator('#dictate').click();await page.waitForFunction(()=>document.querySelector('#dictate').dataset.phase==='transcribing');
 await page.locator('.dictation-panel button').click();await page.locator('#prompt').fill('Outro rascunho');await page.waitForTimeout(650);check('Cancelar transcrição rejeita resultado atrasado',await page.inputValue('#prompt')==='Outro rascunho');
 const callsBefore=calls;await page.locator('#dictate').click();await page.getByRole('button',{name:'Terminar ditado',exact:true}).waitFor();await page.locator('#new-chat').click();await page.waitForTimeout(100);
 check('Mudar de conversa cancela ditado sem enviar áudio',calls===callsBefore&&await page.locator('.dictation-panel').isHidden());
 await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied','NotAllowedError');};});await page.locator('#dictate').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Permite o acesso ao microfone'));
 check('Permissão recusada dá aviso e permite nova tentativa',await page.locator('#dictate').isEnabled()&&await page.locator('.dictation-panel').isHidden());
 for(const theme of ['atelier','classic','mono']){await page.evaluate(t=>document.body.dataset.theme=t,theme);check(theme+': microfone visível',await page.locator('#dictate').isVisible());}
 await mkdir('/tmp/hydraq-dictation-ui',{recursive:true});await page.screenshot({path:'/tmp/hydraq-dictation-ui/desktop.png'});
 await page.setViewportSize({width:390,height:844});await page.reload();await page.locator('#dictate').waitFor();
 check('390px sem overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 check('390px microfone e Enviar na mesma linha',await page.locator('#dictate').evaluate(el=>{const a=el.getBoundingClientRect(),b=document.querySelector('#send').getBoundingClientRect();return Math.abs(a.top+a.height/2-b.top-b.height/2)<2&&b.left-a.right<=10;}));
 check('390px microfone dentro do ecrã',await page.locator('#dictate').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
 await page.screenshot({path:'/tmp/hydraq-dictation-ui/mobile.png'});
 check('Sem erros JavaScript',errors.length===0);
}finally{await browser?.close();server?.closeStreams();if(server)await new Promise(r=>server.close(r));await hub.close();await rm(root,{recursive:true,force:true});}
