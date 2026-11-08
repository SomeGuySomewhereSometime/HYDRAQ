import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, access, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Antigravity } from '../lib/antigravity.mjs';
import { GUARD_HOOK, guardPaths, readOnlyPolicy, readOnlyCommand, shellWords, decide, guardCommand, ensureGuard, openGuard, closeGuard, guardDecisions } from '../lib/antigravity-guard.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const waitFor = async predicate => { const deadline = Date.now() + 4000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Tempo excedido.'); await new Promise(r => setTimeout(r, 10)); } };
const exists = file => access(file).then(() => true, () => false);
const temporary = async t => { const directory = await mkdtemp(path.join(os.tmpdir(), 'hydraq-agy-guard-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; };
const call = (name, args, stepIdx = 1, conversationId = 'conv-1234') => ({ conversationId, stepIdx, toolCall: { name, args }, artifactDirectoryPath: '/home/x/.gemini/antigravity-cli/brain/' + conversationId });

test('só leitura: caminhos do projeto, comandos simples e artefactos da sessão respeitam o hook', async t => {
  const directory = await temporary(t), cwd = path.join(directory, 'project');
  await mkdir(cwd);
  await writeFile(path.join(directory, 'fora.txt'), 'exterior');
  await symlink(path.join(directory, 'fora.txt'), path.join(cwd, 'atalho'));
  const policy = readOnlyPolicy(cwd), answer = (name, args) => decide(call(name, args), policy).decision;
  for (const name of ['read_file', 'view_file', 'list_dir', 'grep_search']) {
    assert.equal(answer(name, { Path: cwd }), 'ask', name);
    assert.equal(answer(name, {}), 'deny', name);
    assert.equal(answer(name, { Path: '../fora.txt' }), 'deny', name);
    assert.equal(answer(name, { Path: 'atalho' }), 'deny', name);
  }
  assert.equal(answer('search_web', { Query: 'exterior' }), 'deny');
  assert.equal(answer('write_file', { Path: '/home/x/.gemini/antigravity-cli/brain/conv-1234/task.md' }), 'ask');
  for (const target of ['/projeto/x.txt', '/home/x/.gemini/antigravity-cli/brain/conv-1234/../../settings.json', '/home/x/.gemini/antigravity-cli/brain/conv-12345/x', 'relativo.txt']) assert.equal(answer('write_file', { Path: target }), 'deny', target);
  for (const name of ['write_to_file', 'replace_file_content', 'multi_replace_file_content']) assert.equal(answer(name, { TargetFile: '/projeto/x' }), 'deny', name);
  for (const name of ['invoke_subagent', 'define_subagent', 'browser_subagent', 'execute_browser_javascript', 'schedule', 'send_command_input', 'unknown_tool']) assert.equal(answer(name, {}), 'deny', name);
  assert.equal(answer('call_mcp_tool', { ServerName: 'hydraq', ToolName: 'send_to_peer' }), 'deny');
  assert.equal(decide(call('call_mcp_tool', { ServerName: 'hydraq', ToolName: 'send_to_peer' }), { ...policy, mcp: { hydraq: ['send_to_peer'] } }).decision, 'ask');
  assert.equal(decide(call('call_mcp_tool', { ServerName: 'other', ToolName: 'send_to_peer' }), { ...policy, mcp: { hydraq: ['send_to_peer'] } }).decision, 'deny');
  assert.match(decide(call('write_file', { Path: '/p' }), policy).reason, /Planear\/Só leitura/);

  for (const line of ['ls -la', 'grep -rn "ensaio" .', 'cat README.md', 'find . -name "*.mjs"', 'rg -n guard lib', 'git status', 'git log --oneline -5', 'git diff HEAD~1', 'head -n 20 lib/x.mjs', 'nl -ba lib/x.mjs', 'du -sh lib']) assert.ok(readOnlyCommand(line), line);
  for (const line of ['touch y.txt', 'rm -rf .', 'ls; rm x', 'cat a | sh', 'ls && touch x', 'echo x > f', 'cat $(which sh)', 'ls `id`', 'find . -delete', 'find . -exec rm {} +', 'rg --pre=sh x', 'sort -o out in', 'sort -uo out in', 'tree -o out', 'git commit -m x', 'git -c core.pager=sh log', 'git diff --output=x', 'git diff --ext-diff', 'git grep -O x', 'git cat-file --filters HEAD:x', 'file -C -m probe.magic', 'file x', 'tree -R', 'sort -u notas.txt', 'sort --compress-program=sh x', 'date -s 2020-01-01', 'python3 -c 1', 'node x', 'sed -i s/a/b/ f', 'ls\nrm x', '', 'ls ' + 'a'.repeat(2001)]) assert.ok(!readOnlyCommand(line), line);
  assert.equal(answer('run_command', { CommandLine: 'ls -la' }), 'allow');
  assert.equal(answer('run_command', { CommandLine: 'touch y.txt' }), 'deny');

  // The words as bash passes them: quotes inside an option, find's -rm, rg's --hostname-bin, git's abbreviations
  // and joined flags, and unquoted patterns that could expand to an option.
  for (const line of ["find . -name sentinel.txt -de''lete", 'find . -name x "-del"ete', "find . -name x '-delete'", 'find . -name x -rm', "rg --p''re ./processor HYDRAQ input.txt", 'rg --hostname-bin=./x foo', 'git grep --op=sh x', "git grep --open-f''iles=sh x", 'git grep -nOsh x', 'git cat-file --filt HEAD:x', 'git diff --ext', 'find . -name *.js', 'rg foo lib/*', 'git log -- *.mjs', 'find . -name -[d]elete', "find . -name 'x", 'cat "a', 'ls\vx', 'ls\x00x']) assert.ok(!readOnlyCommand(line), line);
  for (const line of ["find . -name '*.mjs' -not -path './node_modules/*'", 'find . ! -name x', 'ls *.md', 'grep -n "a b" lib/*.mjs', "git log --oneline -- 'lib/*.mjs'", 'git grep -n foo', 'git diff --stat', 'git show --name-only HEAD', 'cat "README.md"', "rg -g '*.mjs' guard", 'find . -name x #-delete', 'grep -n "it\'s" a.txt']) assert.ok(readOnlyCommand(line), line);

  assert.equal(answer('read_url_content', { Url: 'http://127.0.0.1:4318/api/bootstrap' }), 'deny');
  assert.equal(answer('read_url_content', { Url: 'https://antigravity.google/docs' }), 'deny');
});

test('as palavras do filtro são as que a bash do agy passa ao programa', () => {
  const lines = ["find . -name sentinel.txt -de''lete", "rg --p''re ./processor HYDRAQ input.txt", 'a"b c"\'d\' e', "'' x", '"it\'s" \'a"b\'', 'a\t\tb  c', 'find . -name x #-delete y', 'x"#"y #z', "--op''en=1 -n'O'x", 'ls *.md "[x]"'];
  for (const line of lines) {
    const bash = execFileSync('bash', ['-c', 'set -f; set -- ' + line + '\nprintf "%s\\0" "$@"']).toString().split('\0').slice(0, -1);
    assert.deepEqual(shellWords(line).map(word => word.text), bash, line);
  }
  assert.deepEqual(shellWords('ls *.md "[x]" a?').map(word => word.glob), [false, true, false, true]);
});

test('o hook corre pelo shell, regista cada passo e só falha fechado nas conversas protegidas', async t => {
  const directory = await temporary(t), command = guardCommand({ directory });
  const run = (input, line = command) => JSON.parse(execFileSync('sh', ['-c', line], { input: typeof input === 'string' ? input : JSON.stringify(input) }).toString());
  assert.equal(run(call('write_file', { Path: '/p/x' })).decision, 'ask', 'sem regra: fluxo normal do agy');
  assert.equal(run('não é JSON').decision, 'ask');
  await openGuard(directory, 'conv-1234', readOnlyPolicy(directory));
  assert.equal(run(call('read_file', { Path: directory }, 2)).decision, 'ask');
  assert.equal(run(call('write_file', { Path: '/p/x.txt' }, 4)).decision, 'deny');
  assert.equal(run(call('run_command', { CommandLine: 'ls -la' }, 6)).decision, 'allow');
  assert.equal(run(call('run_command', { CommandLine: 'touch y.txt' }, 8)).decision, 'deny');
  assert.equal(run(call('run_command', { CommandLine: "find . -name sentinel.txt -de''lete" }, 9)).decision, 'deny');
  assert.equal(run(call('write_file', { Path: '/p/x' }, 9, 'other-5678')).decision, 'ask', 'outra conversa não é afetada');
  assert.deepEqual([...guardDecisions(directory, 'conv-1234')], [[2, 'ask'], [4, 'deny'], [6, 'allow'], [8, 'deny'], [9, 'deny']]);
  const missing = guardCommand({ directory, node: path.join(directory, 'no-node') });
  assert.equal(run(call('read_file', {}), missing).decision, 'deny', 'sem Node, a conversa protegida recusa');
  assert.equal(run(call('read_file', {}, 1, 'other-5678'), missing).decision, 'ask', 'sem Node, as restantes seguem normalmente');
  await writeFile(path.join(directory, 'conv-1234.json'), '{incompleto');
  assert.equal(run(call('read_file', {})).decision, 'deny', 'regra ilegível recusa');
  await openGuard(directory, 'conv-1234');
  assert.equal(guardDecisions(directory, 'conv-1234').size, 0, 'cada pedido começa sem decisões anteriores');
  closeGuard(directory, 'conv-1234');
  assert.equal(run(call('write_file', { Path: '/p/x' })).decision, 'ask');
  await assert.rejects(openGuard(directory, '../escape'), /inesperado/);
});

test('instalação junta só a entrada da HYDRAQ, guarda o original uma vez e não toca num ficheiro inválido', async t => {
  const directory = await temporary(t), hooksFile = path.join(directory, 'config', 'hooks.json'), guard = path.join(directory, 'guard');
  assert.equal(await ensureGuard({ hooksFile, directory: guard }), true);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(hooksFile, 'utf8'))), [GUARD_HOOK]);
  assert.equal(await exists(hooksFile + '.before-hydraq'), false, 'sem ficheiro anterior não há cópia');
  assert.equal(await ensureGuard({ hooksFile, directory: guard, node: '/outro/node' }), true);
  assert.equal(await exists(hooksFile + '.before-hydraq'), false, 'um ficheiro só com a entrada da HYDRAQ não precisa de cópia');
  const other = { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] };
  await writeFile(hooksFile, JSON.stringify({ lint: other }));
  assert.equal(await ensureGuard({ hooksFile, directory: guard }), true);
  const merged = JSON.parse(await readFile(hooksFile, 'utf8'));
  assert.deepEqual(merged.lint, other);assert.equal(merged[GUARD_HOOK].PreToolUse[0].matcher, '*');
  assert.equal(merged[GUARD_HOOK].PreToolUse[0].hooks[0].command, guardCommand({ directory: guard }));
  assert.deepEqual(JSON.parse(await readFile(hooksFile + '.before-hydraq', 'utf8')), { lint: other });
  assert.equal(await ensureGuard({ hooksFile, directory: guard }), false, 'já instalada: não reescreve');
  assert.equal(await ensureGuard({ hooksFile, directory: guard, node: '/outro/node' }), true, 'atualiza uma entrada desatualizada');
  assert.deepEqual(JSON.parse(await readFile(hooksFile + '.before-hydraq', 'utf8')), { lint: other }, 'a cópia do original não é substituída');
  await writeFile(hooksFile, '{inválido');
  await assert.rejects(ensureGuard({ hooksFile, directory: guard }), /não é JSON válido/);
  assert.equal(await readFile(hooksFile, 'utf8'), '{inválido');
});

test('o agy real usa a configuração da HOME com que corre; o simulado só com ficheiro indicado', () => {
  const real = new Antigravity({ dataDir: '/tmp/x', defaultCwd: '/tmp', env: { HOME: '/home/teste', PATH: '/usr/bin' } });
  assert.deepEqual({ hooksFile: real.hooksFile, directory: real.guardDirectory, mcpFile: real.mcpFile, routeDirectory: real.routeDirectory }, guardPaths('/home/teste'));
  assert.equal(real.mcpFile, '/home/teste/.gemini/config/mcp_config.json');
  const simulated = new Antigravity({ dataDir: '/tmp/x', defaultCwd: '/tmp', prefixArgs: ['fake.mjs'], env: { HOME: '/home/teste' } });
  for (const key of ['hooksFile', 'guardDirectory', 'mcpFile', 'routeDirectory']) assert.equal(simulated[key], null, key);
});

async function setup(t, env = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hydraq-agy-guard-')), hooksFile = path.join(directory, 'agy-config', 'hooks.json'), guardDirectory = path.join(directory, 'guard');
  await writeFile(path.join(directory, 'README.md'), 'Projeto de teste.\n');
  const options = { dataDir: path.join(directory, 'state'), defaultCwd: directory, settingsFile: path.join(directory, 'settings.json'), executable: process.execPath, prefixArgs: [path.join(root, 'test/fixtures/fake-agy.mjs')], env: { ...process.env, FAKE_AGY_HOOKS: hooksFile, ...env }, hooksFile, guardDirectory };
  const client = new Antigravity(options), clients = [client];
  t.after(async () => { for (const instance of clients) await instance.close(); await rm(directory, { recursive: true, force: true }); });
  await client.load(); await client.connect();
  return { client, clients, directory, hooksFile, guardDirectory, options };
}

test('Planear no agy: regra ativa antes do primeiro pedido, escrita e comandos recusados, regra retirada no fim e sem --mode plan', async t => {
  const { client, directory, hooksFile, guardDirectory } = await setup(t);
  const c = await client.create({ cwd: directory, model: 'gemini-4-argon', effort: 'low', sandbox: 'plan' });
  await client.send(c.id, 'guard-tools', 'g1'); await waitFor(() => c.status === 'completed');
  assert.equal(c.messages.at(-1).text, 'read_file:ok run_command:ok write_file:recusada write_file:ok run_command:recusada');
  assert.equal(c.turns[0].readOnlyGuard, true);
  assert.ok(JSON.parse(await readFile(hooksFile, 'utf8'))[GUARD_HOOK]);
  assert.equal(await exists(path.join(guardDirectory, c.threadId + '.json')), false, 'a regra só existe durante o pedido');
  await client.send(c.id, 'olá', 'g2'); await waitFor(() => c.turns.length === 2 && c.status === 'completed');
  assert.match(c.messages.at(-1).text, /modo request-review/);
  await client.send(c.id, 'guard-tools', 'g3', { sandbox: 'workspace-write' }); await waitFor(() => c.turns.length === 3 && c.status === 'completed');
  assert.equal(c.messages.at(-1).text, 'read_file:ok run_command:ok write_file:ok write_file:ok run_command:ok');
  assert.equal(c.turns[2].readOnlyGuard, undefined);
});

test('o modo do processo segue o pedido, também quando a conversa volta de Planear com o modo anterior', async t => {
  const { client, directory } = await setup(t);
  const c = await client.create({ cwd: directory, model: 'gemini-4-argon', effort: 'low', sandbox: 'accept-edits' });
  await client.send(c.id, 'olá', 'm1'); await waitFor(() => c.status === 'completed');
  assert.match(c.messages.at(-1).text, /modo accept-edits/);
  await client.send(c.id, 'olá', 'm2', { sandbox: 'plan' }); await waitFor(() => c.turns.length === 2 && c.status === 'completed');
  assert.match(c.messages.at(-1).text, /modo request-review/);
  const planPid = client.session.child.pid;
  c.sandbox = 'accept-edits'; // what the Hydra gives back, while the warm process still runs Planear
  await client.send(c.id, 'olá', 'm3'); await waitFor(() => c.turns.length === 3 && c.status === 'completed');
  assert.match(c.messages.at(-1).text, /modo accept-edits/);
  assert.notEqual(client.session.child.pid, planPid, 'novo processo com o modo pedido');
});

test('uma ferramenta que a proteção não viu para o pedido, sem o repetir', async t => {
  const { client, directory, guardDirectory } = await setup(t, { FAKE_AGY_SKIP_HOOKS: 'write_file' });
  const c = await client.create({ cwd: directory, model: 'gemini-4-argon', effort: 'low', sandbox: 'plan' });
  await client.send(c.id, 'guard-hold-write', 'skip'); await waitFor(() => c.status === 'failed');
  assert.match(c.error, /não confirmou write_file/);assert.equal(c.turns.length, 1);assert.equal(c.turns[0].status, 'failed');
  await waitFor(() => !client.session);
  assert.equal(await exists(path.join(guardDirectory, c.threadId + '.json')), false);
});

test('sem a proteção instalável, o pedido Planear não começa; uma regra antiga sai ao carregar', async t => {
  const { client, clients, directory, hooksFile, guardDirectory, options } = await setup(t);
  await mkdir(path.dirname(hooksFile), { recursive: true }); await writeFile(hooksFile, '{inválido');
  const c = await client.create({ cwd: directory, model: 'gemini-4-argon', effort: 'low', sandbox: 'plan' });
  await assert.rejects(client.send(c.id, 'guard-tools', 'blocked'), /proteção só de leitura do agy/);
  assert.equal(c.turns.length, 0);assert.equal(await readFile(hooksFile, 'utf8'), '{inválido');
  await writeFile(hooksFile, '{}');
  await client.send(c.id, 'olá', 'ok'); await waitFor(() => c.status === 'completed');
  await openGuard(guardDirectory, c.threadId); await client.close();
  const reopened = new Antigravity(options); clients.push(reopened); await reopened.load();
  assert.equal(await exists(path.join(guardDirectory, c.threadId + '.json')), false);
});
