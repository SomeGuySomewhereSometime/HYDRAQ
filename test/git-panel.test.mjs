import assert from 'node:assert/strict';
import { execFile as exec, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile, access, truncate, open, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { GitPanel } from '../lib/git-panel.mjs';
import { listChanges, repoAt } from '../lib/git-panel-repo.mjs';
import { createHttpServer } from '../lib/http.mjs';

const execFile = promisify(exec);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = async (root, ...args) => (await execFile('git', args, { cwd: root, env })).stdout.trim();
const id = '1f9e8791-c860-458f-9f52-48a54cb1c67c';

async function fixture(t, { initialize = true, format = 'sha1' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hydraq-git-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id, root, name: 'Teste Git' };
  const hub = Object.assign(new EventEmitter(), {
    projects: { project: wanted => { assert.equal(wanted, id); return project; } },
    reservations: new Map(), assertFree(scope) { assert.equal(scope.cwd, root); if (this.busy) throw Error('Tarefa ativa'); },
    snapshot: () => ({}),
  });
  const panel = new GitPanel(hub);
  const call = (action, body) => panel.handle(id, action, body);
  const put = (file, text) => writeFile(path.join(root, file), text);
  const read = file => readFile(path.join(root, file), 'utf8');
  const command = (...args) => git(root, ...args);
  if (initialize) {
    await command('init', '--initial-branch=main', '--object-format=' + format);
    await command('config', 'user.name', 'Teste');
    await command('config', 'user.email', 'teste@example.invalid');
    await put('a.txt', 'antigo\n');
    await put('b.txt', 'outro\n');
    await command('add', '--', 'a.txt', 'b.txt');
    await command('commit', '-m', 'base');
  }
  return { root, hub, panel, call, put, read, command, review: async file => (await call('diff', { file })).receipt };
}

test('commit conserva os blobs revistos, edições posteriores e a preparação de outros ficheiros', async t => {
  const f = await fixture(t, { format: 'sha256' });
  await f.put('a.txt', 'revisto\n');
  await f.put('b.txt', 'preparado\n');
  await f.command('add', '--', 'b.txt');
  const preview = await f.call('diff', { file: 'a.txt' });
  assert.match(preview.diff, /\+revisto/);
  await f.put('a.txt', 'edição posterior\n');
  const result = await f.call('commit', { message: 'guardar revisto', receipts: [preview.receipt] });
  assert.equal(result.commit.length, 64);
  assert.equal(await f.command('show', 'HEAD:a.txt'), 'revisto');
  assert.equal(await f.command('show', 'HEAD:b.txt'), 'outro');
  assert.equal(await f.command('show', ':b.txt'), 'preparado');
  assert.equal(await f.command('show', ':a.txt'), 'revisto');
  assert.equal(await f.read('a.txt'), 'edição posterior\n');
});

test('recusa alterações concorrentes no índice e troca de branch com o mesmo commit', async t => {
  const f = await fixture(t);
  await f.put('a.txt', 'revisto\n');
  const receipt = await f.review('a.txt');
  await f.command('add', 'a.txt');
  await assert.rejects(f.call('commit', { message: 'teste', receipts: [receipt] }), /preparadas/);
  assert.equal(await f.command('show', ':a.txt'), 'revisto');
  await f.command('reset', 'HEAD', '--', 'a.txt');
  await f.command('branch', 'outra');
  await f.command('switch', 'outra');
  await assert.rejects(f.call('commit', { message: 'teste', receipts: [receipt] }), /origem mudou/);
  assert.equal(await f.command('rev-parse', 'main'), await f.command('rev-parse', 'outra'));
  f.hub.busy = true;
  await assert.rejects(f.call('branch-create', { name: 'bloqueada' }), /Tarefa ativa/);
});

test('leitura, revisão e commit bloqueiam filtros, hooks e segredos', async t => {
  const f = await fixture(t);
  await f.put('.gitattributes', 'a.txt filter=demo\n');
  await f.put('a.txt', 'editado\n');
  await f.put('b.txt', 'válido\n');
  await f.put('.env', 'PRIVATE=value\n');
  await f.command('config', 'filter.demo.clean', 'touch FILTRO && cat');
  const hook = path.join(f.root, '.git/hooks/reference-transaction');
  await writeFile(hook, '#!/bin/sh\ntouch HOOK\n', { mode: 0o755 });
  const state = await f.call('state');
  assert.equal(state.hooks, true);
  assert.match(state.changes.find(item => item.file === 'a.txt').reason, /Filtro/);
  assert.equal(state.changes.find(item => item.file === '.env').sensitive, true);
  assert.match((await f.call('diff', { file: 'a.txt' })).reason, /Filtro/);
  await assert.rejects(f.call('diff', { file: '.env' }), /segredo/);
  const receipt = await f.review('b.txt');
  await f.command('config', 'commit.gpgSign', 'true');
  await assert.rejects(f.call('commit', { message: 'teste', receipts: [receipt] }), /assinados/);
  await f.command('config', 'commit.gpgSign', 'false');
  await f.call('commit', { message: 'sem hook', receipts: [receipt] });
  await assert.rejects(access(path.join(f.root, 'FILTRO')));
  await assert.rejects(access(path.join(f.root, 'HOOK')));
});

test('inicializa projeto Unity, guarda primeiro commit, compara branches, restaura e recupera cópia', async t => {
  const f = await fixture(t, { initialize: false });
  for (const dir of ['Assets', 'ProjectSettings', 'Packages']) await mkdir(path.join(f.root, dir));
  await f.put('Assets/cena.txt', 'original\n');
  const setup = await f.call('state');
  for (const rule of ['/Library/', '/.vs/', '/.idea/', '*.csproj', '*.sln', '/[Mm]emoryCaptures/']) {
    assert.ok(setup.ignore.split('\n').includes(rule), rule);
  }
  await f.call('init', { receipt: setup.receipt, ignore: setup.ignore });
  await f.command('config', 'user.name', 'Teste');
  await f.command('config', 'user.email', 'teste@example.invalid');
  const first = await f.call('commit', { message: 'primeiro', receipts: [await f.review('Assets/cena.txt')] });
  const originalBranch = first.branch.slice('refs/heads/'.length);
  await f.call('branch-create', { name: 'experiencia' });
  await f.call('branch-switch', { name: 'experiencia' });
  await f.put('Assets/cena.txt', 'experiência\n');
  const second = await f.call('commit', { message: 'experiência', receipts: [await f.review('Assets/cena.txt')] });
  const history = await f.call('history');
  assert.deepEqual(history.commits.map(item => item.title), ['experiência', 'primeiro']);
  assert.deepEqual((await f.call('history-files', { left: first.commit, right: second.commit })).files,
    [{ file: 'Assets/cena.txt', status: 'Alterado' }]);
  const view = await f.call('restore-preview', { file: 'Assets/cena.txt', commit: first.commit });
  assert.match(view.diff, /\+original/);
  const { backup } = await f.call('restore', { receipt: view.receipt });
  assert.equal(await f.read('Assets/cena.txt'), 'original\n');
  assert.equal(await f.command('show', ':Assets/cena.txt'), 'experiência');
  const undo = await f.call('restore-preview', { backup });
  await f.call('restore', { receipt: undo.receipt });
  assert.equal(await f.read('Assets/cena.txt'), 'experiência\n');
  await f.call('branch-switch', { name: originalBranch });
  assert.equal(await f.read('Assets/cena.txt'), 'original\n');
});

test('preview de push fixa destino, branch e commits, com proteção contra alteração remota', async t => {
  const f = await fixture(t);
  const remote = path.join(f.root, '.git', 'remote-test');
  await f.command('init', '--bare', remote);
  await f.command('remote', 'add', 'origin', remote);
  const first = await f.call('push-preview', { remote: 'origin' });
  assert.equal(first.commits[0].title, 'base');
  assert.equal(await git(remote, 'for-each-ref'), '');
  await assert.rejects(f.call('push', { receipt: 'sem pré-visualização' }), /expirou/);
  await f.call('push', { receipt: first.receipt });
  assert.equal(await git(remote, 'rev-parse', 'refs/heads/main'), first.commits[0].oid);
  await f.put('a.txt', 'segundo\n');
  const second = await f.call('commit', { message: 'segundo', receipts: [await f.review('a.txt')] });
  const preview = await f.call('push-preview', { remote: 'origin' });
  assert.deepEqual(preview.commits.map(item => item.oid), [second.commit]);
  await git(remote, 'update-ref', '-d', 'refs/heads/main');
  await assert.rejects(f.call('push', { receipt: preview.receipt }), /branch remota mudou/);
  assert.equal(await git(remote, 'for-each-ref'), '');
});

test('SIGKILL entre referência e índice preserva o commit e permite reparar sem repetir', async t => {
  const f = await fixture(t);
  const parent = await f.command('rev-parse', 'HEAD');
  await f.put('a.txt', 'revisto\n');
  const repo = await repoAt(f.root);
  const module = new URL('../lib/git-panel-transaction.mjs', import.meta.url).href;
  const script = `import { commitReviewed } from ${JSON.stringify(module)};
    const [repo, oid] = process.argv.slice(1);
    await commitReviewed(JSON.parse(repo), new Map([['a.txt', {oid, mode:'100644'}]]), 'interrompido', {
      afterRef() { process.kill(process.pid, 'SIGKILL'); }
    });`;
  const oid = await f.command('hash-object', '-w', '--no-filters', 'a.txt');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(repo), oid], { env });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [, signal] = await once(child, 'close');
  assert.equal(signal, 'SIGKILL', stderr);
  const head = await f.command('rev-parse', 'HEAD');
  assert.notEqual(head, parent);
  assert.equal(await f.command('show', ':a.txt'), 'antigo');
  const state = await f.call('state');
  assert.equal(state.recovery.canRepair, true);
  await f.call('recover', { mode: 'repair' });
  assert.equal(await f.command('rev-parse', 'HEAD'), head);
  assert.equal(await f.command('show', ':a.txt'), 'revisto');
  assert.equal((await f.call('state')).recovery, null);
});

test('rotas Git autenticadas ficam limitadas ao projeto e servem o módulo do painel', async t => {
  const f = await fixture(t);
  const server = createHttpServer({ hydraq: f.hub, publicDir: path.resolve('public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const route = '/api/projects/' + id + '/git';
  assert.equal((await fetch(origin + route)).status, 403);
  const bootstrap = await fetch(origin + '/api/bootstrap', { headers: { 'x-hydraq-bootstrap': '1' } }).then(r => r.json());
  const state = await fetch(origin + route, { headers: { 'x-hydraq-token': bootstrap.token } }).then(r => r.json());
  assert.equal(state.initialized, true);
  assert.equal((await fetch(origin + '/git-panel.js')).status, 200);
});

test('HEAD e o índice ficam bloqueados durante a publicação e locks de terceiros ficam intactos', async t => {
  const f = await fixture(t);
  const { commitReviewed } = await import('../lib/git-panel-transaction.mjs');
  const repo = await repoAt(f.root);
  await f.command('branch', 'outra');
  await f.put('a.txt', 'revisto\n');
  const oid = await f.command('hash-object', '-w', '--no-filters', 'a.txt');
  const entries = new Map([['a.txt', { oid, mode: '100644' }]]);
  await f.put('.git/index.lock', 'lock de outro programa');
  await assert.rejects(commitReviewed(repo, entries, 'recusado'), /ocupado/);
  assert.equal(await f.read('.git/index.lock'), 'lock de outro programa');
  await rm(path.join(f.root, '.git/index.lock'));
  const created = await commitReviewed(repo, entries, 'revisto', {
    async beforeRef() {
      await assert.rejects(f.command('symbolic-ref', 'HEAD', 'refs/heads/outra'), /HEAD.lock/);
      await assert.rejects(f.command('add', 'a.txt'), /index.lock/);
    },
  });
  assert.equal(await f.command('rev-parse', 'HEAD'), created.commit);
  assert.equal(await f.command('rev-parse', 'outra'), repo.head);
});

test('restauro recusa edição posterior e recria a pasta de um ficheiro histórico', async t => {
  const f = await fixture(t);
  await f.put('a.txt', 'outra edição\n');
  const previous = await f.command('rev-parse', 'HEAD');
  const view = await f.call('restore-preview', { file: 'a.txt', commit: previous });
  await f.put('a.txt', 'edição mais recente\n');
  await assert.rejects(f.call('restore', { receipt: view.receipt }), /mudou/);
  assert.equal(await f.read('a.txt'), 'edição mais recente\n');
  await mkdir(path.join(f.root, 'pasta'));
  await f.put('pasta/b.txt', 'histórico\n');
  await f.command('add', 'pasta');
  await f.command('commit', '-m', 'ficheiro na pasta');
  await rm(path.join(f.root, 'pasta'), { recursive: true });
  const restore = await f.call('restore-preview', { file: 'pasta/b.txt', commit: await f.command('rev-parse', 'HEAD') });
  await f.call('restore', { receipt: restore.receipt });
  assert.equal(await f.read('pasta/b.txt'), 'histórico\n');
});


test('estado não lê assets intactos e verifica conteúdo quando o stat muda ou o índice é antigo', async t => {
  const f = await fixture(t);
  const files = ['estavel.asset', 'racy.asset'];
  const mib = 1024 * 1024;
  const older = new Date('2020-01-01T00:00:00Z');
  const newer = new Date('2021-01-01T00:00:00Z');
  for (const [i, file] of files.entries()) {
    await f.put(file, '');
    await truncate(path.join(f.root, file), (8 + 8 * i) * mib);
    const time = i ? newer : older;
    await utimes(path.join(f.root, file), time, time);
  }
  await f.command('add', '--', ...files);
  await f.command('commit', '-m', 'assets');
  const repo = await repoAt(f.root);
  const readCount = async () => Number((await readFile('/proc/self/io', 'utf8')).match(/^rchar: (\d+)$/m)[1]);
  const scan = async () => {
    const before = await readCount();
    const changes = await listChanges(repo);
    return { changes, bytes: await readCount() - before };
  };

  const clean = await scan();
  assert.deepEqual(clean.changes, []);
  assert.ok(clean.bytes < mib, 'estado limpo só deve ler metadados: ' + clean.bytes);

  // Force the second entry to be racily clean without changing its stat.
  const index = path.join(f.root, '.git/index');
  const midway = new Date('2020-06-01T00:00:00Z');
  await utimes(index, midway, midway);
  const racy = await scan();
  assert.deepEqual(racy.changes, []);
  assert.ok(racy.bytes >= 16 * mib && racy.bytes < 17 * mib, 'apenas o asset racy deve ser lido: ' + racy.bytes);

  // A same-size edit with a restored mtime still changes ctime.
  const afterBoth = new Date('2022-01-01T00:00:00Z');
  await utimes(index, afterBoth, afterBoth);
  const file = path.join(f.root, files[0]);
  const handle = await open(file, 'r+');
  try { await handle.write(Buffer.from([0xff]), 0, 1, 0); }
  finally { await handle.close(); }
  await utimes(file, older, older);
  const modified = await scan();
  assert.deepEqual(modified.changes.map(change => change.file), [files[0]]);
  assert.ok(modified.bytes >= 8 * mib && modified.bytes < 9 * mib, 'apenas o asset alterado deve ser lido: ' + modified.bytes);
});

test('um asset revisto e guardado pelo painel não volta a ser lido no estado', async t => {
  const f = await fixture(t);
  const asset = 'cena.asset';
  await f.put(asset, '');
  await truncate(path.join(f.root, asset), 8 * 1024 * 1024);
  await delay(1020 - Date.now() % 1000);
  const diff = await f.call('diff', { file: asset });
  assert.equal(diff.binary, true);
  await f.call('commit', { message: 'guardar asset', receipts: [diff.receipt] });
  assert.match(await f.command('ls-files', '--debug', '--', asset), /ctime: 0:0/);
  const repo = await repoAt(f.root);
  const readCount = async () => Number((await readFile('/proc/self/io', 'utf8')).match(/^rchar: (\d+)$/m)[1]);
  const before = await readCount();
  assert.deepEqual(await listChanges(repo), []);
  assert.ok(await readCount() - before < 1024 * 1024, 'o estado deve reutilizar a leitura já feita na revisão');
});

test('primeiro estado lista assets novos sem os ler e o diff continua a bloquear segredos e conversões', async t => {
  const f = await fixture(t, { initialize: false });
  const asset = 'novo.asset';
  const secret = 'config.txt';
  const text = 'linhas.txt';
  const named = 'id_rsa';
  const oversized = 'grande.asset';
  const mib = 1024 * 1024;
  await f.put(asset, '');
  await truncate(path.join(f.root, asset), 16 * mib);
  await f.put(oversized, '');
  await truncate(path.join(f.root, oversized), 65 * mib);
  await f.put(named, 'nome sensível');
  await f.put(secret, 'API_TOKEN=ghp_' + 'A'.repeat(32) + '\n');
  await f.put(text, 'conversão\r\n');
  await f.command('init', '--initial-branch=main');
  await f.command('config', 'core.autocrlf', 'true');
  const readCount = async () => Number((await readFile('/proc/self/io', 'utf8')).match(/^rchar: (\d+)$/m)[1]);
  const before = await readCount();
  const state = await f.call('state');
  assert.ok(await readCount() - before < mib, 'o primeiro estado só deve ler metadados');
  assert.equal(state.head, null);
  const changes = new Map(state.changes.map(change => [change.file, change]));
  assert.equal(changes.get(asset).status, 'Novo');
  assert.equal(changes.get(asset).size, 16 * mib);
  assert.equal(changes.get(named).sensitive, true);
  assert.equal(changes.get(secret).sensitive, false);
  assert.equal(changes.get(text).reason, null);
  assert.match(changes.get(oversized).reason, /64 MiB/);

  await assert.rejects(f.call('diff', { file: secret }), /Possível segredo/);
  const converted = await f.call('diff', { file: text });
  assert.match(converted.reason, /fins de linha/);
  await assert.rejects(f.call('commit', { message: 'não elegível', receipts: [converted.receipt] }), /indisponível/);
  const binary = await f.call('diff', { file: asset });
  assert.equal(binary.binary, true);
  assert.ok(binary.receipt);
  assert.equal(binary.reason, null);
});
