import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

// One previous valid snapshot, refreshed at most once a minute. Recovery is explicit:
// loading never substitutes older state for a possibly delivered native request.
export async function writeHistory(directory, contents) {
  const file = path.join(directory, 'state.json');
  const backup = path.join(directory, 'state.json.previous');
  const recent = await stat(backup).then(info => Date.now() - info.mtimeMs < 60_000, error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
  if (!recent) {
    let previous;
    try { previous = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous !== undefined) {
      if (!Array.isArray(JSON.parse(previous).conversations)) throw new Error('Histórico anterior inválido; o original foi preservado.');
      await writeFile(`${backup}.tmp`, previous, { mode: 0o600 });
      await rename(`${backup}.tmp`, backup);
    }
  }
  await writeFile(`${file}.tmp`, contents, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}
