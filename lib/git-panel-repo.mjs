import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

export const MAX_FILE = 64 * 1024 * 1024;
export const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const noFollow = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const utf8 = new TextDecoder('utf8', { fatal: true, ignoreBOM: true });
export const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const withoutGitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const baseEnv = { ...withoutGitEnv, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', LC_ALL: 'C' };
const prefix = ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
  '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.splitIndex=false'];
export function git(cwd, args, { input, env = {}, allowed = [], timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...prefix, ...args], {
      cwd, env: { ...baseEnv, ...env }, timeout, maxBuffer: MAX_FILE + 65536, encoding: 'buffer',
    }, (error, stdout, stderr) => {
      if (error && !allowed.includes(error.code)) {
        const message = stderr.toString().trim().slice(0, 1200);
        reject(Object.assign(fail(message || 'O Git não concluiu a operação.'), { gitCode: error.code }));
      } else resolve({ stdout, code: error?.code || 0 });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export const gitText = async (...args) => (await git(...args)).stdout.toString().trimEnd();
export function gitSession(cwd, args) {
  return spawn('git', [...prefix, ...args], { cwd, env: baseEnv, stdio: ['pipe', 'pipe', 'pipe'] });
}

export function validPath(file) {
  if (typeof file !== 'string' || file.length > 4096 || file.split('/').some(part => !part || part === '.' ||
    part === '..' || /^(?:\.git|\.hydraq)$/i.test(part)) || /[\x00-\x1f\x7f]/.test(file)) {
    throw fail('Este caminho não é suportado pelo painel.');
  }
  return file;
}
export function sensitive(file, bytes) {
  if (/(^|\/)(?:\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials\.json)(?:$|\/)|\.(?:pem|key|p12|pfx|keystore)$/i.test(file) &&
    !/\.env\.(?:example|sample|template)$/i.test(file)) return true;
  return bytes && /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:ghp_|github_pat_|sk-(?:proj-)?|xox[baprs]-|AKIA)[A-Za-z0-9_-]{16,}/.test(bytes.subarray(0, 2 ** 20).toString());
}
export const blobId = (bytes, format) => createHash(format).update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
export const regular = item => !item || ['100644', '100755'].includes(item.mode);
export const sameEntry = (a, b) => (a?.oid || null) === (b?.oid || null) && (a?.mode || null) === (b?.mode || null);
export const absent = error => error.code === 'ENOENT';

export async function withParent(root, file, action, { create = false } = {}) {
  const pieces = validPath(file).split('/');
  const name = pieces.pop();
  let folder = await open(root, noFollow | constants.O_DIRECTORY);
  try {
    for (const part of pieces) {
      const child = '/proc/self/fd/' + folder.fd + '/' + part;
      if (create) await mkdir(child).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const next = await open(child, noFollow | constants.O_DIRECTORY);
      await folder.close();
      folder = next;
    }
    return await action('/proc/self/fd/' + folder.fd + '/' + name, folder);
  } finally { await folder.close(); }
}
// update-index --index-info writes entries without stat data. Remember hashes
// of verified reads (including diff previews) so those entries can also become
// cheap to list. This cache holds metadata only, and is never used for racy files.
const observed = new Map();
const observedLimit = 20_000;
function remember(key, oid, info) {
  observed.delete(key);
  if (observed.size >= observedLimit) observed.delete(observed.keys().next().value);
  observed.set(key, { oid, info });
}
function matchesObservation(previous, disk, oid, indexMtime) {
  if (!previous || indexMtime === undefined || disk.mtimeNs >= indexMtime || disk.ctimeNs >= indexMtime) return false;
  return previous.oid === oid && ['dev', 'ino', 'ctimeNs', 'mtimeNs', 'size', 'mode', 'uid', 'gid']
    .every(field => previous.info[field] === disk[field]);
}

export async function diskFile(root, file, { read = true, cached, indexMtime, format } = {}) {
  try {
    return await withParent(root, file, async target => {
      const info = await lstat(target, { bigint: true });
      if (!info.isFile()) return { unsupported: 'Apenas ficheiros regulares são suportados.' };
      const mode = info.mode & 0o100n ? '100755' : '100644';
      const size = Number(info.size);
      const key = format && [format, root, file].join('\0');
      if (mode === cached?.mode && (matchesIndexStat(cached.stat, info, indexMtime) ||
        matchesObservation(observed.get(key), info, cached.oid, indexMtime))) {
        return { mode, size, oid: cached.oid };
      }
      if (info.size > BigInt(MAX_FILE)) return { mode, size, unsupported: 'Ficheiro acima de 64 MiB. Considera Git LFS.' };
      if (!read) return { mode, size };
      // The observation must postdate the file even on a filesystem with
      // one-second timestamps. Otherwise a same-tick write could reuse it.
      const observedAfter = key ? BigInt(Math.floor(Date.now() / 1000)) * 1_000_000_000n : 0n;
      const handle = await open(target, noFollow);
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.size > BigInt(MAX_FILE)) throw fail('O ficheiro mudou durante a leitura.');
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        const current = await lstat(target, { bigint: true });
        if (offset !== bytes.length || after.ctimeNs !== before.ctimeNs || current.ino !== before.ino || current.dev !== before.dev ||
          current.ctimeNs !== before.ctimeNs) throw fail('O ficheiro mudou durante a leitura.');
        const file = { mode: before.mode & 0o100n ? '100755' : '100644', size: bytes.length, bytes };
        if (key) {
          file.oid = blobId(bytes, format);
          if (before.ctimeNs < observedAfter && before.mtimeNs < observedAfter) remember(key, file.oid, before);
        }
        return file;
      } finally { await handle.close(); }
    });
  } catch (error) {
    if (absent(error)) return null;
    if (['ELOOP', 'ENOTDIR'].includes(error.code)) return { unsupported: 'O caminho atravessa uma ligação ou deixou de ser uma pasta.' };
    throw error;
  }
}

const split = bytes => utf8.decode(bytes).split('\0').filter(Boolean);
function storeEntry(entries, line, index, stat) {
  const tab = line.indexOf('\t');
  const [mode, a, b] = line.slice(0, tab).split(' ');
  const file = line.slice(tab + 1);
  const stage = index ? Number(b) : 0;
  entries.set(file, { mode, oid: index ? a : b, stage: stage || entries.get(file)?.stage || 0, ...(stat ? { stat } : {}) });
}
function parseEntries(bytes, index) {
  const entries = new Map();
  for (const line of split(bytes)) storeEntry(entries, line, index);
  return entries;
}

// With -z the path is NUL-terminated, including when it contains a newline.
// Git documents --debug as unstable. Fall back to the normal index listing if
// the cache metadata does not have exactly the format we understand.
function parseIndexStat(bytes) {
  const text = utf8.decode(bytes);
  const entries = new Map();
  const debug = /  ctime: (\d+):(\d+)\n  mtime: (\d+):(\d+)\n  dev: (\d+)\tino: (\d+)\n  uid: (\d+)\tgid: (\d+)\n  size: (\d+)\tflags: ([a-fA-F0-9]+)\n/y;
  let offset = 0;
  while (offset < text.length) {
    const end = text.indexOf('\0', offset);
    if (end < 0) return null;
    const line = text.slice(offset, end);
    if (!/^[0-7]{6} (?:[a-f0-9]{40}|[a-f0-9]{64}) [0-3]\t/.test(line)) return null;
    debug.lastIndex = end + 1;
    const match = debug.exec(text);
    if (!match) return null;
    const [ctimeS, ctimeN, mtimeS, mtimeN, dev, ino, uid, gid, size] = match.slice(1, 10).map(BigInt);
    const stat = match[10] === '0' ? {
      ctimeNs: ctimeS * 1_000_000_000n + ctimeN, mtimeNs: mtimeS * 1_000_000_000n + mtimeN,
      dev, ino, uid, gid, size,
    } : null;
    storeEntry(entries, line, true, stat);
    offset = debug.lastIndex;
  }
  return entries;
}
function matchesIndexStat(cached, disk, indexMtime) {
  // Racy Git: a same-tick write can leave cached stat fields unchanged.
  if (!cached || indexMtime === undefined || disk.mtimeNs >= indexMtime) return false;
  return cached.ctimeNs === disk.ctimeNs && cached.mtimeNs === disk.mtimeNs && cached.size === disk.size &&
    cached.dev === BigInt.asUintN(32, disk.dev) && cached.ino === BigInt.asUintN(32, disk.ino) &&
    cached.uid === disk.uid && cached.gid === disk.gid;
}
async function indexStat(repo) {
  const indexFile = path.join(repo.gitDir, 'index');
  const stat = () => lstat(indexFile, { bigint: true }).catch(error => {
    if (absent(error)) return null;
    throw error;
  });
  const before = await stat();
  if (!before?.isFile()) return { entries: await indexEntries(repo.root) };
  const parsed = await git(repo.root, ['ls-files', '--stage', '--debug', '-z'])
    .then(result => parseIndexStat(result.stdout)).catch(() => null);
  if (!parsed) return { entries: await indexEntries(repo.root) };
  const after = await stat();
  const stable = after?.isFile() && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.ctimeNs === after.ctimeNs && before.mtimeNs === after.mtimeNs;
  return { entries: parsed, indexMtime: stable ? before.mtimeNs : undefined };
}
export async function treeEntries(root, ref) {
  return ref ? parseEntries((await git(root, ['ls-tree', '-r', '-z', ref])).stdout, false) : new Map();
}
export async function indexEntries(root, env) {
  return parseEntries((await git(root, ['ls-files', '-s', '-z'], { env })).stdout, true);
}
export async function branchState(root) {
  const [branch, head] = await Promise.all([
    gitText(root, ['symbolic-ref', '--quiet', '--no-recurse', 'HEAD'], { allowed: [1] }),
    gitText(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowed: [1] }),
  ]);
  return { branch: branch || null, head: head || null };
}
export async function repoAt(root) {
  const probe = await git(root, ['rev-parse', '--show-toplevel'], { allowed: [128] });
  if (probe.code) {
    try { await lstat(path.join(root, '.git')); } catch (error) { if (absent(error)) return null; throw error; }
    throw fail('O Git não conseguiu abrir o repositório do projeto.');
  }
  const top = probe.stdout.toString().trimEnd();
  if (top !== root) throw fail('Regista a raiz do repositório como projeto para usar o painel Git.');
  const gitDir = path.join(root, '.git');
  if (await gitText(root, ['rev-parse', '--absolute-git-dir']) !== gitDir || !(await lstat(gitDir)).isDirectory() || await realpath(gitDir) !== gitDir) {
    throw fail('Abre o projeto na worktree principal do repositório.');
  }
  const format = await gitText(root, ['rev-parse', '--show-object-format']);
  const refs = await gitText(root, ['rev-parse', '--show-ref-format']);
  if (refs !== 'files') throw fail('O painel requer um Git recente com referências no formato files.');
  if (!['sha1', 'sha256'].includes(format)) throw fail('Formato de objetos Git não suportado.');
  return { root, gitDir, format, ...await branchState(root) };
}

export const config = (root, key, type) => gitText(root,
  ['config', ...(type ? ['--type=' + type] : []), '--get', key], { allowed: [1] });
export async function writeReady(repo, { allowDetached = false } = {}) {
  if (!allowDetached && !repo.branch?.startsWith('refs/heads/')) throw fail('Seleciona uma branch local antes desta operação.');
  const metadata = await readdir(repo.gitDir);
  if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer', 'BISECT_START'].some(name => metadata.includes(name))) {
    throw fail('Termina a operação Git que está em curso no terminal.');
  }
  if (await config(repo.root, 'core.sparseCheckout', 'bool') === 'true') throw fail('Sparse checkout requer o Git no terminal.');
}
const attrNames = ['filter', 'text', 'eol', 'ident', 'working-tree-encoding', 'crlf'];
export async function attributes(root, files, source) {
  if (!files.length) return new Map();
  const input = Buffer.from(files.join('\0') + '\0');
  const values = split((await git(root, ['check-attr', ...(source ? ['--source=' + source] : []), '-z', '--stdin', ...attrNames], { input })).stdout);
  const byFile = new Map();
  for (let i = 0; i < values.length; i += 3) {
    const [file, key, value] = values.slice(i, i + 3);
    if (!byFile.has(file)) byFile.set(file, {});
    byFile.get(file)[key] = value;
  }
  return byFile;
}
export function conversion(attrs, auto, bytes) {
  const set = key => attrs?.[key] && !['unspecified', 'unset'].includes(attrs[key]);
  if (set('filter')) return 'Filtro Git ativo (por exemplo, LFS). Usa o terminal.';
  if (set('ident') || set('working-tree-encoding')) return 'O Git aplica uma conversão de conteúdo a este ficheiro.';
  if (bytes?.includes(13) && (set('text') || set('crlf') || set('eol') || (auto && auto !== 'false' && attrs?.text !== 'unset'))) {
    return 'O Git pode converter os fins de linha deste ficheiro.';
  }
  return null;
}
export async function listChanges(repo) {
  const { root, head, format } = repo;
  const [base, { entries: index, indexMtime }, others, auto] = await Promise.all([
    treeEntries(root, head), indexStat(repo),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']).then(result => split(result.stdout)),
    config(root, 'core.autocrlf'),
  ]);
  const paths = [...new Set([...base.keys(), ...index.keys(), ...others])].sort();
  const candidates = [];
  const attributePaths = [];
  for (const file of paths) {
    const prior = base.get(file), stagedEntry = index.get(file);
    const staged = Boolean(stagedEntry?.stage) || !sameEntry(prior, stagedEntry);
    let reason = null, current;
    try { validPath(file); } catch (error) { reason = error.message; }
    if (!regular(prior) || !regular(stagedEntry)) reason = 'Ligação simbólica ou submódulo. Usa o terminal.';
    if (!reason) {
      // New files are already known to differ. Their bytes are checked when
      // opening the diff, before the panel issues a selectable receipt.
      current = await diskFile(root, file, {
        read: Boolean(prior || stagedEntry), cached: stagedEntry?.stage ? null : stagedEntry, indexMtime, format,
      });
      reason = current?.unsupported;
    }
    if (!reason && !staged && sameEntry(prior, current)) continue;
    if (!reason) attributePaths.push(file);
    candidates.push({ file, prior, staged, reason, size: current?.size ?? null,
      missing: !current, hasCR: current?.bytes?.includes(13), secret: Boolean(sensitive(file, current?.bytes)) });
  }
  const attrs = await attributes(root, attributePaths);
  return candidates.map(({ file, prior, staged, reason, size, missing, hasCR, secret }) => {
    reason ||= conversion(attrs.get(file), auto, hasCR ? Buffer.from([13]) : undefined);
    return { file, status: !prior ? 'Novo' : missing && !reason ? 'Apagado' : 'Alterado', staged,
      reason: reason || (staged ? 'Já tem preparação no índice Git.' : null),
      sensitive: secret, size, large: (size || 0) >= 20 * 1024 * 1024 };
  });
}
export async function readBlob(root, entry) {
  if (!entry) return null;
  if (!regular(entry)) return { mode: entry.mode, oid: entry.oid, unsupported: 'Ligação simbólica ou submódulo.' };
  const size = Number(await gitText(root, ['cat-file', '-s', entry.oid]));
  return { ...entry, size, ...(size <= MAX_FILE ? { bytes: (await git(root, ['cat-file', 'blob', entry.oid])).stdout } : {}) };
}
export async function writeBlob(root, bytes) {
  const oid = await gitText(root, ['hash-object', '-w', '--no-filters', '--stdin'], { input: bytes });
  if (!oidPattern.test(oid)) throw fail('O Git não devolveu um identificador de blob válido.');
  return oid;
}
export function indexPatch(entries, zero) {
  return Buffer.from([...entries].map(([file, entry]) => entry ? entry.mode + ' ' + entry.oid + '\t' + file + '\0'
    : '0 ' + zero + '\t' + file + '\0').join(''));
}
export const token = () => randomUUID();
