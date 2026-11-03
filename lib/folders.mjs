import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || value.includes('\0')) throw Error('Indica um caminho absoluto válido.');
  return value;
}

export async function browseFolders(folder = os.homedir()) {
  const current = await realpath(absolute(folder));
  if (!(await stat(current)).isDirectory()) throw Error('O caminho não é uma pasta.');
  const entries = await readdir(current, { withFileTypes: true });
  const names = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort((a, b) => a.localeCompare(b, 'pt'));
  return { current, parent: path.dirname(current), folders: names.slice(0, 2000), truncated: names.length > 2000 };
}

export async function createFolder(folder) {
  await mkdir(absolute(folder), { recursive: true });
  const resolved = await realpath(folder);
  if (!(await stat(resolved)).isDirectory()) throw Error('O caminho não é uma pasta.');
  return resolved;
}

export async function createLooseFolder(base = path.join(os.homedir(), 'HYDRAQ Conversas'), forbidden = []) {
  let ancestor = path.resolve(absolute(base)), resolved;
  while (true) {
    try { resolved = await realpath(ancestor); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; const parent=path.dirname(ancestor); if (parent===ancestor) throw error; ancestor=parent; }
  }
  // Resolve existing symlinks before creating anything; check again after mkdir in case the path changed.
  const candidate=path.resolve(resolved, path.relative(ancestor, path.resolve(base)));
  const check = root => { for (const project of forbidden.filter(Boolean)) {
    const relative = path.relative(project, root);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw Error('A pasta das conversas independentes está dentro de um projeto. Escolhe outra pasta para a conversa.');
  }};
  check(candidate);
  const root = await createFolder(base);check(root);
  const folder = path.join(root, randomUUID());
  await mkdir(folder, { mode: 0o700 });
  return folder;
}
