import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

// What a Hydra principal may touch. The functions down to writablePath also run inside agy's hook as source text, so they
// may use only fs, os, path and each other.

export function shellQuote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }

/** Programs installed in the home. Only these: a whole ~/.cargo or ~/.config holds credentials. */
export function homeBinaries() {
  return ['.local/bin', '.cargo/bin', 'go/bin', '.bun/bin', '.deno/bin', '.dotnet', '.pyenv/shims', '.volta/bin', '.asdf/shims'].map(folder => path.join(os.homedir(), folder));
}

/** What commands still see of a hidden home. HYDRAQ_TEST_TOOLCHAINS adds folders. */
export function toolFolders() {
  const home = os.homedir(), runtime = path.dirname(process.execPath), prefix = path.basename(runtime) === 'bin' ? path.dirname(runtime) : runtime;
  const hidden = [home, '/root'].some(top => prefix === top || prefix.startsWith(top + path.sep));
  return [...(hidden ? [prefix] : []), ...homeBinaries(), ...['.rustup', '.nvm/versions', '.local/share/uv', '.local/share/pipx', '.local/lib', '.codex/packages/standalone/current/bin', '.pyenv/versions', '.volta/tools', '.asdf/installs', '.gemini/antigravity-cli/mcp'].map(folder => path.join(home, folder)), ...(process.env.HYDRAQ_TEST_TOOLCHAINS || '').split(':').filter(path.isAbsolute)];
}

/** Where a worktree or a submodule keeps its Git data: outside the project, so it must be made visible. */
export function externalGitFolder(cwd) {
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(cwd, '.git'), 'utf8'));
    if (!match) return null;
    const target = path.resolve(cwd, match[1].trim()), mark = target.lastIndexOf(path.sep + '.git' + path.sep);
    return mark < 0 ? target : target.slice(0, mark + 5);
  } catch { return null; }
}

/** A command line with no network and none of the session's sockets. A read-only mount does not stop a connection to a
 *  Unix socket, so what holds them is hidden, not just protected: /run, /tmp and the home, apart from installed tools. With
 *  `write` it may write inside the project, away from .git and .hydraq; without it, nowhere: even a read-only git status can
 *  run a program the repository's configuration names. `visible` adds folders to read, such as agy's notes of this conversation. */
export function confinedCommand(command, cwd, write = true, visible = [], origin = null, policy = null) {
  const own = target => cwd && fs.statSync(cwd + '/.hydraq', { throwIfNoEntry: false })?.isDirectory() ? ['--tmpfs', target + '/.hydraq', '--remount-ro', target + '/.hydraq'] : [];
  // A private copy has its own Git data. The real folder of a worktree may hold what must stay out of reach.
  const git = cwd && !origin && externalGitFolder(cwd);
  const mount = target => write ? ['--bind', cwd, target, '--ro-bind-try', cwd + '/.git', target + '/.git', ...own(target)] : cwd ? ['--ro-bind-try', cwd, target, ...own(target)] : [];
  // A private copy also appears at the real project's path: absolute paths inside a virtualenv or a link then lead to the copy.
  const project = [...mount(cwd), ...(cwd && origin ? mount(origin) : [])];
  const protectedMounts = write && policy?.protectedPaths ? policy.protectedPaths.flatMap(file => {
    const full = path.join(cwd,file);
    return fs.existsSync(full) ? ['--ro-bind',full,full] : [];
  }) : [];
  const caches = ['.cargo/registry','.cargo/git','.npm','.cache/pip','.cache/uv'].map(file => path.join(os.homedir(),file));
  const runtimeRoots = ['/usr','/bin','/sbin','/lib','/lib64','/etc/ssl','/etc/ca-certificates','/etc/resolv.conf','/etc/hosts','/etc/nsswitch.conf','/etc/ld.so.cache','/etc/passwd','/etc/group','/etc/localtime','/etc/alternatives'];
  const rootMount = policy ? runtimeRoots.flatMap(folder=>['--ro-bind-try',folder,folder]) : ['--ro-bind','/','/'];
  const options = ['/usr/bin/bwrap', '--unshare-all', ...(policy?.network?['--share-net']:[]), '--die-with-parent', '--new-session', ...rootMount, '--dev', '/dev', '--proc', '/proc', ...(policy?.tmp?['--bind',policy.tmp,'/tmp']:['--tmpfs','/tmp']), '--tmpfs', '/run', '--tmpfs', '/home', '--tmpfs', '/root',
    ...[...toolFolders(), ...(policy?caches:[]), ...visible, ...(git ? [git] : [])].flatMap(folder => ['--ro-bind-try', folder, folder]), ...project, ...protectedMounts, '--setenv', 'TMPDIR', '/tmp'];
  // $PWD: the client may have chosen a subfolder for this command.
  return options.map(shellQuote).join(' ') + (cwd ? '' : ' --ro-bind "$PWD" "$PWD"') + ' --dir "${HOME:-/tmp}" --chdir "$PWD" -- /usr/bin/bash -c ' + shellQuote(command);
}

/** Whether a file tool may write here: inside the project once links are resolved, outside .git and .hydraq, and not a
 *  file with other names, which may live outside the project. */
export function writablePath(target, cwd) {
  if (typeof target !== 'string' || !target || typeof cwd !== 'string' || !cwd) return false;
  const resolve = file => {
    const missing = [];
    let current = path.resolve(file);
    for (;;) {
      try { return path.join(fs.realpathSync(current), ...missing); }
      catch (error) {
        if (error.code !== 'ENOENT') return null;
        // A link whose target does not exist yet would still write through to that target.
        try { fs.lstatSync(current); return null; } catch (inner) { if (inner.code !== 'ENOENT') return null; }
        const parent = path.dirname(current);
        if (parent === current) return null;
        missing.unshift(path.basename(current));
        current = parent;
      }
    }
  };
  const root = resolve(cwd), full = resolve(path.resolve(cwd, target));
  if (!root || !full || !full.startsWith(root + path.sep)) return false;
  if (path.relative(root, full).split(path.sep).some(part => part === '.git' || part === '.hydraq')) return false;
  try { return fs.lstatSync(full).nlink < 2; } catch { return true; }
}

/** Why a principal could not run commands confined in this folder, or null when it can. */
export function commandSandboxProblem(cwd, {timeoutMs = 10000,policy=null} = {}) {
  return new Promise(resolve => {
    let output = '', settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const child = spawn('/usr/bin/bash', ['-c', confinedCommand('true', cwd,true,[],null,policy)], {cwd, stdio: ['ignore', 'ignore', 'pipe']});
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish('o bubblewrap não respondeu.'); }, timeoutMs);
    child.stderr.on('data', data => { output = (output + data).slice(-500); });
    child.once('error', error => finish(error.message));
    child.once('close', code => finish(code === 0 ? null : output.trim() || `o bubblewrap terminou com o código ${code}.`));
  });
}
