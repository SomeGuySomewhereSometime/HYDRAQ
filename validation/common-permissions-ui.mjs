import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {Providers} from '../lib/providers.mjs';
import {OpinionClient} from '../test/fixtures/opinion-client.mjs';
import {turnPermissions} from '../lib/permissions.mjs';
import {createHttpServer} from '../lib/http.mjs';
class Client extends OpinionClient{
 snapshot(){const s=super.snapshot();return {...s,capabilities:{...s.capabilities,permissionProfiles:['read-only','project']}};}
 async send(id,text,requestId,settings={}){
  const r=await super.send(id,text,requestId,settings);
  Object.assign(this.conversation(id).turns.at(-1),turnPermissions(settings));this.changed();return r;
 }
}
const root=await mkdtemp('/tmp/hydraq-permissions-ui-'),cwd=root+'/project';await mkdir(cwd);
const clients=Object.fromEntries(['codex','cursor'].map(id=>[id,new Client(id,root+'/'+id)]));
const hub=new Providers({dataDir:root+'/hub',defaultCwd:cwd,clients,git:async()=>[]});
let server,browser;
try{
 await hub.load();const c=await hub.create({provider:'codex',cwd,model:'test',effort:'low'});
 await hub.startDual(c.id,{participants:[{provider:'cursor',model:'test',effort:'low'}]});
 server=createHttpServer({hydraq:hub,publicDir:path.resolve('public')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(id=>localStorage.setItem('hydraq.conversation',id),c.id);
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.locator('#permission-controls:not([hidden])').waitFor();
 await page.locator('[data-profile]').selectOption('read-only');
 await page.locator('#prompt').fill('Consulta o projeto.');
 await page.locator('#send').click();
 await page.waitForFunction(()=>document.querySelector('#toasts')?.textContent.includes('mista')||document.body.textContent.includes('ronda mista'));
 assert.equal(clients.codex.logs.length,0);assert.equal(clients.cursor.logs.length,0);
 assert.match(await page.locator('#mode-access').textContent(),/Só leitura/);
 await page.locator('[data-round]').selectOption('mixed');
 assert.match(await page.locator('#mode-access').textContent(),/Cursor · Nativo/);
 await page.reload();await page.locator('#permission-controls:not([hidden])').waitFor();
 assert.equal(await page.locator('[data-profile]').inputValue(),'read-only');
 assert.equal(await page.locator('[data-round]').inputValue(),'mixed');
 await page.locator('#send').click();
 await page.waitForFunction(()=>document.querySelector('#prompt').value==='');
 assert.equal(clients.codex.logs.length,1);assert.equal(clients.cursor.logs.length,1);
 assert.equal(clients.codex.logs[0].settings.permissionPolicy.profile,'read-only');
 assert.equal(clients.cursor.logs[0].settings.permissionPolicy.profile,'native');
 for(const theme of ['atelier','classic','mono']){
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.body.dataset.theme=theme;},theme);
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.locator('[data-profile]').isVisible());
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
  assert.equal(overflow,false,theme);
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,themes:3,errors}));
}finally{await browser?.close();server?.closeStreams();await new Promise(resolve=>server?server.close(resolve):resolve());await hub.close();await rm(root,{recursive:true,force:true});}
