import {chromium} from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const dir=(await readFile('/tmp/hydraq-native-live-current','utf8')).trim();
const info=JSON.parse(await readFile(dir+'/info.json','utf8'));
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome'});
const errors=[], results=[];
try {
  for (const theme of ['classic','atelier']) for (const width of [1440,390]) {
    const page=await browser.newPage({viewport:{width,height:844}});
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(({id,theme})=>{localStorage.setItem('hydraq.conversation',id);localStorage.setItem('hydraq.theme',theme);}, {id:info.conversationId,theme});
    await page.goto('http://127.0.0.1:'+info.port);
    await page.locator('#settings-details').evaluate(e=>e.open=true);
    if (width===390) await page.locator('#inspector-toggle').click();
    else await page.locator('#client-status').click();
    const section=page.locator('#native-sessions'); await section.waitFor({state:'visible'}); await section.scrollIntoViewIfNeeded();
    await page.locator('[data-native-open]').click();
    await page.locator('[data-native-command]').evaluate(e=>e.open=true);
    await page.waitForFunction(()=>document.querySelector('[aria-label="Comando do terminal Codex"]').value.includes('resume'));
    assert.equal(await page.locator('#send').isDisabled(), true);
    const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));
    assert.ok(size.scroll<=size.width, JSON.stringify(size));
    await page.screenshot({path:`${dir}/ui-${theme}-${width}.png`,fullPage:true});
    results.push({theme,width,commandVisible:true,sendBlocked:true,overflow:false});
    await page.close();
  }
  if (!process.env.NATIVE_VISUAL_ONLY) {
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(id=>localStorage.setItem('hydraq.conversation',id),info.conversationId);
  await page.goto('http://127.0.0.1:'+info.port);
  await page.locator('#settings-details').evaluate(e=>e.open=true);await page.locator('#client-status').click();
  await page.locator('[data-native-import]').evaluate(e=>e.open=true);
  await page.locator('[data-native-list]').click();
  const existing=page.locator('.native-import-row').and(page.locator('[title="'+info.threadId+'"]'));
  await existing.first().waitFor(); await existing.first().click();
  await page.locator('[data-native-release]').click();
  await page.waitForFunction(()=>document.querySelector('[data-native-release]').hidden);
  const marker='HYDRA_BACK_'+randomUUID().slice(0,8);
  await page.locator('#prompt').fill(`Responde apenas ${marker}. Não uses ferramentas nem alteres ficheiros.`);
  await page.locator('#send').click();
  await page.waitForFunction(async ({id,marker})=>{const {state}=await(await fetch('/api/bootstrap')).json();const c=state.conversations.find(c=>c.id===id);return c?.status==='completed'&&c.messages.at(-1)?.text===marker;},{id:info.conversationId,marker},{timeout:120000});
  results.push({existingSessionSelected:true,release:true,backRequestCompleted:true,marker});
  }
  assert.deepEqual(errors,[]);
  await writeFile(dir+(process.env.NATIVE_VISUAL_ONLY?'/ui-visual-results.json':'/ui-results.json'),JSON.stringify({results,errors},null,2));
  console.log(JSON.stringify({results,errors}));
} finally {await browser.close();}
