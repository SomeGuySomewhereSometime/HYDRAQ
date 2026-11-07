import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  absent, blobId, diskFile, fail, git, gitText, oidPattern, regular, sameEntry, sensitive, token, withParent,
} from './git-panel-repo.mjs';

const backupRoot = repo => path.join(repo.gitDir, 'hydraq-panel-backups');
const backupPath = (repo, id) => path.join(backupRoot(repo), id);
const sync = async file => {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
};
const exists = file => lstat(file).then(() => true, error => { if (absent(error)) return false; throw error; });

export async function backups(repo) {
  const dir = backupRoot(repo);
  if (!await exists(dir)) return [];
  if (await realpath(dir) !== dir) throw fail('A pasta das cópias de recuperação mudou.');
  const entries = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const metadata = await readFile(path.join(dir, entry.name, 'info.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (metadata) entries.push({ id: entry.name, file: metadata.file, at: metadata.at });
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100);
}
export async function readBackup(repo, id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw fail('Cópia de segurança inválida.');
  const directory = backupPath(repo, id);
  if (await realpath(directory).catch(() => null) !== directory) throw fail('Cópia de segurança indisponível.');
  const meta = JSON.parse(await readFile(path.join(directory, 'info.json'), 'utf8'));
  const data = await diskFile(directory, 'original');
  if (data?.unsupported || meta.existed && (!data || data.bytes.equals(Buffer.from(meta.placeholder || '')))) throw fail('A cópia de segurança precisa de inspeção no terminal.');
  return { file: meta.file, entry: data && { ...data, oid: blobId(data.bytes, repo.format) } };
}
export async function restoreFile(repo, file, before, target) {
  const latest = await diskFile(repo.root, file);
  if (latest?.unsupported || !sameEntry(latest && { ...latest, oid: blobId(latest.bytes, repo.format) }, before)) {
    throw fail('O ficheiro mudou desde a pré-visualização. Volta a rever.');
  }
  const id = token();
  const directory = backupPath(repo, id);
  await mkdir(backupRoot(repo), { recursive: true, mode: 0o700 });
  if (await realpath(backupRoot(repo)) !== backupRoot(repo)) throw fail('A pasta das cópias de recuperação mudou.');
  await mkdir(directory, { mode: 0o700 });
  const info = path.join(directory, 'info.json');
  const placeholder = before ? 'hydraq-placeholder-' + token() : null;
  await writeFile(info, JSON.stringify({ file, at: new Date().toISOString(), existed: Boolean(before), placeholder }), { mode: 0o600 });
  await sync(info);
  await sync(directory);
  await sync(backupRoot(repo));
  const original = path.join(directory, 'original');
  const incoming = path.join(directory, 'incoming');
  if (target) {
    await writeFile(incoming, target.bytes, { mode: target.mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
    await sync(incoming);
  }
  let moved = false, applied = false;
  try {
    // A regular placeholder makes rename refuse to move a directory that
    // another process put in place of the reviewed file.
    if (before) {
      await writeFile(original, placeholder, { flag: 'wx', mode: 0o600 });
      await sync(original);
      await sync(directory);
    }
    await withParent(repo.root, file, async (destination, parent) => {
      if (before) {
        // Move what is actually present into the safety copy. A concurrent
        // replacement is retained even when it no longer matches the preview.
        await rename(destination, original);
        moved = true;
        await parent.sync();
        await sync(directory);
        const actual = await diskFile(directory, 'original');
        if (!actual?.bytes || !sameEntry({ ...actual, oid: blobId(actual.bytes, repo.format) }, before)) {
          await link(original, destination).catch(() => {});
          throw fail('O ficheiro mudou durante a recuperação. O conteúdo encontrado ficou na cópia de segurança ' + id + '.');
        }
      }
      if (target) {
        await link(incoming, destination);
        applied = true;
        await unlink(incoming);
      } else if (await exists(destination)) throw fail('Outro programa recriou o ficheiro durante a recuperação.');
      await parent.sync();
    }, { create: Boolean(target) && !before });
    return { restored: file, backup: id };
  } catch (error) {
    if (!moved && !applied) await rm(directory, { recursive: true, force: true });
    else throw fail(error.message + ' Cópia de segurança: ' + id + '.');
    throw error;
  }
}

export const ignoreProposal = async root => {
  const entries = await readdir(root);
  const unity = ['Assets', 'ProjectSettings', 'Packages'].every(name => entries.includes(name));
  const blender = entries.some(name => /\.blend$/i.test(name));
  return [
    '.hydraq/', '.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template',
    '*.pem', '*.key', 'id_rsa', 'id_ed25519', '*.p12', '*.pfx', '*.keystore', '.DS_Store',
    ...(unity ? ['/Library/', '/Temp/', '/Logs/', '/Obj/', '/UserSettings/', '/Build/', '/Builds/',
      '/.vs/', '/.idea/', '*.csproj', '*.sln', '/[Mm]emoryCaptures/'] : []),
    ...(blender ? ['*.blend[0-9]*', '*.blend@', 'autosave/'] : []),
    ...(entries.includes('package.json') ? ['node_modules/'] : []),
    ...(entries.some(name => ['pyproject.toml', 'requirements.txt'].includes(name)) ? ['.venv/', '__pycache__/'] : []),
  ].join('\n') + '\n';
};
export async function initProject(root, proposal, ignore) {
  if (typeof ignore !== 'string' || ignore.length > 24000 || ignore.includes('\0')) throw fail('O .gitignore proposto é inválido.');
  const current = await diskFile(root, '.gitignore');
  const oid = current?.bytes ? blobId(current.bytes, 'sha256') : null;
  if (current?.unsupported || oid !== proposal.existing) throw fail('O .gitignore mudou. Volta a abrir a proposta.');
  if (!current && ignore.trim()) {
    await writeFile(path.join(root, '.gitignore'), ignore, { flag: 'wx', mode: 0o644 });
  } else if (current && !current.bytes.equals(Buffer.from(ignore))) {
    throw fail('Já existe .gitignore. Mantém-no ou atualiza-o no editor antes de ativar Git.');
  }
  await git(root, ['init', '--template=']);
  return { initialized: true };
}

export async function branchName(repo, name) {
  if (typeof name !== 'string' || name.startsWith('-') || name.length > 200) throw fail('Indica um nome de branch válido.');
  const full = 'refs/heads/' + name;
  await git(repo.root, ['check-ref-format', full]).catch(() => { throw fail('Indica um nome de branch válido.'); });
  return full;
}
export async function branchList(repo) {
  const text = await gitText(repo.root, ['for-each-ref', '--format=%(objectname)%09%(refname)', 'refs/heads']);
  return text ? text.split('\n').map(line => {
    const [oid, ref] = line.split('\t');
    return { oid, name: ref.slice('refs/heads/'.length) };
  }) : [];
}
export async function history(repo, tip, older, offset = 0) {
  return readHistory(args => git(repo.root, args), tip, older, offset);
}
async function readHistory(run, tip, older, offset = 0) {
  if (!tip) return [];
  const args = older ? [tip, '^' + older] : [tip];
  const result = await run(['log', '-z', '--no-show-signature', '--format=%H%x00%aI%x00%an%x00%s', '--max-count=51', '--skip=' + offset, ...args, '--']);
  const output = result.stdout.toString().trimEnd();
  const fields = output.replace(/\0$/, '').split('\0');
  const entries = [];
  for (let offset = 0; offset + 3 < fields.length; offset += 4) {
    entries.push({ oid: fields[offset], at: fields[offset + 1], author: fields[offset + 2], title: fields[offset + 3] });
  }
  return entries;
}
export function checkCommit(value) {
  if (typeof value !== 'string' || !oidPattern.test(value)) throw fail('Escolhe um commit válido.');
  return value;
}
export async function commitParents(repo, oid) {
  const result = await gitText(repo.root, ['rev-list', '--parents', '-n', '1', checkCommit(oid), '--']);
  return result.split(' ').slice(1);
}

const remoteEnv = {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_ALLOW_PROTOCOL: 'file:https:ssh', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
};
function safeDestination(root, url) {
  if (typeof url !== 'string' || !url || url.length > 2048 || /[\x00-\x20\x7f]/.test(url) && !path.isAbsolute(url)) throw fail('O remoto tem um endereço inválido.');
  if (url.startsWith('https://') || url.startsWith('ssh://')) {
    const parsed = new URL(url);
    if (parsed.password || parsed.protocol === 'https:' && parsed.username || parsed.search || parsed.hash ||
      parsed.hostname.startsWith('-') || parsed.username.startsWith('-')) throw fail('Configura um remoto sem credenciais no endereço.');
    return url;
  }
  if (/^(?:[a-zA-Z0-9_.]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*:[^:]/.test(url)) return url;
  if (!url.startsWith('-') && !url.includes(':') && !/[\x00-\x1f\x7f]/.test(url)) return path.resolve(root, url);
  throw fail('Usa um remoto HTTPS, SSH ou uma pasta Git local.');
}
export async function remotes(repo) {
  return (await gitText(repo.root, ['remote'])).split('\n').filter(Boolean);
}
const remoteName = name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(name);
export async function addRemote(repo, name, address) {
  if (!remoteName(name)) throw fail('Indica um nome válido para o remoto.');
  const url = safeDestination(repo.root, address);
  await git(repo.root, ['remote', 'add', '--', name, url]);
  return { added: name };
}
export async function destination(repo, remote) {
  if (!remoteName(remote) || !(await remotes(repo)).includes(remote)) {
    throw fail('Escolhe um remoto configurado no Git.');
  }
  const addresses = (await gitText(repo.root, ['remote', 'get-url', '--push', '--all', remote])).split('\n');
  if (addresses.length !== 1) throw fail('O remoto precisa de ter um único destino de envio.');
  return safeDestination(repo.root, addresses[0]);
}
async function httpsCredentials(directory, url) {
  if (!url.startsWith('https://')) return [];
  // Load only the user's global credential helper. URL rewrites and the
  // repository's transport configuration stay outside this Git process.
  const helper = await gitText(directory, ['config', '--global', '--get-urlmatch', 'credential.helper', url], { allowed: [1] });
  return helper ? ['-c', 'credential.helper=' + helper] : [];
}
async function isolatedRemote(repo, url, action) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hydraq-git-remote-'));
  const env = remoteEnv;
  try {
    await git(directory, ['init', '--bare', '--template=', '--object-format=' + repo.format], { env });
    await writeFile(path.join(directory, 'objects/info/alternates'), path.join(repo.gitDir, 'objects') + '\n');
    const credentials = await httpsCredentials(directory, url);
    return await action((args, options) => git(directory, ['-c', 'http.followRedirects=false', ...credentials, ...args],
      { env, timeout: 45000, ...options }));
  } catch (error) {
    if (error.status && !('gitCode' in error)) throw error;
    throw fail('Não foi possível comunicar com o remoto. Verifica o acesso, a autenticação e o estado da branch.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function remoteOid(run, url, branch) {
  const result = await run(['ls-remote', '--refs', '--', url, branch]);
  const output = result.stdout.toString().trim();
  if (!output) return null;
  const [oid, ref] = output.split('\t');
  if (ref !== branch || !oidPattern.test(oid)) throw fail('O remoto devolveu uma referência inesperada.');
  return oid;
}
export async function previewPush(repo, remote) {
  if (!repo.head || !repo.branch?.startsWith('refs/heads/')) throw fail('Cria um commit numa branch local antes do envio.');
  const url = await destination(repo, remote);
  return isolatedRemote(repo, url, async run => {
    const old = await remoteOid(run, url, repo.branch);
    if (old === repo.head) return { url, old, commits: [] };
    await requireFastForward(run, old, repo.head);
    const commits = await readHistory(run, repo.head, old);
    if (commits.length > 50) throw fail('Há mais de 50 commits a enviar. Usa o terminal para rever o envio completo.');
    return { url, old, commits };
  });
}
async function requireFastForward(run, old, head) {
  if (old && (await run(['merge-base', '--is-ancestor', old, head], { allowed: [1, 128] })).code) {
    throw fail('A branch remota divergiu ou ainda não é conhecida localmente. Atualiza o repositório no terminal.');
  }
}
export async function pushReviewed(repo, preview) {
  if (await destination(repo, preview.remote) !== preview.url || repo.head !== preview.head || repo.branch !== preview.branch) {
    throw fail('A branch, o commit ou o destino mudou. Volta a pré-visualizar o envio.');
  }
  return isolatedRemote(repo, preview.url, async run => {
    const current = await remoteOid(run, preview.url, preview.branch);
    if (current === preview.head) return { pushed: preview.head, already: true };
    if (current !== preview.old) throw fail('A branch remota mudou. Volta a pré-visualizar o envio.');
    await requireFastForward(run, current, preview.head);
    // The exact expected remote tip was already verified as an ancestor.
    // The lease rejects a concurrent move even if it would permit a fast-forward.
    await run(['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no',
      '--force-with-lease=' + preview.branch + ':' + (preview.old || ''),
      '--', preview.url, preview.head + ':' + preview.branch]);
    return { pushed: preview.head };
  });
}
