const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
};
const short = oid => oid?.slice(0, 12) || '—';
const size = bytes => bytes == null ? '—' : bytes < 1024 ? bytes + ' B' :
  new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 1 }).format(bytes / (bytes < 1048576 ? 1024 : 1048576)) +
  (bytes < 1048576 ? ' KiB' : ' MiB');
const select = (placeholder, options) => {
  const input = node('select');
  for (const [value, text] of [['', placeholder], ...options]) {
    const option = node('option', text);
    option.value = value;
    input.append(option);
  }
  input.setAttribute('aria-label', placeholder);
  return input;
};
const field = (label, input) => {
  const row = node('label', label, 'git-field');
  row.append(input);
  return row;
};

export class GitPanelUI {
  constructor({ api }) {
    this.api = api;
    this.dialog = node('dialog', undefined, 'project-dialog git-dialog');
    this.dialog.setAttribute('aria-labelledby', 'git-panel-title');
    document.body.append(this.dialog);
    this.dialog.addEventListener('cancel', event => { if (this.busy) event.preventDefault(); });
  }
  call(action, body) {
    return this.api('/api/projects/' + this.project.id + '/git' + (action ? '/' + action : ''), body);
  }
  button(text, action, { disabled = false, primary = false } = {}) {
    const button = node('button', text, primary ? 'primary-action' : undefined);
    button.type = 'button';
    button.disabled = disabled;
    button.addEventListener('click', () => this.run(action));
    return button;
  }
  async run(action) {
    if (this.busy) return;
    this.busy = true;
    this.dialog.setAttribute('aria-busy', 'true');
    this.error.textContent = '';
    this.dialog.classList.add('git-busy');
    try { await action(); }
    catch (error) { this.error.textContent = error.message; }
    finally {
      this.busy = false;
      this.dialog.removeAttribute('aria-busy');
      this.dialog.classList.remove('git-busy');
    }
  }
  async open(project, { onCheckpoint, selectedCheckpoint, taskId } = {}) {
    if (!project || this.busy) return;
    this.project = project;
    this.onCheckpoint = onCheckpoint;
    this.selectedCheckpoint = selectedCheckpoint;
    this.state = null;
    this.tab = 'changes';
    this.selection = new Map();
    this.message = '';
    this.dialog.replaceChildren();
    const header = node('header', undefined, 'project-dialog-heading');
    const title = node('h2', (taskId ? 'Alterações desde o ponto de segurança' : onCheckpoint ? 'Ponto de segurança Git' : 'Git') + ' · ' + project.name);
    title.id = 'git-panel-title';
    header.append(title, this.button('Fechar', () => this.dialog.close()));
    this.notice = node('p', '', 'git-status');
    this.notice.setAttribute('role', 'status');
    this.error = node('p', '', 'git-error');
    this.error.setAttribute('role', 'alert');
    this.tabs = node('nav', undefined, 'git-toolbar');
    this.tabs.setAttribute('aria-label', 'Áreas do painel Git');
    this.main = node('div', undefined, 'git-main');
    this.dialog.append(header, this.notice, this.error, this.tabs, this.main);
    if (selectedCheckpoint) this.tabs.append(this.button('Retirar associação ao pedido', () => this.finishCheckpoint(null)));
    if (!this.dialog.open) this.dialog.showModal();
    await this.run(() => taskId ? this.checkpointChanges(taskId) : this.refresh());
  }
  finishCheckpoint(point) {
    this.dialog.close();
    this.onCheckpoint(point);
  }
  async checkpointChanges(taskId, message = '') {
    this.notice.textContent = message || 'A ler o repositório…';
    this.main.replaceChildren();
    if (!this.tabs.children.length) this.tabs.append(this.button('Atualizar', () => this.checkpointChanges(taskId)));
    const result = await this.call('checkpoint-files', { taskId });
    this.notice.textContent = message || 'Ponto de segurança · ' + short(result.commit);
    const files = node('div', undefined, 'git-files');
    const preview = node('section', undefined, 'git-preview');
    for (const entry of result.files) {
      const row = node('div', undefined, 'git-file');
      row.append(this.button(entry.status + ' · ' + entry.file, async () => {
        const diff = await this.call('checkpoint-diff', { file: entry.file, receipt: result.receipt });
        this.showDiff(preview, entry.file, diff, 'checkpoint-diff', () => {
          preview.append(this.button('Pré-visualizar restauro', () => this.restorePreview(preview, {
            file: entry.file, commit: result.commit,
          }, message => this.checkpointChanges(taskId, message))));
        });
      }, { disabled: entry.sensitive }));
      if (entry.sensitive) row.append(node('small', 'Possível segredo'));
      files.append(row);
    }
    if (!files.children.length) files.append(node('p', 'Sem alterações em relação ao ponto de segurança.'));
    this.main.replaceChildren(node('p', 'Compara o commit guardado com a pasta atual do projeto. Inclui alterações anteriores que ficaram fora do ponto e edições posteriores, incluindo as que ainda estão sem commit.'), files, preview);
  }
  async refresh(message = '') {
    this.notice.textContent = 'A ler o repositório…';
    this.state = await this.call();
    this.selection.clear();
    this.notice.textContent = message || (this.state.initialized
      ? (this.state.branch || 'HEAD destacado') + ' · ' + (this.state.head ? short(this.state.head) : 'Sem commits')
      : 'Este projeto ainda não tem Git.');
    this.render();
  }
  render() {
    this.tabs.replaceChildren();
    this.main.replaceChildren();
    if (this.selectedCheckpoint) this.tabs.append(this.button('Retirar associação ao pedido', () => this.finishCheckpoint(null)));
    if (!this.state.initialized) return this.setup();
    if (!this.onCheckpoint) for (const [id, label] of [['changes', 'Alterações'], ['history', 'Histórico'], ['branches', 'Branches'], ['remote', 'Remoto']]) {
      const button = this.button(label, () => { this.tab = id; this.render(); });
      button.setAttribute('aria-pressed', String(id === this.tab));
      this.tabs.append(button);
    }
    this.tabs.append(this.button('Atualizar', () => this.refresh()));
    if (this.state.blocked) this.main.append(node('p', this.state.blocked + '. Aguarda antes de escrever no repositório.', 'git-warning'));
    if (this.state.recovery) this.recovery();
    ({ changes: () => this.changes(), history: () => this.history(), branches: () => this.branches(), remote: () => this.remote() })[this.tab]();
  }
  get locked() { return Boolean(this.state?.blocked || this.state?.recovery); }
  setup() {
    const ignore = node('textarea');
    ignore.rows = 12;
    ignore.value = this.state.ignore;
    ignore.readOnly = this.state.existingIgnore;
    this.main.append(node('p', 'Revê as regras antes de ativar Git. A lista sinaliza nomes sensíveis e ficheiros grandes. Abre o diff para verificar o conteúdo antes do primeiro commit.'),
      field('.gitignore', ignore));
    if (ignore.readOnly) {
      const details = node('details');
      details.append(node('summary', 'Ver regras sugeridas'), node('pre', this.state.suggested));
      this.main.append(node('p', 'O .gitignore existente será preservado.'), details);
    }
    this.main.append(this.button('Ativar Git', async () => {
      await this.call('init', { receipt: this.state.receipt, ignore: ignore.value });
      await this.refresh('Git ativado. Revê os ficheiros antes do primeiro commit.');
    }, { primary: true }));
  }
  recovery() {
    const data = this.state.recovery;
    const block = node('section', undefined, 'git-warning');
    block.append(node('strong', 'Operação Git por recuperar'),
      node('p', 'Branch ' + data.branch + ' · Commit previsto ' + short(data.commit) + ' · Atual ' + short(data.head)));
    if (data.canRepair) block.append(this.button('Atualizar preparação', async () => {
      await this.call('recover', { mode: 'repair' });
      await this.refresh('Preparação atualizada. O commit já criado foi preservado.');
    }, { disabled: Boolean(this.state.blocked) }));
    if (data.canClear) block.append(this.button('Encerrar recuperação', async () => {
      await this.call('recover', { mode: 'clear' });
      await this.refresh('Recuperação encerrada.');
    }, { disabled: Boolean(this.state.blocked) }));
    if (!data.canRepair && !data.canClear) block.append(node('p', data.alive
      ? 'O processo que criou a operação ainda está ativo.' : 'O estado mudou entretanto. Consulta o diário Git no terminal.'));
    this.main.append(block);
  }
  changes() {
    const message = node('textarea');
    message.rows = 3;
    message.value = this.message || '';
    message.placeholder = 'Ex.: Corrige colisões junto à parede';
    message.addEventListener('input', () => { this.message = message.value; update(); });
    const count = node('span', '');
    const button = this.button(this.onCheckpoint ? 'Criar ponto de segurança' : 'Criar commit local', async () => {
      const result = await this.call('commit', { receipts: [...this.selection.values()], message: message.value });
      this.message = '';
      if (this.onCheckpoint) return this.finishCheckpoint(result);
      await this.refresh('Commit criado · ' + short(result.commit));
    }, { primary: true });
    const update = () => {
      count.textContent = this.selection.size + (this.selection.size === 1 ? ' selecionado' : ' selecionados');
      button.disabled = this.locked || this.state.signed || !this.selection.size || !message.value.trim();
    };
    const list = node('div', undefined, 'git-files');
    const preview = node('section', undefined, 'git-preview');
    for (const change of this.state.changes) {
      const row = node('div', undefined, 'git-file');
      const checkbox = node('input');
      checkbox.type = 'checkbox';
      checkbox.disabled = this.locked || !this.selection.has(change.file);
      checkbox.checked = this.selection.has(change.file);
      checkbox.setAttribute('aria-label', 'Incluir ' + change.file);
      checkbox.onchange = () => { if (!checkbox.checked) this.selection.delete(change.file); update(); };
      const detail = node('small', [change.status, change.staged && 'Preparado', change.sensitive && 'Possível segredo',
        change.large && 'Ficheiro grande · considera Git LFS', change.reason].filter(Boolean).join(' · '));
      const open = this.button(change.file, async () => {
        const result = await this.call('diff', { file: change.file });
        this.showDiff(preview, change.file, result, 'diff', () => {
          checkbox.disabled = this.locked || this.state.signed || Boolean(result.reason);
          checkbox.onchange = () => {
            if (checkbox.checked) this.selection.set(change.file, result.receipt);
            else this.selection.delete(change.file);
            update();
          };
        });
        if (checkbox.checked && !result.reason) this.selection.set(change.file, result.receipt);
        else if (result.reason) { this.selection.delete(change.file); checkbox.checked = false; }
        update();
      }, { disabled: change.sensitive });
      const content = node('div');
      content.append(open, detail);
      row.append(checkbox, content);
      list.append(row);
    }
    if (!list.children.length) list.append(node('p', 'Sem alterações para rever.'));
    const toolbar = node('div', undefined, 'git-toolbar');
    toolbar.append(button, count);
    if (this.onCheckpoint) {
      this.main.append(node('p', 'Guarda num commit local os ficheiros que selecionares. Os restantes ficam na pasta e podem aparecer na comparação. O pedido fica por enviar.'));
      if (this.state.head) this.main.append(this.button('Usar o commit atual · ' + short(this.state.head), async () => {
        const point = await this.call('checkpoint-current', { commit: this.state.head, branch: this.state.headRef });
        this.finishCheckpoint(point);
      }, { disabled: this.locked }));
    }
    this.main.append(node('p', 'Revê o diff de cada ficheiro antes de o selecionar. ' + this.state.notice),
      ...(this.state.hooks ? [node('p', 'Há hooks configurados neste repositório. Para os executar, usa o Git no terminal.', 'git-warning')] : []),
      ...(this.state.signed ? [node('p', 'A configuração exige assinatura. Cria o commit no terminal.', 'git-warning')] : []),
      list, preview, field('Mensagem de commit', message), toolbar);
    update();
  }
  showDiff(target, filename, result, kind, complete) {
    target.replaceChildren(node('h3', filename));
    target.append(node('p', size(result.before?.size) + ' → ' + size(result.after?.size) +
      (result.before?.mode !== result.after?.mode ? ' · modo ' + (result.before?.mode || '—') + ' → ' + (result.after?.mode || '—') : '')));
    if (result.reason) target.append(node('p', result.reason, 'git-warning'));
    if (result.binary || result.oversized) target.append(node('p',
      (result.binary ? 'Conteúdo binário.' : 'Diff demasiado grande para mostrar.') +
      (kind === 'diff' ? ' A seleção usa os bytes identificados abaixo.' : '')));
    if (result.binary || result.oversized) target.append(node('code', (result.before?.oid || '—') + ' → ' + (result.after?.oid || '—')));
    const diff = node('pre', result.diff, 'git-diff');
    if (result.diff) {
      diff.tabIndex = 0;
      diff.setAttribute('aria-label', 'Diferenças de ' + filename);
      target.append(diff);
    }
    const more = this.button('Ver próxima parte do diff', async () => {
      const page = await this.call('diff-page', { receipt: result.receipt, kind, offset: result.nextOffset });
      result.nextOffset = page.nextOffset;
      diff.append(document.createTextNode(page.diff));
      if (page.nextOffset == null) { more.remove(); complete?.(); }
    });
    if (result.nextOffset != null) target.append(more);
    else complete?.();
  }
  history() {
    const list = node('div', undefined, 'git-files');
    const detail = node('section', undefined, 'git-preview');
    let tip, next = 0;
    const load = async () => {
      const result = await this.call('history', { tip, offset: next });
      tip = result.tip;
      next = result.next;
      for (const commit of result.commits) {
        const row = node('div', undefined, 'git-file');
        row.append(this.button(short(commit.oid) + ' · ' + commit.title, () => this.historyFiles(detail, { right: commit.oid }, true)),
          node('small', commit.at.slice(0, 10) + ' · ' + commit.author));
        list.append(row);
      }
      more.hidden = next == null;
      if (!list.children.length) list.append(node('p', 'Ainda não há commits.'));
    };
    const more = this.button('Carregar histórico', async () => { await load(); more.textContent = 'Mais commits'; });
    this.main.append(more, list, detail);
    if (this.state.backups.length) {
      const saved = node('details');
      saved.append(node('summary', 'Pontos de segurança de restauros'));
      for (const backup of this.state.backups) saved.append(this.button(backup.file + ' · ' + backup.at.slice(0, 16),
        () => this.restorePreview(detail, { backup: backup.id })));
      this.main.append(saved);
    }
  }
  async historyFiles(detail, payload, canRestore) {
    const result = await this.call('history-files', payload);
    const preview = node('section', undefined, 'git-preview');
    const files = node('div', undefined, 'git-files');
    detail.replaceChildren(node('h3', short(result.left) + ' → ' + short(result.right)), files, preview);
    for (const entry of result.files) {
      const row = node('div', undefined, 'git-file');
      row.append(this.button(entry.status + ' · ' + entry.file, async () => {
        const diff = await this.call('history-diff', { file: entry.file, left: result.left, right: result.right });
        this.showDiff(preview, entry.file, diff, 'history-diff');
        if (canRestore) preview.append(this.button('Pré-visualizar restauro', () => this.restorePreview(preview, {
          file: entry.file, commit: result.right,
        }), { disabled: this.locked }));
      }));
      files.append(row);
    }
    if (!files.children.length) files.append(node('p', 'As árvores são iguais.'));
  }
  async restorePreview(detail, body, onRestored = message => {
    this.tab = 'changes';
    return this.refresh(message);
  }) {
    const result = await this.call('restore-preview', body);
    this.showDiff(detail, result.file, result, 'restore', () => {
      const note = result.after === null
        ? 'O ficheiro não existia no ponto selecionado. Será removido da pasta de trabalho e o conteúdo atual será guardado num ponto de segurança.'
        : 'O conteúdo atual será guardado num ponto de segurança. A operação altera a pasta de trabalho.';
      detail.append(node('p', note),
        this.button('Restaurar ficheiro', async () => {
          await this.call('restore', { receipt: result.receipt });
          await onRestored('Ficheiro restaurado. O ponto de segurança está em Histórico.');
        }, { disabled: this.locked, primary: true }));
    });
  }
  branches() {
    const options = this.state.branches.map(branch => [branch.name, branch.name]);
    const name = node('input');
    name.placeholder = 'experiencia-fisica';
    const target = select('Branch de destino', options);
    const first = select('Branch de origem', options);
    const second = select('Branch a comparar', options);
    first.value = this.state.branch || '';
    const result = node('section', undefined, 'git-preview');
    const oid = name => this.state.branches.find(branch => branch.name === name)?.oid;
    this.main.append(node('p', 'Branch atual · ' + (this.state.branch || 'HEAD destacado')),
      field('Nome da nova branch', name), this.button('Criar a partir do commit atual', async () => {
        await this.call('branch-create', { name: name.value.trim() });
        await this.refresh('Branch criada.');
      }, { disabled: this.locked || !this.state.head }), field('Trocar de branch', target),
      this.button('Mudar para a branch escolhida', async () => {
        await this.call('branch-switch', { name: target.value });
        await this.refresh('Branch alterada.');
      }, { disabled: this.locked }), node('h3', 'Comparar branches'), first, second,
      this.button('Ver diferenças', () => this.historyFiles(result, { left: oid(first.value), right: oid(second.value) }, false)), result);
  }
  remote() {
    const remote = select('Remoto configurado', this.state.remotes.map(name => [name, name]));
    const preview = node('section', undefined, 'git-preview');
    const setup = node('details');
    const name = node('input');
    const address = node('input');
    name.value = 'origin';
    address.placeholder = 'https://github.com/conta/projeto.git';
    setup.append(node('summary', 'Adicionar remoto'), field('Nome do remoto', name), field('Endereço do remoto', address),
      this.button('Guardar remoto', async () => {
        await this.call('remote-add', { name: name.value.trim(), address: address.value.trim() });
        await this.refresh('Remoto guardado.');
      }, { disabled: this.locked }));
    this.main.append(setup, remote, this.button('Pré-visualizar envio', async () => {
      const result = await this.call('push-preview', { remote: remote.value });
      preview.replaceChildren(node('h3', 'Confirmar envio'), node('p', result.url + ' · ' + result.branch.replace('refs/heads/', '')));
      const list = node('ul');
      for (const commit of result.commits) list.append(node('li', short(commit.oid) + ' · ' + commit.title));
      if (!result.commits.length) { preview.append(node('p', 'A branch remota já está neste commit.')); return; }
      preview.append(list, this.button('Confirmar e enviar ' + result.commits.length + (result.commits.length === 1 ? ' commit' : ' commits'), async () => {
        const outcome = await this.call('push', { receipt: result.receipt });
        await this.refresh('Remoto confirmado · ' + short(outcome.pushed));
      }, { disabled: this.locked, primary: true }));
    }, { disabled: !this.state.head || !this.state.remotes.length }), preview);
    remote.addEventListener('change', () => preview.replaceChildren());
  }
}
