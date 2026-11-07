import { lstat, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { gitDiff, CHANGES_PAGE } from './hydra-changes.mjs';
import {
  absent, attributes, blobId, config, conversion, diskFile, fail, git, gitText, indexEntries, listChanges,
  readBlob, regular, repoAt, sameEntry, sensitive, token, treeEntries, validPath, writeBlob, writeReady,
} from './git-panel-repo.mjs';
import { commitReviewed, recoverCommit, recoveryStatus, withWorktreeIndex } from './git-panel-transaction.mjs';
import {
  addRemote, backups, branchList, branchName, checkCommit, commitParents, history, ignoreProposal, initProject,
  previewPush, pushReviewed, readBackup, remotes, restoreFile,
} from './git-panel-operations.mjs';

const PREVIEW_LIFETIME = 30 * 60 * 1000;
const sameBase = (left, right) => left.branch === right.branch && left.head === right.head;
const decoder = new TextDecoder('utf-8', { fatal: true });
const textFile = item => {
  if (!item || item.bytes?.length === 0) return true;
  if (!item.bytes || item.bytes.includes(0)) return false;
  try { decoder.decode(item.bytes); return true; } catch { return false; }
};
const metadata = item => item ? { oid: item.oid, size: item.size, mode: item.mode } : null;
const conflicts = (...maps) => [...new Set(maps.flatMap(map => [...map.keys()]))].filter(file => !sameEntry(maps[0].get(file), maps[1].get(file)));

async function diffView(left, right) {
  const view = { before: metadata(left), after: metadata(right), diff: '', binary: false };
  if (!textFile(left) || !textFile(right)) return { ...view, binary: true };
  if ((left?.size || 0) + (right?.size || 0) > 2 ** 20) return { ...view, oversized: true };
  if (sameEntry(left, right)) return view;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hydraq-git-diff-'));
  try {
    const before = path.join(dir, 'before');
    const after = path.join(dir, 'after');
    if (left) await writeFile(before, left.bytes, { mode: 0o600 });
    if (right) await writeFile(after, right.bytes, { mode: 0o600 });
    const diff = await gitDiff(left ? before : '/dev/null', right ? after : '/dev/null');
    const start = diff.search(/^@@ /m);
    return { ...view, diff: start < 0 ? '' : diff.slice(start) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const revision = value => value === null ? null : checkCommit(value);
const safeFile = async (repo, file) => {
  const current = await diskFile(repo.root, file, { format: repo.format });
  if (current?.unsupported) throw fail(current.unsupported);
  return current;
};
const hiddenSecret = (file, ...items) => sensitive(file) || items.some(item => sensitive(file, item?.bytes));
const noHooksMessage = 'O painel usa a identidade do Git e não executa os hooks do repositório.';
const unavailable = () => fail('A pré-visualização expirou. Volta a rever a operação.');

export class GitPanel {
  constructor(hub) {
    this.hub = hub;
    this.previews = new Map();
  }
  async project(id) {
    if (this.hub.projects.error) throw fail('O catálogo de projetos está indisponível.');
    const project = this.hub.projects.project(id);
    if (project.archived) throw fail('O projeto está arquivado.');
    if (await realpath(project.root) !== project.root || !(await lstat(project.root)).isDirectory()) {
      throw fail('A pasta do projeto mudou.');
    }
    return project;
  }
  reserve(project, action) {
    const scope = { cwd: project.root, projectId: project.id, kind: 'git-panel', resources: [],
      reason: 'Operação Git em curso', label: project.name };
    this.hub.assertFree(scope);
    const key = 'git:' + token();
    this.hub.reservations.set(key, scope);
    return Promise.resolve().then(action).finally(() => {
      this.hub.reservations.delete(key);
      this.hub.followups?.changed();
      this.hub.automaticReviews?.changed();
    });
  }
  put(project, repo, kind, value) {
    const now = Date.now();
    const id = token();
    for (const [key, entry] of this.previews) if (entry.until <= now) this.previews.delete(key);
    while (this.previews.size >= 250) this.previews.delete(this.previews.keys().next().value);
    this.previews.set(id, { ...value, kind, projectId: project.id, root: project.root, base: repo, shown: Math.min(value.view?.diff.length || 0, CHANGES_PAGE), until: now + PREVIEW_LIFETIME });
    return id;
  }
  get(project, id, kind) {
    const record = this.previews.get(id);
    if (!record || record.kind !== kind || record.projectId !== project.id || record.root !== project.root || record.until <= Date.now()) {
      throw unavailable();
    }
    return record;
  }
  page(view, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > view.diff.length) throw fail('Página de diff inválida.', 400);
    const end = offset + CHANGES_PAGE;
    return { ...view, diff: view.diff.slice(offset, end), nextOffset: end < view.diff.length ? end : null };
  }
  async state(project, repo) {
    if (!repo) {
      const existing = await diskFile(project.root, '.gitignore');
      if (existing?.unsupported) throw fail(existing.unsupported);
      const proposal = await ignoreProposal(project.root);
      const receipt = this.put(project, null, 'init', { existing: existing && blobId(existing.bytes, 'sha256') });
      return { initialized: false, receipt, ignore: existing?.bytes.toString() ?? proposal, suggested: proposal, existingIgnore: Boolean(existing) };
    }
    const conflict = this.hub.blocking?.({ cwd: project.root, projectId: project.id, resources: [], kind: 'git-panel' });
    const [changes, branches, remoteList, backupList, recovery, hooks, signed] = await Promise.all([
      listChanges(repo), branchList(repo), remotes(repo), backups(repo), recoveryStatus(repo),
      config(repo.root, 'core.hooksPath'), config(repo.root, 'commit.gpgSign', 'bool'),
    ]);
    const hooksDir = await lstat(path.join(repo.gitDir, 'hooks')).catch(error => { if (absent(error)) return null; throw error; });
    const localHooks = hooksDir?.isDirectory() ? readdir(path.join(repo.gitDir, 'hooks')) : [];
    return {
      initialized: true, branch: repo.branch?.slice('refs/heads/'.length) || null, head: repo.head,
      changes, branches, remotes: remoteList, backups: backupList, recovery,
      blocked: conflict?.reason || null, signed: signed === 'true',
      hooks: Boolean(hooks || (await localHooks).some(name => !name.endsWith('.sample'))),
      notice: noHooksMessage,
    };
  }
  async reviewedFile(project, repo, file) {
    validPath(file);
    const [base, index, attrs, auto] = await Promise.all([
      treeEntries(repo.root, repo.head), indexEntries(repo.root), attributes(repo.root, [file]), config(repo.root, 'core.autocrlf'),
    ]);
    const original = base.get(file);
    const staged = index.get(file);
    if (!regular(original) || !regular(staged)) throw fail('Ligações simbólicas e submódulos abrem no terminal.');
    let current;
    try { current = await safeFile(repo, file); }
    catch (error) {
      const info = await diskFile(repo.root, file, { read: false });
      if (!info?.unsupported || !info.size) throw error;
      return { before: metadata(await readBlob(repo.root, original)), after: metadata(info), binary: true, reason: info.unsupported, diff: '' };
    }
    const prior = await readBlob(repo.root, original);
    if (hiddenSecret(file, prior, current)) throw fail('Possível segredo. O painel exclui este ficheiro da seleção e do diff.');
    if (!original && !staged && !(await gitText(repo.root, ['ls-files', '--others', '--exclude-standard', '-z', '--', file])).endsWith('\0')) {
      throw fail('O ficheiro está ignorado ou já não está disponível.');
    }
    const reason = conversion(attrs.get(file), auto, current?.bytes) || (staged?.stage || !sameEntry(original, staged)
      ? 'Já tem preparação no índice Git.' : sameEntry(original, current) ? 'Sem alterações.' : null);
    const view = await diffView(prior, current);
    const receipt = this.put(project, repo, 'diff', {
      file, view, reason: reason || (view.oversized ? 'Diff de texto demasiado grande. Usa o terminal.' : null), entry: current && { oid: current.oid, mode: current.mode },
      bytes: current?.bytes?.includes(13) ? 'cr' : null,
      // A preview may store a loose object. The repository's refs and index stay untouched.
      blob: current && !reason ? await writeBlob(repo.root, current.bytes) : null,
    });
    return { ...this.page(view), receipt, reason: this.previews.get(receipt).reason };
  }
  async historyFiles(repo, left, right) {
    const [a, b] = await Promise.all([treeEntries(repo.root, revision(left)), treeEntries(repo.root, revision(right))]);
    return conflicts(a, b).map(file => ({ file, status: !a.has(file) ? 'Novo' : !b.has(file) ? 'Apagado' : 'Alterado' }));
  }
  async historyDiff(project, repo, body) {
    const file = validPath(body.file);
    const [a, b] = await Promise.all([treeEntries(repo.root, revision(body.left)), treeEntries(repo.root, revision(body.right))]);
    const [left, right] = await Promise.all([readBlob(repo.root, a.get(file)), readBlob(repo.root, b.get(file))]);
    if (hiddenSecret(file, left, right)) throw fail('Possível segredo. O painel exclui este ficheiro do diff.');
    const view = await diffView(left, right);
    return { ...this.page(view), receipt: this.put(project, repo, 'history-diff', { view }) };
  }
  async restorePreview(project, repo, body) {
    let file, target;
    if (body.backup) ({ file, entry: target } = await readBackup(repo, body.backup));
    else {
      file = validPath(body.file);
      target = await readBlob(repo.root, (await treeEntries(repo.root, checkCommit(body.commit))).get(file));
    }
    if (target && (!target.bytes || target.unsupported)) throw fail('Este ficheiro não pode ser restaurado pelo painel.');
    const current = await safeFile(repo, file);
    if (hiddenSecret(file, current, target)) throw fail('Usa o terminal para recuperar um ficheiro assinalado como possível segredo.');
    const [attrs, auto] = await Promise.all([attributes(repo.root, [file]), config(repo.root, 'core.autocrlf')]);
    const unsupported = conversion(attrs.get(file), auto, target?.bytes);
    if (unsupported) throw fail(unsupported);
    if (sameEntry(current, target)) throw fail('O ficheiro já tem o conteúdo selecionado.');
    const view = await diffView(current, target);
    if (view.oversized) throw fail('Diff de texto demasiado grande. Usa o terminal para recuperar este ficheiro.');
    const receipt = this.put(project, repo, 'restore', {
      file, view, before: metadata(current), target: target && { ...metadata(target), backup: body.backup || null },
    });
    return { ...this.page(view), receipt, file };
  }
  async mutate(project, repo, action, body) {
    if (action === 'init') {
      if (repo) throw fail('O projeto já tem Git.');
      const proposal = this.get(project, body.receipt, 'init');
      const result = await initProject(project.root, proposal, body.ignore);
      this.previews.delete(body.receipt);
      return result;
    }
    if (!repo) throw fail('Ativa Git no projeto primeiro.');
    if (action === 'recover') return recoverCommit(repo, body.mode);
    if (await recoveryStatus(repo)) throw fail('Resolve a operação pendente no cartão de recuperação.');
    await writeReady(repo, { allowDetached: action === 'branch-switch' });
    if (action === 'commit') {
      const { receipts, message } = body;
      if (!Array.isArray(receipts) || !receipts.length || receipts.length > 300 || typeof message !== 'string' || !message.trim() ||
        message.length > 12000 || message.includes('\0')) throw fail('Seleciona até 300 ficheiros revistos e escreve a mensagem de commit.', 400);
      const selected = receipts.map(receipt => this.get(project, receipt, 'diff'));
      if (selected.some(item => item.reason || item.shown < item.view.diff.length || !sameBase(repo, item.base) || item.entry && item.entry.oid !== item.blob)) {
        throw fail('A seleção inclui um ficheiro indisponível ou o commit de origem mudou.');
      }
      const entries = new Map(selected.map(item => [item.file, item.entry]));
      if (entries.size !== selected.length) throw fail('Revê a seleção de ficheiros repetidos.');
      const result = await commitReviewed(repo, entries, message, { checkTree: async tree => {
        const files = [...entries.keys()];
        const [current, final, auto] = await Promise.all([
          attributes(repo.root, files), attributes(repo.root, files, tree), config(repo.root, 'core.autocrlf'),
        ]);
        for (const item of selected) {
          if (!item.entry) continue;
          const sample = item.bytes === 'cr' ? Buffer.from([13]) : null;
          const reason = conversion(current.get(item.file), auto, sample) || conversion(final.get(item.file), auto, sample);
          if (reason) throw fail(item.file + ': ' + reason);
        }
      } });
      for (const receipt of receipts) this.previews.delete(receipt);
      return result;
    }
    if (action === 'restore') {
      const preview = this.get(project, body.receipt, 'restore');
      if (preview.shown < preview.view.diff.length || !sameBase(repo, preview.base)) throw fail('A branch ou o commit mudou. Volta a pré-visualizar.');
      let target = preview.target;
      if (target) {
        target = target.backup ? (await readBackup(repo, target.backup)).entry : await readBlob(repo.root, target);
        if (!sameEntry(target, preview.target)) throw fail('A cópia de recuperação mudou. Volta a rever.');
      }
      const [attrs, auto] = await Promise.all([attributes(repo.root, [preview.file]), config(repo.root, 'core.autocrlf')]);
      const unsupported = conversion(attrs.get(preview.file), auto, target?.bytes);
      if (unsupported) throw fail(unsupported);
      const result = await withWorktreeIndex(repo, () => restoreFile(repo, preview.file, preview.before, target));
      this.previews.delete(body.receipt);
      return result;
    }
    if (action === 'branch-create') {
      if (!repo.head) throw fail('Cria o primeiro commit antes de abrir outra branch.');
      const ref = await branchName(repo, body.name);
      await git(repo.root, ['update-ref', '--no-deref', '-m', 'HYDRAQ: nova branch', ref, repo.head, '0'.repeat(repo.head.length)]);
      return { created: body.name };
    }
    if (action === 'branch-switch') {
      const ref = await branchName(repo, body.name);
      const target = (await branchList(repo)).find(branch => branch.name === body.name);
      if (!target) throw fail('A branch local deixou de existir.');
      if (ref === repo.branch) return { switched: body.name };
      const [oldTree, newTree, index, configured] = await Promise.all([
        treeEntries(repo.root, repo.head), treeEntries(repo.root, target.oid), indexEntries(repo.root),
        gitText(repo.root, ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'], { allowed: [1] }),
      ]);
      const files = [...new Set([...oldTree.keys(), ...newTree.keys(), ...index.keys()])].map(validPath);
      const [currentAttrs, destinationAttrs] = await Promise.all([
        attributes(repo.root, files), attributes(repo.root, files, target.oid),
      ]);
      if (files.some(file => [currentAttrs, destinationAttrs].some(attrs => !['unspecified', 'unset'].includes(attrs.get(file)?.filter)))) {
        throw fail('Há ficheiros com filtros Git numa das branches. Troca de branch no terminal.');
      }
      const names = [...new Set(configured.split('\n').filter(Boolean).map(key => key.slice(0, key.lastIndexOf('.'))))];
      const disabled = names.flatMap(name => ['clean', 'smudge', 'process'].flatMap(key => ['-c', name + '.' + key + '='])
        .concat(['-c', name + '.required=false']));
      await git(repo.root, [...disabled, '-c', 'submodule.recurse=false', 'switch',
        '--no-guess', '--no-overwrite-ignore', '--no-recurse-submodules', '--', body.name]);
      return { switched: body.name };
    }
    if (action === 'remote-add') return addRemote(repo, body.name, body.address);
    if (action === 'push') {
      const preview = this.get(project, body.receipt, 'push');
      const result = await pushReviewed(repo, preview);
      this.previews.delete(body.receipt);
      return result;
    }
    throw fail('Operação Git desconhecida.', 404);
  }
  async handle(projectId, action, body = {}) {
    const project = await this.project(projectId);
    if (['init', 'commit', 'restore', 'branch-create', 'branch-switch', 'remote-add', 'push', 'recover'].includes(action)) {
      return this.reserve(project, async () => this.mutate(project, await repoAt(project.root), action, body));
    }
    const repo = await repoAt(project.root);
    if (action === 'state') return this.state(project, repo);
    if (!repo) throw fail('Ativa Git no projeto primeiro.');
    if (action === 'diff') return this.reviewedFile(project, repo, body.file);
    if (action === 'diff-page') {
      if (!['diff', 'history-diff', 'restore'].includes(body.kind)) throw fail('Tipo de diff inválido.');
      const record = this.get(project, body.receipt, body.kind);
      if (body.offset > record.shown) throw fail('Abre as partes anteriores do diff primeiro.');
      const result = this.page(record.view, body.offset);
      record.shown = Math.max(record.shown, body.offset + result.diff.length);
      return result;
    }
    if (action === 'history') {
      const offset = body.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 50000) throw fail('Página de histórico inválida.');
      const tip = body.tip ? checkCommit(body.tip) : repo.head;
      const rows = await history(repo, tip, null, offset);
      return { tip, commits: rows.slice(0, 50), next: rows.length > 50 ? offset + 50 : null };
    }
    if (action === 'history-files') {
      const right = checkCommit(body.right);
      const left = body.left === undefined ? (await commitParents(repo, right))[0] || null : revision(body.left);
      return { left, right, files: await this.historyFiles(repo, left, right) };
    }
    if (action === 'history-diff') return this.historyDiff(project, repo, body);
    if (action === 'restore-preview') return this.restorePreview(project, repo, body);
    if (action === 'push-preview') {
      const preview = await previewPush(repo, body.remote);
      return { ...preview, branch: repo.branch, receipt: this.put(project, repo, 'push', {
        remote: body.remote, url: preview.url, old: preview.old, branch: repo.branch, head: repo.head,
      }) };
    }
    throw fail('Operação Git desconhecida.', 404);
  }
}
