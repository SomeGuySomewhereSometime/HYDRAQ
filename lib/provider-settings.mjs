import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });

export class ProviderSettings {
  constructor(directory, providerIds) {
    this.directory = directory;
    this.file = path.join(directory, 'provider-settings.json');
    this.providerIds = providerIds;
    this.data = { revision: 0, providers: {} };
    this.raw = null;
    this.error = null;
  }

  async read() {
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.size > 16_384) throw fail('Ficheiro de clientes inválido.');
      return await readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return null;
    }
  }

  async load() {
    try {
      const raw = await this.read();
      if (raw === null) return;
      const data = JSON.parse(raw);
      if (data?.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
          !data.providers || Array.isArray(data.providers) || typeof data.providers !== 'object' ||
          Object.entries(data.providers).some(([id, enabled]) => !this.providerIds().includes(id) || typeof enabled !== 'boolean')) {
        throw fail('Ficheiro de clientes inválido.');
      }
      this.data = { revision: data.revision, providers: data.providers };
      this.raw = raw;
    } catch {
      this.error = 'Não foi possível ler as definições dos clientes. O ficheiro foi preservado e os clientes não serão ligados.';
    }
  }

  enabled(id) {
    return !this.error && this.providerIds().includes(id) && this.data.providers[id] !== false;
  }

  validate({ provider, enabled, revision }) {
    if (this.error) throw fail(this.error);
    if (!this.providerIds().includes(provider) || typeof enabled !== 'boolean') throw fail('Escolhe um cliente e um estado válidos.', 400);
    if (revision !== this.data.revision) throw fail('Os clientes mudaram noutro separador. Atualiza o estado e volta a tentar.');
  }

  async save(provider, enabled) {
    if (await this.read() !== this.raw) throw fail('As definições dos clientes mudaram no disco. Reinicia o HYDRAQ para as reler.');
    const next = {
      revision: this.data.revision + 1,
      providers: { ...this.data.providers, [provider]: enabled },
    };
    const raw = JSON.stringify({ version: 1, ...next }, null, 2) + '\n';
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, raw, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
      this.data = next;
      this.raw = raw;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
