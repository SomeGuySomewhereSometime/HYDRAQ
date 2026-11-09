import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const validKey = key => typeof key === 'string' && key.length > 0 && key.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(key);

export class GoogleAiSettings {
  constructor(directory, env = process.env) {
    this.directory = directory;
    this.file = path.join(directory, 'google-ai.json');
    this.env = env;
    this.savedKey = '';
    this.error = null;
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.size > 2048) throw Error();
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data.version !== 1 || (data.apiKey !== '' && !validKey(data.apiKey))) throw Error();
      this.savedKey = data.apiKey;
    } catch (error) {
      if (error.code !== 'ENOENT') this.error = 'Não foi possível ler a chave Google AI Studio guardada. O ficheiro foi preservado.';
    }
  }

  apiKey() { return this.savedKey || (this.env.GEMINI_API_KEY || '').trim(); }

  status() {
    return { configured: Boolean(this.apiKey()), saved: Boolean(this.savedKey), source: this.savedKey ? 'settings' : this.apiKey() ? 'environment' : null, error: this.error };
  }

  save(body) {
    const update = async () => {
      if (this.error) throw fail(this.error, 409);
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          (body.remove === true ? Object.keys(body).some(k => k !== 'remove') : Object.keys(body).some(k => k !== 'apiKey') || typeof body.apiKey !== 'string' || !validKey(body.apiKey.trim()))) {
        throw fail('Introduz uma chave Google AI Studio válida (até 512 caracteres, sem espaços).');
      }
      const apiKey = body.remove === true ? '' : body.apiKey.trim();
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, apiKey }) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.file);
        this.savedKey = apiKey;
      } catch {
        throw fail('Não foi possível guardar a chave Google AI Studio. Tenta novamente.', 500);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return this.status();
    };
    const next = this.queue.then(update);
    this.queue = next.catch(() => {});
    return next;
  }
}
