import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { Providers } from '../lib/providers.mjs';
import { createHttpServer } from '../lib/http.mjs';
import { OpinionClient } from '../test/fixtures/opinion-client.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'hydraq-git-browser-'));
const projectRoot = path.join(root, 'Jogo');
const remote = path.join(root, 'remote');
const git = (...args) => promisify(execFile)('git', args, { cwd: projectRoot });
const out = path.resolve(process.argv[2] || path.join(root, 'screenshots'));
const hub = new Providers({
  dataDir: path.join(root, 'data'), defaultCwd: root,
  clients: Object.fromEntries(['codex', 'claude', 'antigravity', 'cursor', 'opencode'].map(provider =>
    [provider, new OpinionClient(provider, path.join(root, provider))])),
});
let server, browser;
try {
  await mkdir(projectRoot);
  await mkdir(out, { recursive: true });
  await writeFile(path.join(projectRoot, 'cena.txt'), 'Primeiro cenário\n');
  await hub.load();
  await hub.connectAll();
  const project = await hub.projects.create({ name: 'Jogo', root: projectRoot, revision: hub.projects.data.revision });
  server = createHttpServer({ hydraq: hub, publicDir: path.resolve('public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const address = 'http://127.0.0.1:' + server.address().port;
  await page.goto(address);
  await page.evaluate(id => { localStorage.setItem('hydraq.project', id); localStorage.setItem('hydraq.projectView', 'true'); }, project.id);
  await page.reload();
  await page.locator('#git-panel-trigger').click();
  const panel = page.getByRole('dialog', { name: 'Git · Jogo' });
  const button = name => panel.getByRole('button', { name, exact: true });
  await button('Ativar Git').click();
  await panel.getByText('Git ativado.', { exact: false }).waitFor();
  await git('config', 'user.name', 'Teste Git');
  await git('config', 'user.email', 'git-panel-test@example.invalid');
  await button('cena.txt').click();
  await panel.getByText('+Primeiro cenário', { exact: false }).waitFor();
  await panel.getByRole('checkbox', { name: 'Incluir cena.txt' }).check();
  await panel.getByLabel('Mensagem de commit').fill('Guarda o cenário');
  await page.screenshot({ path: path.join(out, 'alteracoes.png') });
  await button('Criar commit local').click();
  await panel.getByText('Commit criado ·', { exact: false }).waitFor();
  assert.equal((await git('log', '-1', '--format=%s')).stdout.trim(), 'Guarda o cenário');
  console.log('PASS ativação, diff, seleção e commit pela interface');

  await button('Histórico').click();
  await button('Carregar histórico').click();
  await panel.getByRole('button', { name: /Guarda o cenário/ }).click();
  await button('Novo · cena.txt').click();
  await writeFile(path.join(projectRoot, 'cena.txt'), 'A testar outra versão\n');
  await button('Pré-visualizar restauro').click();
  await button('Restaurar ficheiro').click();
  await panel.getByText('Ficheiro restaurado.', { exact: false }).waitFor();
  assert.equal((await git('status', '--porcelain', '--', 'cena.txt')).stdout, '');
  console.log('PASS histórico e restauro pela interface');

  await button('Branches').click();
  await panel.getByLabel('Nome da nova branch').fill('experiencia');
  await button('Criar a partir do commit atual').click();
  await panel.getByText('Branch criada.', { exact: true }).waitFor();
  await panel.getByLabel('Branch de destino').selectOption('experiencia');
  await button('Mudar para a branch escolhida').click();
  await panel.getByText('Branch alterada.', { exact: true }).waitFor();
  assert.equal((await git('branch', '--show-current')).stdout.trim(), 'experiencia');
  console.log('PASS criação e troca de branch pela interface');

  await git('init', '--bare', remote);
  await button('Remoto').click();
  await panel.getByText('Adicionar remoto', { exact: true }).click();
  await panel.getByLabel('Endereço do remoto').fill(remote);
  await button('Guardar remoto').click();
  await panel.getByText('Remoto guardado.', { exact: true }).waitFor();
  await panel.getByLabel('Remoto configurado').selectOption('origin');
  await button('Pré-visualizar envio').click();
  await button('Confirmar e enviar 1 commit').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(out, 'envio-mobile.png') });
  assert.equal((await git('--git-dir=' + remote, 'for-each-ref')).stdout, '');
  await button('Confirmar e enviar 1 commit').click();
  await panel.getByText('Remoto confirmado ·', { exact: false }).waitFor();
  assert.match((await git('--git-dir=' + remote, 'for-each-ref')).stdout, /refs\/heads\/experiencia/);
  assert.deepEqual(errors, []);
  console.log('PASS confirmação separada do envio e interface sem erros JavaScript');
} finally {
  await browser?.close();
  server?.closeStreams();
  if (server) await new Promise(resolve => server.close(resolve));
  await hub.close();
  await rm(root, { recursive: true, force: true });
}
