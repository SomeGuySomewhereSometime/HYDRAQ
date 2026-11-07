import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { copyFile, link, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  absent, branchState, config, fail, git, gitSession, gitText, indexEntries, indexPatch, sameEntry,
  token, treeEntries, writeReady,
} from './git-panel-repo.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const indexPath = repo => path.join(repo.gitDir, 'index');
const lockPath = repo => indexPath(repo) + '.lock';
const journalPath = repo => path.join(repo.gitDir, 'hydraq-panel-journal.json');
const privatePath = (repo, id) => path.join(repo.gitDir, 'hydraq-panel-' + id);
const readOptional = file => readFile(file).catch(error => { if (absent(error)) return null; throw error; });
const zero = repo => '0'.repeat(repo.format === 'sha1' ? 40 : 64);
const fingerprint = bytes => bytes === null ? null : digest(bytes);
const processStart = async pid => {
  const stat = await readOptional('/proc/' + pid + '/stat');
  return stat ? stat.toString().slice(stat.toString().lastIndexOf(')') + 2).split(' ')[19] : null;
};
const bootId = async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();

async function syncFile(file) {
  const handle = await open(file, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
const active = new Set();
async function writeJournal(repo, journal, { claim = false } = {}) {
  const temporary = path.join(privatePath(repo, journal.id), 'journal');
  await writeFile(temporary, JSON.stringify(journal), { mode: 0o600 });
  await syncFile(temporary);
  if (claim) {
    try { await link(temporary, journalPath(repo)); }
    catch (error) {
      if (error.code === 'EEXIST') throw fail('Há uma operação Git por recuperar neste projeto.');
      throw error;
    }
    await unlink(temporary);
  } else await rename(temporary, journalPath(repo));
  await syncFile(repo.gitDir);
}
export async function readJournal(repo) {
  const bytes = await readOptional(journalPath(repo));
  if (!bytes) return null;
  const record = JSON.parse(bytes);
  if (record.version !== 1 || !/^[a-f0-9-]{36}$/.test(record.id) || !Array.isArray(record.entries) ||
    !record.branch?.startsWith('refs/heads/')) throw fail('O diário Git precisa de inspeção no terminal.');
  return record;
}
async function ownsLock(repo, anchor, lock = lockPath(repo)) {
  const [own, current] = await Promise.all([lstat(anchor, { bigint: true }), lstat(lock, { bigint: true })])
    .catch(error => { if (absent(error)) return []; throw error; });
  return Boolean(own?.isFile() && current?.isFile() && own.ino === current.ino && own.dev === current.dev);
}
async function unlinkOwn(repo, anchor, lock = lockPath(repo)) {
  if (await ownsLock(repo, anchor, lock)) await unlink(lock).catch(error => { if (!absent(error)) throw error; });
}
async function lockIndex(repo, anchor) {
  await writeFile(anchor, '', { mode: 0o600, flag: 'wx' });
  try { await link(anchor, lockPath(repo)); }
  catch (error) {
    if (error.code === 'EEXIST') throw fail('O índice Git está ocupado. Termina a operação no terminal.');
    throw error;
  }
}
async function withHead(repo, action, anchor) {
  const child = gitSession(repo.root, ['update-ref', '--stdin']);
  const done = new Promise(resolve => { child.once('close', resolve); child.once('error', resolve); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    child.stdin.write('start\noption no-deref\nsymref-verify HEAD ' + repo.branch + '\nprepare\n');
    if ((await iterator.next()).value !== 'start: ok' || (await iterator.next()).value !== 'prepare: ok') {
      throw fail('A branch mudou ou está ocupada. Revê o estado antes de continuar.');
    }
    clearTimeout(timeout);
    if (anchor) await link(path.join(repo.gitDir, 'HEAD.lock'), anchor);
    return await action(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw fail('Perdeu-se o bloqueio da branch.');
    });
  } finally {
    clearTimeout(timeout);
    child.stdin.end('abort\n');
    await done;
    lines.close();
  }
}
async function updateIndex(repo, target, entries) {
  const env = { GIT_INDEX_FILE: target };
  await git(repo.root, ['update-index', '-z', '--index-info'], { env, input: indexPatch(entries, zero(repo)) });
}
async function stageIndex(repo, directory, entries, original, anchor) {
  const next = path.join(directory, 'next-index');
  if (original) await writeFile(next, original, { mode: 0o600 });
  else await git(repo.root, ['read-tree', '--empty'], { env: { GIT_INDEX_FILE: next } });
  await updateIndex(repo, next, entries);
  await copyFile(next, anchor);
  await syncFile(anchor);
  return fingerprint(await readFile(anchor));
}
async function publishIndex(repo, anchor) {
  if (!await ownsLock(repo, anchor)) throw fail('O bloqueio do índice mudou. O painel conservou o diário.');
  await rename(lockPath(repo), indexPath(repo));
  await syncFile(repo.gitDir);
}
const currentRef = (repo, ref) => gitText(repo.root, ['rev-parse', '--verify', '--quiet', ref], { allowed: [1] }).then(value => value || null);
const baseMatches = (a, b) => a.branch === b.branch && a.head === b.head;

async function checkSelected(root, entries, base) {
  const [index, flags] = await Promise.all([
    indexEntries(root), gitText(root, ['ls-files', '-v', '-z']),
  ]);
  const special = new Set(flags.split('\0').filter(line => /^[Ssa-z] /.test(line)).map(line => line.slice(2)));
  if ([...index.values()].some(entry => entry.stage)) throw fail('Resolve os conflitos no índice Git primeiro.');
  for (const file of entries.keys()) {
    if (special.has(file)) throw fail('Este ficheiro tem opções especiais no índice. Usa o terminal: ' + file);
    if (!sameEntry(index.get(file), base.get(file))) throw fail('Este ficheiro já tem alterações preparadas no terminal: ' + file);
  }
}
async function makeCommit(repo, directory, entries, base, message, checkTree) {
  const env = { GIT_INDEX_FILE: path.join(directory, 'commit-index') };
  await git(repo.root, ['read-tree', ...(repo.head ? [repo.head] : ['--empty'])], { env });
  await updateIndex(repo, env.GIT_INDEX_FILE, entries);
  const tree = await gitText(repo.root, ['write-tree'], { env });
  const expected = new Map(base);
  for (const [file, entry] of entries) {
    if (entry) expected.set(file, entry);
    else expected.delete(file);
  }
  const actual = await treeEntries(repo.root, tree);
  if (expected.size !== actual.size || [...expected].some(([file, entry]) => !sameEntry(entry, actual.get(file)))) {
    throw fail('A árvore do commit não corresponde à seleção revista.');
  }
  await checkTree?.(tree);
  if (repo.head && tree === await gitText(repo.root, ['rev-parse', repo.head + '^{tree}'])) throw fail('A seleção não altera o commit atual.');
  if (await config(repo.root, 'commit.gpgSign', 'bool') === 'true') {
    throw fail('Este repositório exige commits assinados. Usa o terminal para assinar.');
  }
  await git(repo.root, ['-c', 'user.useConfigOnly=true', 'var', 'GIT_AUTHOR_IDENT'])
    .catch(() => { throw fail('Configura user.name e user.email no Git antes de criar o commit.'); });
  return gitText(repo.root, ['-c', 'user.useConfigOnly=true', 'commit-tree', '--no-gpg-sign', tree,
    ...(repo.head ? ['-p', repo.head] : []), '-F', '-'], { input: message.trim() + '\n' });
}

async function removeHelper(repo, helper) {
  try { await lstat(helper); }
  catch (error) { if (absent(error)) return; throw error; }
  await git(repo.root, ['worktree', 'remove', '--force', helper]);
}
async function cleanup(repo, record, { removeJournal = true } = {}) {
  const directory = privatePath(repo, record.id);
  await unlinkOwn(repo, path.join(directory, 'index-anchor'));
  await unlinkOwn(repo, path.join(directory, 'repair-anchor'));
  await unlinkOwn(repo, path.join(directory, 'head-anchor'), path.join(repo.gitDir, 'HEAD.lock'));
  await unlinkOwn(repo, path.join(directory, 'repair-head'), path.join(repo.gitDir, 'HEAD.lock'));
  await removeHelper(repo, path.join(directory, 'worktree'));
  if (removeJournal) {
    await unlink(journalPath(repo)).catch(error => { if (!absent(error)) throw error; });
    await syncFile(repo.gitDir);
  }
  await rm(directory, { recursive: true, force: true });
}

export async function commitReviewed(repo, entries, message, { checkTree, beforeRef, afterRef } = {}) {
  await writeReady(repo);
  if (await readJournal(repo)) throw fail('Há uma operação Git por recuperar neste projeto.');
  const id = token();
  const directory = privatePath(repo, id);
  const anchor = path.join(directory, 'index-anchor');
  const helper = path.join(directory, 'worktree');
  await mkdir(directory, { mode: 0o700 });
  let journal;
  let recorded = false;
  let publishing = false;
  try {
    journal = {
      version: 1, id, pid: process.pid, processStart: await processStart(process.pid), boot: await bootId(),
      branch: repo.branch, head: repo.head, commit: null, entries: [...entries], phase: 'locking',
    };
    active.add(id);
    await writeJournal(repo, journal, { claim: true });
    recorded = true;
    await lockIndex(repo, anchor);
    if (!baseMatches(repo, await branchState(repo.root))) throw fail('A branch ou o commit de origem mudou. Volta a rever.');
    const base = await treeEntries(repo.root, repo.head);
    await checkSelected(repo.root, entries, base);
    const original = await readOptional(indexPath(repo));
    const commit = await makeCommit(repo, directory, entries, base, message, checkTree);
    const nextIndex = await stageIndex(repo, directory, entries, original, anchor);
    Object.assign(journal, { commit, oldIndex: fingerprint(original), nextIndex, phase: 'prepared' });
    await writeJournal(repo, journal);
    recorded = true;
    await git(repo.root, ['worktree', 'add', '--detach', '--no-checkout', helper, commit]);
    await withHead(repo, async assertHeld => {
      await beforeRef?.(journal);
      assertHeld();
      // HEAD stays locked until the index is published. Updating the named branch
      // from the detached helper avoids a second, implicit HEAD lock.
      journal.phase = 'publishing';
      await writeJournal(repo, journal);
      publishing = true;
      await git(helper, ['update-ref', '--no-deref', '-m', 'HYDRAQ: commit revisto', repo.branch, commit, repo.head || zero(repo)]);
      await afterRef?.(journal);
      journal.phase = 'advanced';
      await writeJournal(repo, journal);
      if (await currentRef(repo, repo.branch) !== commit) throw fail('A branch voltou a mudar. O painel conservou o diário.');
      assertHeld();
      await publishIndex(repo, anchor);
    }, path.join(directory, 'head-anchor'));
    await cleanup(repo, journal);
    return { commit, branch: repo.branch };
  } catch (error) {
    // A child may have published the reference before a timeout or disconnect.
    if (!publishing) {
      await cleanup(repo, { id }, { removeJournal: recorded }).catch(() => {});
    }
    if (publishing) throw fail('O Git pode ter avançado a branch. Consulta a recuperação no painel antes de repetir. ' + error.message);
    throw error;
  } finally { active.delete(id); }
}

async function journalStatus(repo, journal) {
  const alive = journal.pid === process.pid ? active.has(journal.id)
    : journal.boot === await bootId() && journal.processStart === await processStart(journal.pid);
  if (journal.phase === 'locking') return { commit: null, branch: journal.branch, head: journal.head, alive,
    canRepair: false, canClear: !alive };
  const head = await currentRef(repo, journal.branch);
  const index = fingerprint(await readOptional(indexPath(repo)));
  const selected = (await branchState(repo.root)).branch === journal.branch;
  return {
    commit: journal.commit, branch: journal.branch, head, alive,
    canRepair: !alive && selected && head === journal.commit && index !== journal.nextIndex,
    canClear: !alive && (head === journal.commit && index === journal.nextIndex ||
      head === journal.head && ['prepared', 'publishing'].includes(journal.phase) && index === journal.oldIndex),
  };
}
export async function recoveryStatus(repo) {
  const journal = await readJournal(repo);
  return journal && journalStatus(repo, journal);
}
export async function recoverCommit(repo, action) {
  const journal = await readJournal(repo);
  if (!journal) throw fail('Não há operação por recuperar.');
  const status = await journalStatus(repo, journal);
  if (status.alive) throw fail('O processo que reservou o índice ainda está ativo.');
  if (action === 'clear' && status.canClear) {
    await cleanup(repo, journal);
    return { cleared: true };
  }
  if (action !== 'repair' || !status.canRepair) throw fail('A branch ou o índice mudou. Consulta o diário no terminal.');
  await writeReady(repo);
  const directory = privatePath(repo, journal.id);
  const anchor = path.join(directory, 'index-anchor');
  const repair = path.join(directory, 'repair-anchor');
  const entries = new Map(journal.entries);
  const base = await treeEntries(repo.root, journal.head);
  await unlinkOwn(repo, anchor);
  await unlinkOwn(repo, repair);
  const repairHead = path.join(directory, 'repair-head');
  await unlinkOwn(repo, path.join(directory, 'head-anchor'), path.join(repo.gitDir, 'HEAD.lock'));
  await unlinkOwn(repo, repairHead, path.join(repo.gitDir, 'HEAD.lock'));
  await unlink(repairHead).catch(error => { if (!absent(error)) throw error; });
  await unlink(repair).catch(error => { if (!absent(error)) throw error; });
  await lockIndex(repo, repair);
  try {
    await withHead({ ...repo, branch: journal.branch }, async assertHeld => {
      if (await currentRef(repo, journal.branch) !== journal.commit) throw fail('A branch mudou desde o commit.');
      await checkSelected(repo.root, entries, base);
      journal.nextIndex = await stageIndex(repo, directory, entries, await readOptional(indexPath(repo)), repair);
      journal.phase = 'advanced';
      await writeJournal(repo, journal);
      assertHeld();
      await publishIndex(repo, repair);
    }, repairHead);
    await cleanup(repo, journal);
    return { repaired: true, commit: journal.commit };
  } finally { await unlinkOwn(repo, repair); }
}

export async function withWorktreeIndex(repo, action) {
  const id = token();
  const directory = privatePath(repo, id);
  const anchor = path.join(directory, 'index-anchor');
  await mkdir(directory, { mode: 0o700 });
  let recorded = false;
  active.add(id);
  try {
    const journal = { version: 1, id, pid: process.pid, processStart: await processStart(process.pid), boot: await bootId(),
      branch: repo.branch, head: repo.head, commit: null, entries: [], phase: 'locking' };
    await writeJournal(repo, journal, { claim: true });
    recorded = true;
    await lockIndex(repo, anchor);
    return await withHead(repo, async assertHeld => {
      if (!baseMatches(repo, await branchState(repo.root))) throw fail('A branch ou o commit de origem mudou. Volta a rever.');
      assertHeld();
      return action();
    }, path.join(directory, 'head-anchor'));
  } finally {
    active.delete(id);
    await cleanup(repo, { id }, { removeJournal: recorded });
  }
}
