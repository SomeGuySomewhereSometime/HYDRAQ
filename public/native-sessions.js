export class NativeSessionsUI {
  constructor({api, state, current, project, choose, refresh, toast}) {
    Object.assign(this, {api, state, current, project, choose, refresh, toast});
    this.host = document.querySelector('#native-sessions');
    this.host.innerHTML = `<p class="settings-title">Codex original</p>
      <p data-native-status class="reading-hint"></p>
      <div class="native-actions"><button type="button" data-native-open>Abrir no terminal</button><button type="button" data-native-release>Continuar na HYDRAQ</button></div>
      <details data-native-command hidden><summary>Comando para abrir noutro terminal</summary><textarea readonly aria-label="Comando do terminal Codex" rows="4"></textarea></details>
      <details data-native-import><summary>Associar sessão Codex existente</summary>
        <p class="reading-hint">Escolhe uma sessão desta pasta. Fecha primeiro o cliente original que a esteja a usar. O histórico mantém o mesmo identificador.</p>
        <label>Pasta do projeto<input data-native-cwd type="text" autocomplete="off"></label>
        <button type="button" data-native-list>Procurar sessões</button>
        <div data-native-results></div><button type="button" data-native-more hidden>Mais sessões</button>
      </details>`;
    const query = selector => this.host.querySelector(selector);
    this.query = query;
    query('[data-native-open]').onclick = () => this.run(async () => {
      const result = await this.api(`/api/conversations/${this.current().id}/native-open`, {});
      this.commandId = result.conversationId;
      query('textarea').value = result.command || '';
      query('[data-native-command]').hidden = false;
      if (result.warning) { query('[data-native-command]').open = true; this.toast(result.warning); }
    });
    query('[data-native-release]').onclick = () => this.run(async () => {
      await this.api(`/api/conversations/${this.session().conversationId}/native-release`, {});
      query('[data-native-command]').hidden = true;
    });
    query('[data-native-list]').onclick = () => this.list(false);
    query('[data-native-more]').onclick = () => this.list(true);
  }
  session() {
    const c = this.current();
    return this.state()?.nativeSessions?.sessions.find(s => s.group === (c?.group || c?.id));
  }
  async run(action) {
    if (this.pending) return;
    this.pending = true; this.render();
    try { await action(); await this.refresh(); }
    catch (error) { this.toast(error.message); }
    finally { this.pending = false; this.render(); }
  }
  list(more) {
    return this.run(async () => {
      const cwd = this.query('[data-native-cwd]').value.trim();
      if (more && cwd !== this.listCwd) throw Error('A pasta mudou. Procura novamente as sessões.');
      const page = await this.api('/api/native/list', {cwd, cursor: more ? this.cursor : null});
      this.listCwd = cwd; this.cursor = page.nextCursor;
      const results = this.query('[data-native-results]');
      if (!more) results.replaceChildren();
      for (const session of page.data) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'native-import-row';
        button.textContent = `${session.imported ? 'Abrir · ' : ''}${session.title || session.id}`;
        button.title = session.id;
        button.onclick = () => this.run(async () => {
          const project = this.project();
          if (project && cwd !== project.root) throw Error('Usa a pasta deste projeto ou escolhe outro projeto antes de associar.');
          const result = await this.api('/api/native/import', {threadId: session.id, cwd,
            projectId: project?.id, revision: this.state().projectCatalog?.revision});
          await this.refresh(); this.choose(result.conversationId);
        });
        results.append(button);
      }
      if (!more && !page.data.length) results.textContent = 'Não foram encontradas sessões Codex nesta pasta.';
      this.query('[data-native-more]').hidden = !this.cursor;
    });
  }
  render() {
    const state = this.state(), c = this.current(), session = this.session();
    this.host.classList.toggle('hidden', !state?.nativeSessions?.available || (c && c.provider !== 'codex' && !session));
    const controlled = session ? state.conversations.find(item=>item.id===session.conversationId) : c;
    const busy = ['starting','running','waiting','uncertain'].includes(controlled?.status);
    this.query('[data-native-open]').hidden = false;
    this.query('[data-native-open]').textContent = session ? 'Ver comando do terminal' : 'Abrir no terminal';
    this.query('[data-native-open]').disabled = this.pending || session?.preparing || (!session && (busy || !c?.threadId || !c?.turns?.length || state?.providers?.codex?.connection !== 'connected')); 
    this.query('[data-native-release]').hidden = !session;
    this.query('[data-native-release]').disabled = this.pending || busy || session?.preparing;
    this.query('[data-native-status]').textContent = session
      ? session.connected ? 'O terminal controla esta conversa. A HYDRAQ acompanha o trabalho.' : 'O controlo está no terminal. Podes voltar a ligá-lo pelo comando ou continuar na HYDRAQ quando a tarefa terminar.'
      : 'Continua a mesma sessão no terminal original. Envia primeiro um pedido para a guardar.';
    if (this.commandId !== c?.id || !session) this.query('[data-native-command]').hidden = true;
    const scope = c?.cwd || this.project()?.root || state?.defaultCwd || '';
    if (scope !== this.scope) { this.scope = scope; this.query('[data-native-cwd]').value = scope; this.query('[data-native-results]').replaceChildren(); this.query('[data-native-more]').hidden = true; }
    for (const button of this.host.querySelectorAll('[data-native-list], [data-native-more], .native-import-row')) button.disabled = Boolean(this.pending);
  }
}
