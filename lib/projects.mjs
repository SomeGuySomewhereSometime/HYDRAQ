import { mkdir, readFile, writeFile, rename, unlink, lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const empty = () => ({ version: 1, revision: 0, projects: [], groups: {} });
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const groupKey = key => typeof key === 'string' && /^[\w:-]{1,100}$/.test(key) && !['__proto__','constructor','prototype'].includes(key);
const name = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80 && !/[\x00-\x1f\x7f]/.test(value);
export const containsFolder = (root, folder) => { const relative = path.relative(root, folder); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

function validate(value) {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.projects) || value.projects.length > 1000 || !value.groups || typeof value.groups !== 'object' || Array.isArray(value.groups) || Object.keys(value.groups).length > 10000) throw fail('Catálogo de projetos inválido.');
  const ids = new Set(), roots = new Set();
  for (const project of value.projects) {
    if (!project || typeof project.id !== 'string' || !/^[a-f0-9-]{36}$/.test(project.id) || ids.has(project.id) || !name(project.name) || typeof project.root !== 'string' || !path.isAbsolute(project.root) || roots.has(project.root) || typeof project.archived !== 'boolean' || typeof project.createdAt !== 'string' || typeof project.updatedAt !== 'string') throw fail('Projeto inválido ou repetido no catálogo.');
    checkDefaults(project.defaults || {}); ids.add(project.id); roots.add(project.root);
  }
  for (const [key, group] of Object.entries(value.groups)) if (!groupKey(key) || !group || typeof group !== 'object' || Array.isArray(group) || (group.projectId !== null && !ids.has(group.projectId)) || (group.title !== null && !name(group.title)) || typeof group.archived !== 'boolean') throw fail('Organização de conversa inválida.');
  return value;
}

function checkDefaults(defaults) {
  const providers = ['codex','claude','antigravity','cursor'];
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults) || Object.keys(defaults).some(key => !['provider','clients'].includes(key)) || (defaults.provider !== undefined && !providers.includes(defaults.provider))) throw fail('Predefinições do projeto inválidas.');
  if (defaults.clients !== undefined) {
    if (!defaults.clients || typeof defaults.clients !== 'object' || Array.isArray(defaults.clients)) throw fail('Predefinições dos clientes inválidas.');
    for (const [provider, settings] of Object.entries(defaults.clients)) {
      if (!providers.includes(provider) || !settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(key => !['model','effort',...(provider === 'cursor' ? ['context','fast'] : [])].includes(key))) throw fail('As predefinições não podem conceder acesso nem mudar permissões.');
      for (const [key,value] of Object.entries(settings)) if (key === 'fast' ? typeof value !== 'boolean' : typeof value !== 'string' || !value || value.length > 160) throw fail('Predefinição inválida.');
    }
  }
}

export class Projects {
  constructor(directory) { this.directory = directory; this.file = path.join(directory, 'projects.json'); this.data = empty(); this.raw = null; this.queue = Promise.resolve(); this.statuses = new Map(); this.error = null; }
  async load() {
    try { this.raw = await this.#read(); this.data = validate(JSON.parse(this.raw)); }
    catch (error) { if (error.code !== 'ENOENT') this.error = `Não foi possível carregar os projetos. O catálogo foi preservado; o histórico está disponível para consulta. ${error.message}`; }
    await this.refresh();
  }
  async #read() {
    const info = await lstat(this.file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8_000_000) throw fail('Ficheiro de projetos inválido.');
    return readFile(this.file, 'utf8');
  }
  snapshot() { return { ...structuredClone(this.data), error: this.error, projects: this.data.projects.map(project => ({ ...structuredClone(project), ...this.statuses.get(project.id) })) }; }
  project(id) { const project = this.data.projects.find(entry => entry.id === id); if (!project) throw fail('Projeto não encontrado.'); return project; }
  group(id) { return this.data.groups[id] || null; }
  async folder(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw fail('Indica o caminho absoluto de uma pasta existente.');
    const resolved = await realpath(root);
    if (!(await stat(resolved)).isDirectory()) throw fail('O caminho não é uma pasta.');
    return resolved;
  }
  async refresh() {
    await Promise.all(this.data.projects.map(async project => {
      try { if (await this.folder(project.root) !== project.root) throw fail('O caminho passou a apontar para outra pasta.'); this.statuses.set(project.id, { available: true, folderError: null }); }
      catch { this.statuses.set(project.id, { available: false, folderError: 'Pasta indisponível ou alterada. O histórico foi conservado.' }); }
    }));
  }
  suggest(folder) { return this.data.projects.filter(project => !project.archived && containsFolder(project.root, folder)).sort((a,b) => b.root.length - a.root.length)[0] || null; }
  async assertUsable(groupId, members) {
    if (this.error) throw fail(this.error);
    const meta = this.group(groupId), project = meta?.projectId ? this.project(meta.projectId) : null;
    if (meta?.archived || project?.archived) throw fail('Restaura a conversa e o projeto antes de enviar um pedido.');
    if (project) await this.checkMembers(project, members);
  }
  async checkMembers(project, members) {
    try {
      if (await this.folder(project.root) !== project.root) throw fail('A pasta do projeto mudou.');
      this.statuses.set(project.id, { available: true, folderError: null });
    } catch (error) { this.statuses.set(project.id, { available: false, folderError: error.message }); throw fail(`Não é possível usar este projeto: ${error.message}`); }
    let folders;
    try { folders = await Promise.all(members.map(member => this.folder(member.cwd))); }
    catch { throw fail('A pasta de uma sessão está indisponível. O histórico foi conservado.'); }
    if (new Set(folders).size !== 1 || members.some((member,index) => folders[index] !== member.cwd) || folders.some(folder => !containsFolder(project.root, folder))) throw fail('As sessões deste grupo têm pastas incompatíveis com o projeto.');
  }
  async change(revision, operation) {
    const run = this.queue.then(async () => {
      if (this.error) throw fail(this.error);
      if (revision !== this.data.revision) throw fail('A organização mudou noutra janela. A lista foi atualizada; revê e volta a guardar.', 409);
      const draft = structuredClone(this.data);
      const result = await operation(draft);
      draft.revision++; validate(draft);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      let disk = null;
      try { disk = await this.#read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (disk !== this.raw) throw fail('O catálogo mudou no disco. Reinicia o HYDRAQ para o reler; nada foi substituído.', 409);
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        if (disk !== null) {
          const backupTemp = `${temp}.previous`;
          try { await writeFile(backupTemp, disk, { mode: 0o600, flag: 'wx' }); await rename(backupTemp, `${this.file}.previous`); }
          finally { await unlink(backupTemp).catch(() => {}); }
        }
        const raw = JSON.stringify(draft, null, 2) + '\n';
        await writeFile(temp, raw, { mode: 0o600, flag: 'wx' }); await rename(temp, this.file);
        this.data = draft; this.raw = raw;
      } finally { await unlink(temp).catch(() => {}); }
      return result;
    });
    this.queue = run.catch(() => {}); return run;
  }
  async create(body, validateDefaults = () => {}) {
    const root = await this.folder(body.root);
    if (!name(body.name)) throw fail('O nome deve ter entre 1 e 80 caracteres.');
    checkDefaults(body.defaults || {}); validateDefaults(body.defaults || {});
    const id = randomUUID(), at = new Date().toISOString();
    await this.change(body.revision, draft => {
      if (draft.projects.some(project => project.root === root)) throw fail('Já existe um projeto para esta pasta, incluindo nos arquivados.');
      draft.projects.push({ id, name: body.name.trim(), root, defaults: body.defaults || {}, archived: false, createdAt: at, updatedAt: at });
    });
    await this.refresh(); return this.project(id);
  }
}
