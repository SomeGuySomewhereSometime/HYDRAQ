// The original Claude TUI runs outside HYDRAQ: the group stays reserved until the person returns.
export class ClaudeSessionsUI {
  constructor({api, state, current, project, choose, refresh, toast}) {
    Object.assign(this, {api, state, current, project, choose, refresh, toast});
    this.host = document.querySelector('#claude-sessions');
    this.host.innerHTML = `<p class="settings-title">Claude original</p>
      <p data-claude-status class="reading-hint"></p>
      <div class="native-actions"><button type="button" data-claude-open>Abrir no terminal</button><button type="button" data-claude-release>Continuar na HYDRAQ</button></div>
      <div data-claude-confirm class="claude-confirm" role="alert" hidden><p></p><div class="native-actions"><button type="button" data-claude-proceed>Continuar mesmo assim</button><button type="button" data-claude-cancel>Cancelar</button></div></div>
      <details data-claude-command hidden><summary>Comando para abrir noutro terminal</summary><textarea readonly aria-label="Comando do Claude original" rows="4"></textarea></details>
      <details data-claude-import><summary>Associar sessão Claude existente</summary>
        <p class="reading-hint">Sessões do Claude Code guardadas nesta pasta pelo terminal ou pela app Claude. Fecha-as primeiro no cliente original. As conversas normais de claude.ai não ficam no computador e não aparecem aqui.</p>
        <label>Pasta do projeto<input data-claude-cwd type="text" autocomplete="off"></label>
        <button type="button" data-claude-list>Procurar sessões</button>
        <div data-claude-results></div><button type="button" data-claude-more hidden>Mais sessões</button>
      </details>`;
    const query = selector => this.host.querySelector(selector);
    this.query = query;
    query('[data-claude-open]').onclick = () => this.run(async () => {
      const target = this.session() || this.current();
      const result = await this.api(`/api/conversations/${target.id}/claude-open`, {});
      this.commandId = result.conversationId;
      query('textarea').value = result.command || '';
      query('[data-claude-command]').hidden = false;
      if (result.warning) { query('[data-claude-command]').open = true; this.toast(result.warning); }
    });
    const release = (confirm = []) => this.run(async () => {
      try {
        const result = await this.api(`/api/conversations/${this.session().id}/claude-release`, {confirm});
        query('[data-claude-command]').hidden = true;
        this.toast([result.imported ? `${result.imported} pedido(s) do Claude original adicionados à conversa.` : 'Nenhum pedido novo no Claude original.', result.warning].filter(Boolean).join(' '));
      } catch (error) { if (!this.decide(error, kind => release([...confirm, kind]))) throw error; }
    });
    query('[data-claude-release]').onclick = () => release();
    query('[data-claude-proceed]').onclick = () => { const proceed = this.confirmation?.proceed; this.confirmation = null; this.render(); proceed?.(); };
    query('[data-claude-cancel]').onclick = () => { this.confirmation = null; this.render(); };
    query('[data-claude-list]').onclick = () => this.list(false);
    query('[data-claude-more]').onclick = () => this.list(true);
  }
  /** HYDRAQ refuses to guess; the person decides, with the server's explanation, whether to continue. */
  decide(error, proceed) {
    if (error.code !== 'CLAUDE_CONFIRM' || !error.confirm) return false;
    this.confirmation = {message: error.message, kind: error.confirm, proceed: () => proceed(error.confirm)};
    return true;
  }
  session() {
    const c = this.current();
    if (!c) return null;
    const group = c.group || c.id;
    return this.state()?.conversations.find(item => item.provider === 'claude' && item.terminal && (item.group || item.id) === group) || null;
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
      const cwd = this.query('[data-claude-cwd]').value.trim();
      if (more && cwd !== this.listCwd) throw Error('A pasta mudou. Procura novamente as sessões.');
      const page = await this.api('/api/claude/sessions', {cwd, cursor: more ? this.cursor : 0});
      this.listCwd = cwd; this.cursor = page.nextCursor;
      const results = this.query('[data-claude-results]');
      if (!more) results.replaceChildren();
      for (const session of page.data) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'native-import-row';
        const when = new Date(session.updatedAt).toLocaleString('pt-PT', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'});
        button.textContent = `${session.imported ? 'Abrir · ' : ''}${session.source} · ${session.title} · ${when}`;
        button.title = session.id;
        const associate = (confirm = []) => this.run(async () => {
          if (session.conversationId) { this.choose(session.conversationId); return; }
          const project = this.project();
          if (project && cwd !== project.root) throw Error('Usa a pasta deste projeto ou escolhe outro projeto antes de associar.');
          try {
            const result = await this.api('/api/claude/import', {sessionId: session.id, cwd, projectId: project?.id, revision: this.state().projectCatalog?.revision, confirm});
            if (result.warning) this.toast(result.warning);
            await this.refresh(); this.choose(result.conversationId);
          } catch (error) { if (!this.decide(error, kind => associate([...confirm, kind]))) throw error; }
        });
        button.onclick = () => associate();
        results.append(button);
      }
      if (!more && !page.data.length) results.textContent = 'Não foram encontradas sessões do Claude Code nesta pasta.';
      this.query('[data-claude-more]').hidden = this.cursor == null;
    });
  }
  render() {
    const state = this.state(), c = this.current(), session = this.session();
    this.host.classList.toggle('hidden', !state?.claudeTerminal?.available || Boolean(c && c.provider !== 'claude' && !session));
    const target = session || c;
    const busy = ['starting','running','waiting','uncertain'].includes(target?.status);
    const preparing = Boolean(target && state?.claudeTerminal?.pending?.includes(target.id));
    const open = this.query('[data-claude-open]');
    open.textContent = session ? 'Ver comando do terminal' : 'Abrir no terminal';
    open.disabled = this.pending || preparing || (!session && (!c || c.provider !== 'claude' || busy || !c.sessionStarted || !c.turns?.length || c.status === 'uncertain'));
    this.query('[data-claude-release]').hidden = !session;
    this.query('[data-claude-release]').disabled = this.pending || preparing;
    const since = session ? new Date(session.terminal.since).toLocaleTimeString('pt-PT', {hour: '2-digit', minute: '2-digit'}) : '';
    this.query('[data-claude-status]').textContent = session
      ? `Esta conversa está no Claude original desde as ${since}. A HYDRAQ não envia pedidos nem trabalha nesta pasta até voltares. Sai do Claude (/exit) e escolhe Continuar na HYDRAQ para importar o que fizeste.`
      : 'Continua a mesma sessão no Claude original, com todas as funções nativas (incluindo equipas). Envia primeiro um pedido para a guardar.';
    if (this.commandId !== session?.id) this.query('[data-claude-command]').hidden = true;
    const confirm = this.query('[data-claude-confirm]');
    confirm.hidden = !this.confirmation;
    confirm.querySelector('p').textContent = this.confirmation?.message || '';
    this.query('[data-claude-proceed]').textContent = this.confirmation?.kind === 'closed' ? 'Confirmo que o Claude está fechado' : 'Continuar sem esse histórico';
    for (const button of confirm.querySelectorAll('button')) button.disabled = Boolean(this.pending);
    const scope = c?.cwd || this.project()?.root || state?.defaultCwd || '';
    if (scope !== this.scope) { this.scope = scope; this.query('[data-claude-cwd]').value = scope; this.query('[data-claude-results]').replaceChildren(); this.query('[data-claude-more]').hidden = true; }
    for (const button of this.host.querySelectorAll('[data-claude-list], [data-claude-more], .native-import-row')) button.disabled = Boolean(this.pending);
  }
}
