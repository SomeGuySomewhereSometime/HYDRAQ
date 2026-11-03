import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const excluded = new Set(['.git', '.hydraq', 'node_modules', '.venv', 'venv', '__pycache__']);
const maximumFiles = 10_000;
const maximumBytes = 256 * 1024 * 1024;
const gitFiles = cwd => new Promise(resolve => execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { timeout: 5000, maxBuffer: 4_000_000 }, (error, stdout) => resolve(error ? null : [...new Set(stdout.split('\0').filter(Boolean))])));

// Hashes are transient; only changed paths and inspection limits enter the history.
// Symlinks are inspected as links, without following them outside the project.
export async function inspectProject(cwd) {
  const files = Object.create(null), warnings = [];
  const started = Date.now();
  let names = await gitFiles(cwd), used = 0;
  const allowed = name => !name.split('/').some(part => excluded.has(part));
  if (names === null) {
    names = [];
    // Recognise a Unity source project before excluding its generated caches.
    // Git projects continue to follow git ls-files and their existing ignore rules.
    const unity = await Promise.all(['Assets','ProjectSettings/ProjectVersion.txt'].map(name => lstat(path.join(cwd,name)).then(info => !info.isSymbolicLink(), () => false))).then(found => found.every(Boolean));
    const generated = unity ? new Set(['Library','Temp','obj','Logs']) : new Set();
    let entries = 0;
    const walk = async folder => {
      for (const entry of await readdir(path.join(cwd, folder), { withFileTypes: true })) {
        if (++entries > maximumFiles * 2 || Date.now() - started > 10_000) { warnings.push('Limite de inspeção atingido.'); return; }
        if (excluded.has(entry.name)) continue;
        if (!folder && entry.isDirectory() && generated.has(entry.name)) continue;
        const name = folder ? `${folder}/${entry.name}` : entry.name;
        if (names.length >= maximumFiles) { warnings.push('Limite de ficheiros atingido.'); return; }
        if (entry.isDirectory()) await walk(name); else names.push(name);
      }
    };
    try { await walk(''); } catch { warnings.push('Não foi possível listar todos os ficheiros.'); }
  }
  names = names.filter(allowed).sort();
  if (names.length > maximumFiles) warnings.push('Limite de ficheiros atingido.');
  for (const name of names.slice(0, maximumFiles)) {
    if (Date.now() - started > 10_000) { warnings.push('Limite de tempo atingido.'); break; }
    try {
      const absolute = path.resolve(cwd, name);
      const relative = path.relative(cwd, absolute);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { warnings.push('Caminho fora do projeto omitido.'); continue; }
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) { files[name] = `link:${await readlink(absolute)}`; continue; }
      if (!info.isFile()) continue;
      if (used + info.size > maximumBytes) { warnings.push('Limite de leitura atingido.'); continue; }
      used += info.size;
      const hash = createHash('sha256');
      let read = 0;
      for await (const chunk of createReadStream(absolute)) {
        read += chunk.length;
        if (read > info.size + 1024 * 1024 || used + read - info.size > maximumBytes) throw new Error('O ficheiro cresceu durante a inspeção.');
        hash.update(chunk);
      }
      const after = await lstat(absolute);
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) warnings.push(`Ficheiro mudou durante a inspeção: ${name}`);
      files[name] = `${info.mode}:${hash.digest('hex')}`;
    } catch (error) {
      if (error.code === 'ENOENT') files[name] = 'missing';
      else warnings.push(`Não foi possível inspecionar: ${name}`);
    }
  }
  return { files, warnings: [...new Set(warnings)], complete: warnings.length === 0 };
}

export function compareProjects(before, after) {
  const changed = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter(name => before.files[name] !== after.files[name]).sort();
  return { changed, warnings: [...new Set([...(before.warnings || []), ...(after.warnings || [])])] };
}
