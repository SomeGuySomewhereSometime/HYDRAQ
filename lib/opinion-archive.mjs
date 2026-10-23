import {mkdir, lstat, readFile, readdir, open, rename} from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const component = value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
const kinds = new Set(['batches', 'cycles', 'merges']);

/** Completed records leave the live snapshot, never the history. Receipts remain
 * addressable by request/job ID so pagination cannot cause duplicate inference. */
export class OpinionArchive {
  constructor(directory) {
    this.directory = directory;
    this.groups = new Set();
  }

  async directoryFor(...parts) {
    let directory = this.directory;
    for (const part of ['', ...parts]) {
      if (part && !component(part)) throw Error('Referência de arquivo inválida.');
      if (part) directory = path.join(directory, part);
      await mkdir(directory, {recursive: true, mode: 0o700});
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Pasta de arquivo inválida.');
    }
    return directory;
  }

  async read(parts) {
    for (const part of parts) if (!component(part.replace(/\.json$/, ''))) throw Error('Referência de arquivo inválida.');
    let file = this.directory;
    try {
      const parent = await lstat(file);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('Pasta de arquivo inválida.');
      for (let i = 0; i < parts.length; i++) {
        file = path.join(file, parts[i]);
        const info = await lstat(file);
        if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.size > 2_000_000)) throw Error('Registo de arquivo inválido.');
      }
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(parts, value) {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 2_000_000) throw Error('Registo de arquivo demasiado grande; original preservado.');
    const directory = await this.directoryFor(...parts.slice(0, -1));
    const target = path.join(directory, parts.at(-1));
    const temporary = target + '.' + randomUUID() + '.tmp';
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(data); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, target);
  }

  async put(kind, record, groupId) {
    if (!kinds.has(kind) || !component(groupId)) throw Error('Grupo de arquivo inválido.');
    const stamp = (record.createdAt || '').replace(/\D/g, '').padEnd(17, '0').slice(0, 17);
    const id = record.id || hash(record.requestId);
    if (!component(id)) throw Error('Identificador de arquivo inválido.');
    const name = `${stamp}-${id}.json`;
    const reference = {kind, groupId, name};
    // Record first, receipts second, live snapshot last. A failed commit may leave
    // two copies, but never discard the only copy or replay an archived request.
    await this.write([kind, groupId, name], {version: 1, kind, groupId, record});
    if (record.requestId) await this.write(['receipts', kind, hash(record.requestId) + '.json'], reference);
    if (kind === 'cycles' && record.returnRequestId) await this.write(['receipts', 'returns', hash(record.returnRequestId) + '.json'], reference);
    for (const job of kind === 'batches' ? record.jobs : []) await this.write(['receipts', 'jobs', hash(job.id) + '.json'], reference);
    this.groups.add(groupId);
  }

  async resolve(reference) {
    if (!reference || !kinds.has(reference.kind) || !component(reference.groupId) || !/^[a-zA-Z0-9_-]+\.json$/.test(reference.name)) throw Error('Recibo de arquivo inválido.');
    const saved = await this.read([reference.kind, reference.groupId, reference.name]);
    if (!saved || saved.version !== 1 || saved.kind !== reference.kind || saved.groupId !== reference.groupId || !saved.record) throw Error('O recibo não tem um registo válido; nada foi reenviado.');
    return saved.record;
  }

  async find(kind, requestId) {
    const reference = await this.read(['receipts', kind, hash(requestId) + '.json']);
    if (!reference) return null;
    const record = await this.resolve(reference);
    if (kind === 'jobs' ? !record.jobs?.some(j => j.id === requestId) : kind === 'returns' ? record.returnRequestId !== requestId : record.requestId !== requestId) throw Error('Recibo de arquivo incoerente.');
    return record;
  }

  async load() {
    await this.directoryFor();
    for (const kind of kinds) {
      const directory = await this.directoryFor(kind);
      for (const entry of await readdir(directory, {withFileTypes: true})) {
        if (!component(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) throw Error('Índice de arquivo inválido.');
        this.groups.add(entry.name);
      }
    }
  }

  async page(groupId, cursor = '') {
    if (!component(groupId) || typeof cursor !== 'string' || cursor.length > 200) throw Error('Página de pareceres inválida.');
    const entries = [];
    for (const kind of kinds) {
      const directory = path.join(this.directory, kind, groupId);
      let info;
      try { info = await lstat(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Pasta de arquivo inválida.');
      for (const entry of await readdir(directory, {withFileTypes: true})) {
        if (entry.name.endsWith('.tmp')) continue;
        if (!/^[a-zA-Z0-9_-]+\.json$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw Error('Índice de arquivo inválido.');
        const order = entry.name + ':' + kind;
        if (!cursor || order < cursor) entries.push({kind, groupId, name: entry.name, order});
      }
    }
    entries.sort((a, b) => a.order === b.order ? 0 : a.order < b.order ? 1 : -1);
    const selected = entries.slice(0, 20), records = {batches: [], cycles: [], merges: []};
    for (const entry of selected) records[entry.kind].push(await this.resolve(entry));
    return {...records, nextCursor: entries.length > selected.length ? selected.at(-1).order : null};
  }
}
