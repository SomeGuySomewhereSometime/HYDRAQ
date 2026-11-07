// Isolated browser checks. Quotas and answers are simulated, with the real hub and UI.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { Providers } from '../lib/providers.mjs';
import { OpinionClient } from '../test/fixtures/opinion-client.mjs';
import { createHttpServer } from '../lib/http.mjs';

const root = await mkdtemp('/tmp/hydraq-daily-ui-');
const out = path.resolve(process.argv[2] || root + '/screenshots');
await mkdir(out, { recursive: true });
const models = { codex: 'test', claude: 'opus', antigravity: 'gemini-4-argon', cursor: 'test', opencode: 'test' };
const reset = '2099-01-01T00:00:00.000Z';
class QuotaClient extends OpinionClient {
  constructor(provider, directory) {
    super(provider, directory, { behavior: 'hold' });
    this.models[0].id = models[provider];
    this.models[0].name = {codex:'Codex teste',claude:'Claude Opus',antigravity:'Gemini Argon'}[provider] || provider;
    this.counter = 10;
  }
  async readQuotas() {
    const utilization = this.counter;
    this.counter += .25;
    if (this.provider === 'codex') return { rateLimits: {
      primary: { usedPercent: utilization, windowDurationMins: 300, resetsAt: Date.parse(reset) / 1000 },
      secondary: { usedPercent: utilization, windowDurationMins: 10080, resetsAt: Date.parse(reset) / 1000 },
    } };
    if (this.provider === 'claude') return { rate_limits_available: true, rate_limits: {
      five_hour: { utilization, resets_at: reset }, seven_day: { utilization, resets_at: reset },
    } };
    return { groups: [
      { name: 'Gemini Models', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: .8, reset_time: reset }] },
      { name: 'Gemini 4 Argon', buckets: [{ id: 'argon-weekly', window: 'weekly', remaining_fraction: 1 - utilization / 100, reset_time: reset }] },
    ] };
  }
  finish(c, text) {
    super.finish(c, text);
    const usage = c.turns.at(-1).usage;
    if (usage) Object.assign(usage, { cachedInputTokens: 0, uncachedInputTokens: usage.inputTokens, cachePercent: 0 });
    this.changed();
  }
  async send(id, text, requestId, settings = {}) {
    const result = await super.send(id, text, requestId, settings);
    if (result.duplicate) return result;
    const c = this.conversation(id), turn = c.turns.at(-1);
    turn.model = settings.model || c.model;
    await this.turnQuotas?.begin(this, turn, this.models[0]);
    if (settings.internal !== 'claudex') this.timer = setTimeout(() => this.finish(c, 'Resposta de ' + this.provider), 35);
    return result;
  }
}
const clients = Object.fromEntries(Object.keys(models).map(provider => [provider, new QuotaClient(provider, root + '/' + provider)]));
const hub = new Providers({
  dataDir: root + '/hub', defaultCwd: root, clients, git: async () => [],
  opinionSupervisor: { available: async () => ({ available: true }), stop: async () => {} },
  opinionClientFactory: async ({ job, directory, cwd }) => {
    const client = new QuotaClient(job.provider, directory);
    await client.load();
    return { client, cwd };
  },
});
let server,browser;
try {
 await hub.load();await hub.connectAll();
 const c=clients.codex.conversation((await hub.create({provider:'codex',cwd:root,model:'test',effort:'low',sandbox:'read-only'})).id);
 await hub.send(c.id,'Pesquisar ligação única','test-search');await new Promise(r=>setTimeout(r,100));
 server=createHttpServer({hydraq:hub,publicDir:path.resolve('public')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('#runtime-version').waitFor();
 await page.evaluate(id=>localStorage.setItem('hydraq.conversation',id),c.id);await page.reload();await page.locator('#runtime-version').waitFor();
 await page.locator('#effort').selectOption('high',{force:true});await page.locator('#prompt').fill('Rascunho preservado');await page.reload();await page.waitForFunction(()=>document.querySelector('#prompt').value==='Rascunho preservado');
 assert.equal(await page.locator('#effort').inputValue(),'high');console.log('PASS texto e raciocínio sobrevivem a recarregar');
 await page.locator('#search-content').click();await page.getByLabel('Conteúdo',{exact:true}).fill('ligacao unica');await page.getByRole('button',{name:'Pesquisar',exact:true}).click();await page.getByText('1 resultado',{exact:true}).waitFor();console.log('PASS pesquisa com acentos e excerto');
 await page.screenshot({path:out+'/search.png'});
 await page.getByRole('dialog').getByLabel('Cliente',{exact:true}).selectOption('claude');await page.getByRole('button',{name:'Pesquisar',exact:true}).click();await page.getByText('0 resultados',{exact:true}).waitFor();console.log('PASS filtro de cliente');
 await page.getByRole('button',{name:'Fechar',exact:true}).click();assert.match(await page.locator('#runtime-version').innerText(),/^v[0-9]+/);console.log('PASS versão visível');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:out+'/mobile.png'});assert.deepEqual(errors,[]);console.log('PASS sem erros JavaScript');
}finally{await browser?.close();server?.closeStreams();if(server)await new Promise(r=>server.close(r));await hub.close();await rm(root,{recursive:true,force:true});}
