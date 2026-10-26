export class NativeSessionsUI {
  constructor({api, state, current, project, choose, refresh, toast, changed}) {
    Object.assign(this, {api, state, current, project, choose, refresh, toast, changed});
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
    this.open = () => this.run(async () => {
      const result = await this.api(`/api/conversations/${this.current().id}/native-open`, {});
      this.commandId = result.conversationId;
      query('textarea').value = result.command || '';
      query('[data-native-command]').hidden = false;
      if (result.warning) { query('[data-native-command]').open = true; this.toast(result.warning); }
    });
    this.release = () => this.run(async () => {
      await this.api(`/api/conversations/${this.session().conversationId}/native-release`, {});
      query('[data-native-command]').hidden = true;
    });
    query('[data-native-open]').onclick = () => this.open();
    query('[data-native-release]').onclick = () => this.release();
    query('[data-native-list]').onclick = () => this.list(false);
    query('[data-native-more]').onclick = () => this.list(true);
  }
  session() {
    const c = this.current();
    return this.state()?.nativeSessions?.sessions.find(s => s.group === (c?.group || c?.id));
  }
  releasable() { return !this.query('[data-native-release]').disabled; }
  /** The command of the terminal that holds this conversation; it also stays visible in this section. */
  async command() {
    const session = this.session();
    if (!session) return '';
    const result = await this.api(`/api/conversations/${session.conversationId}/native-open`, {});
    this.commandId = result.conversationId;
    this.query('textarea').value = result.command || '';
    this.query('[data-native-command]').hidden = !result.command;
    return result.command || '';
  }
  /** A launch that failed leaves the command open here: the person has to copy it. */
  attention() { const command = this.query('[data-native-command]'); return !command.hidden && command.open; }
  // The terminal controls hear when the action starts and once the state is fetched after it, so they show its progress too.
  async run(action) {
    if (this.pending) return;
    this.pending = true; this.render(); this.changed?.();
    try { await action(); }
    catch (error) { this.toast(error.message); }
    finally { this.pending = false; this.render(); }
    await this.refresh().catch(error => this.toast(error.message));
    this.changed?.();
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

export class OpenCodeSessionsUI {
  constructor({api,state,current,refresh,toast,changed}){
    Object.assign(this,{api,state,current,refresh,toast,changed});this.host=document.querySelector('#opencode-sessions');
    this.host.innerHTML='<p class="settings-title">OpenCode original</p><p data-status class="reading-hint"></p><div class="native-actions"><button data-open type="button">Abrir no terminal</button><button data-release type="button">Continuar na HYDRAQ</button><button data-sync type="button">Recuperar histórico</button></div><details data-command hidden><summary>Comando para abrir noutro terminal</summary><textarea readonly rows="4" aria-label="Comando do terminal OpenCode"></textarea></details>';
    this.query=s=>this.host.querySelector(s);
    this.open=()=>this.run(async()=>{const result=await api('/api/conversations/'+current().id+'/opencode-open',{});if(result.command){this.query('textarea').value=result.command;this.query('[data-command]').hidden=false;}if(result.warning){this.query('[data-command]').open=true;toast(result.warning);}});
    this.release=()=>this.run(async()=>{await api('/api/conversations/'+this.session().id+'/opencode-release',{});this.query('[data-command]').hidden=true;});
    this.query('[data-open]').onclick=()=>this.open();
    this.query('[data-release]').onclick=()=>this.release();
    this.query('[data-sync]').onclick=()=>this.run(()=>api('/api/conversations/'+(this.session()||current()).id+'/opencode-sync',{}));
  }
  session(){const c=this.current();return this.state()?.conversations.find(item=>item.provider==='opencode'&&item.terminal&&(item.group||item.id)===(c?.group||c?.id));}
  releasable(){return !this.query('[data-release]').disabled;}
  attention(){const command=this.query('[data-command]');return !command.hidden&&command.open;}
  async run(action){if(this.pending)return;this.pending=true;this.render();this.changed?.();try{await action();}catch(error){this.toast(error.message);}finally{this.pending=false;this.render();}await this.refresh().catch(error=>this.toast(error.message));this.changed?.();}
  render(){
    const session=this.session(),c=session||this.current();this.host.classList.toggle('hidden',!c||c.provider!=='opencode'||this.state()?.providers.opencode?.transport!=='http');if(!c)return;
    this.query('[data-status]').textContent=c.nativeHistory?.status==='unavailable'?'Histórico indisponível: '+c.nativeHistory.error:session?'A conversa está no terminal. O histórico aparece aqui em direto. Fecha o OpenCode antes de continuar na HYDRAQ.':c.threadId?'A mesma sessão privada pode continuar no terminal OpenCode.':'Envia primeiro um pedido para criar a sessão OpenCode.';
    this.query('[data-open]').disabled=Boolean(this.pending||session||!c.threadId||['starting','running','waiting','uncertain'].includes(c.status));
    this.query('[data-release]').hidden=!session;this.query('[data-release]').disabled=Boolean(this.pending);
    this.query('[data-sync]').disabled=Boolean(this.pending||!c.threadId);
  }
}

/** Antigravity original: the same conversation in agy. Coming back brings the requests typed there and what git saw change; the answers stay in agy. */
export class AntigravitySessionsUI {
  constructor({api, state, current, refresh, toast, changed}) {
    Object.assign(this, {api, state, current, refresh, toast, changed});
    this.host = document.querySelector('#antigravity-sessions');
    this.host.innerHTML = `<p class="settings-title">Antigravity original</p>
      <p data-status class="reading-hint"></p>
      <div class="native-actions"><button type="button" data-open>Abrir no terminal</button><button type="button" data-release>Continuar na HYDRAQ</button></div>
      <div data-confirm class="claude-confirm" role="alert" hidden><p></p><div class="native-actions"><button type="button" data-proceed>Confirmo que o agy está fechado</button><button type="button" data-cancel>Cancelar</button></div></div>
      <details data-command hidden><summary>Comando para abrir noutro terminal</summary><textarea readonly rows="4" aria-label="Comando do Antigravity original"></textarea></details>`;
    const query = selector => this.host.querySelector(selector);
    this.query = query;
    // HYDRAQ does not guess that agy is closed: an unsure answer, opening or coming back, waits for the person.
    const open = (id, confirm = []) => this.run(async () => {
      try {
        const result = await this.api(`/api/conversations/${id}/antigravity-open`, {confirm});
        this.commandId = result.conversationId;
        query('textarea').value = result.command || '';
        query('[data-command]').hidden = false;
        if (result.warning) { query('[data-command]').open = true; this.toast(result.warning); }
      } catch (error) {
        if (error.code !== 'TERMINAL_CONFIRM') throw error;
        this.confirmation = {context: this.current()?.id, message: error.message, label: 'Não é esta conversa · abrir', proceed: () => open(id, [...confirm, error.confirm])};
      }
    });
    this.open = () => open((this.session() || this.current()).id);
    const release = (id, confirm = []) => this.run(async () => {
      try {
        const result = await this.api(`/api/conversations/${id}/antigravity-release`, {confirm});
        query('[data-command]').hidden = true;
        const answered = result.answered ?? 0, unconfirmed = result.unconfirmed ?? 0;
        this.toast([result.imported ? `${result.imported} pedido(s) do Antigravity original adicionados à conversa${answered === result.imported ? ', com as respostas.' : answered ? `, ${answered} com resposta.` : unconfirmed ? '.' : '. As respostas ficaram no agy.'}` : 'Nenhum pedido novo no Antigravity original.',
          unconfirmed ? `${unconfirmed} sem conclusão confirmada pelo agy.` : '',
          result.recovered ? `Recuperada(s) ${result.recovered} resposta(s) de pedidos trazidos antes sem elas.` : '', result.warning].filter(Boolean).join(' '));
      } catch (error) {
        if (error.code !== 'TERMINAL_CONFIRM') throw error;
        this.confirmation = {context: this.current()?.id, message: error.message, label: 'Confirmo que o agy está fechado', proceed: () => release(id, [...confirm, error.confirm])};
      }
    });
    this.release = () => release(this.session()?.id);
    query('[data-open]').onclick = () => this.open();
    query('[data-release]').onclick = () => this.release();
    query('[data-proceed]').onclick = () => { const proceed = this.confirmation?.proceed; this.confirmation = null; this.render(); proceed?.(); };
    query('[data-cancel]').onclick = () => { this.confirmation = null; this.render(); };
  }
  session() {
    const c = this.current();
    if (!c) return null;
    const group = c.group || c.id;
    return this.state()?.conversations.find(item => item.provider === 'antigravity' && item.terminal && (item.group || item.id) === group) || null;
  }
  releasable() { return !this.query('[data-release]').disabled; }
  /** The command of the agy that holds this conversation; it also stays visible in this section. */
  async command() {
    const session = this.session();
    if (!session) return '';
    const result = await this.api(`/api/conversations/${session.id}/antigravity-open`, {});
    this.commandId = result.conversationId;
    this.query('textarea').value = result.command || '';
    this.query('[data-command]').hidden = !result.command;
    return result.command || '';
  }
  attention() { const command = this.query('[data-command]'); return Boolean(this.confirmation) || (!command.hidden && command.open); }
  // The terminal controls hear when the action starts and once the state is fetched after it, so they show its progress too.
  async run(action) {
    if (this.pending) return;
    this.pending = true; this.render(); this.changed?.();
    try { await action(); }
    catch (error) { this.toast(error.message); }
    finally { this.pending = false; this.render(); }
    await this.refresh().catch(error => this.toast(error.message));
    this.changed?.();
  }
  render() {
    const state = this.state(), c = this.current(), session = this.session();
    if (this.confirmation && this.confirmation.context !== c?.id) this.confirmation = null;
    this.host.classList.toggle('hidden', !c || !state?.antigravityTerminal?.available || Boolean(c.provider !== 'antigravity' && !session));
    const target = session || c, preparing = Boolean(target && state?.antigravityTerminal?.pending?.includes(target.id));
    const busy = ['starting', 'running', 'waiting', 'uncertain'].includes(target?.status);
    const open = this.query('[data-open]');
    open.textContent = session ? 'Ver comando do terminal' : 'Abrir no terminal';
    open.disabled = Boolean(this.pending) || preparing || (!session && (!c || c.provider !== 'antigravity' || busy || !c.threadId || !c.turns?.length));
    this.query('[data-release]').hidden = !session;
    this.query('[data-release]').disabled = Boolean(this.pending) || preparing;
    const since = session ? new Date(session.terminal.since).toLocaleTimeString('pt-PT', {hour: '2-digit', minute: '2-digit'}) : '';
    this.query('[data-status]').textContent = session
      ? `Esta conversa está no Antigravity original desde as ${since}. A HYDRAQ não envia pedidos nem trabalha nesta pasta até voltares. Sai do agy (/exit) e escolhe Continuar na HYDRAQ: voltam os pedidos e as respostas que o agy registou.`
      : 'Continua a mesma conversa no agy original, num terminal, com o mesmo modelo e as mesmas restrições (lá podes mudar de modo). Ao voltar, a HYDRAQ traz os pedidos e as respostas do registo do agy; se não o conseguir ler, só os pedidos e os ficheiros alterados. Envia primeiro um pedido para a guardar.';
    if (this.commandId !== session?.id) this.query('[data-command]').hidden = true;
    const confirm = this.query('[data-confirm]');
    confirm.hidden = !this.confirmation;
    confirm.querySelector('p').textContent = this.confirmation?.message || '';
    this.query('[data-proceed]').textContent = this.confirmation?.label || 'Confirmo que o agy está fechado';
    for (const button of confirm.querySelectorAll('button')) button.disabled = Boolean(this.pending);
  }
}

const terminalNames = {codex: 'Codex', claude: 'Claude', opencode: 'OpenCode', antigravity: 'Antigravity'};
const working = new Set(['starting', 'running', 'waiting']);
// What the person does before coming back, and what comes back with the conversation.
const returnSteps = {
  codex: 'A HYDRAQ acompanha o trabalho em direto. Fecha o Codex no terminal e continua aqui.',
  claude: 'Sai do Claude (/exit) e continua aqui: a HYDRAQ importa o que fizeste na sessão.',
  antigravity: 'Sai do agy (/exit) e continua aqui: voltam os pedidos e as respostas que o agy registou.',
  opencode: 'O histórico aparece aqui em direto. Fecha o OpenCode antes de continuar aqui.',
};
const disconnected = 'O Codex no terminal não está ligado. Continua aqui, ou volta a abri-lo com o comando.';
const clock = at => new Date(at).toLocaleTimeString('pt-PT', {hour: '2-digit', minute: '2-digit'});
/**
 * The terminal handover next to the composer: who holds the conversation, and the way back. It drives the
 * sections in the settings, so their checks and confirmations still apply; those open only when needed.
 * With `detail`, the steps and the reason a button is off are written out instead of left to the tooltip.
 */
export class TerminalSwitch {
  constructor({host, state, current, dual, choose, reveal, sections, toast, detail = false}) {
    Object.assign(this, {host, state, current, dual, choose, reveal, sections, toast, detail});
    this.host.addEventListener('click', event => {
      const button = event.target.closest('button[data-terminal]');
      if (button && !button.disabled) this.act(button.dataset.terminal);
    });
  }
  /** Copies the command of the terminal that holds the conversation; if the browser refuses, the settings show it. */
  async copy(held) {
    if (this.copying) return;
    this.copying = 'busy'; this.render();
    try {
      const command = await held.ui.command();
      if (!command) throw Error('O comando não está disponível.');
      try { await navigator.clipboard.writeText(command); this.copying = 'done'; }
      catch { this.copying = null; this.toast?.('Não foi possível copiar. O comando está nas configurações.'); const details = held.ui.host.querySelector('textarea')?.closest('details'); if (details) details.open = true; this.reveal(held.ui.host); }
    } catch (error) { this.copying = null; this.toast?.(error.message); }
    this.render();
    if (this.copying === 'done') setTimeout(() => { this.copying = null; this.render(); }, 1800);
  }
  held() { for (const [provider, ui] of Object.entries(this.sections)) if (ui.session()) return {provider, ui}; return null; }
  /** A normal conversation goes itself; a dual sends its principal, the only member that may write. */
  target() {
    const c = this.current(), record = c && this.dual()?.record(c);
    const id = record ? record.members[record.principal].conversationId : c?.id;
    return id ? this.state()?.conversations.find(item => item.id === id) || null : null;
  }
  reason(target) {
    const state = this.state(), provider = target.provider;
    if (!this.sections[provider]) return 'unavailable';
    if (provider === 'codex' && !state?.nativeSessions?.available) return 'unavailable';
    if (provider === 'claude' && !state?.claudeTerminal?.available) return 'unavailable';
    if (provider === 'opencode' && state?.providers?.opencode?.transport !== 'http') return 'unavailable';
    if (provider === 'antigravity' && !state?.antigravityTerminal?.available) return 'unavailable';
    if (this.dual()?.running(this.current())) return 'Aguarda o fim da ronda dual.';
    if (working.has(target.status) || target.status === 'uncertain') return 'Aguarda que o pedido termine.';
    if (state?.providers?.[provider]?.connection !== 'connected') return `Liga primeiro o ${terminalNames[provider]}.`;
    if (!target.threadId || !target.turns?.length || (provider === 'claude' && !target.sessionStarted)) return 'Envia primeiro um pedido para guardar a sessão.';
    return '';
  }
  async act(action) {
    const held = this.held();
    if (action === 'command') { if (held?.ui.command) await this.copy(held); return; }
    // The section tells both controls when its request starts and settles; this one only shows what needs the person.
    if (action === 'release') { if (!held) return; await held.ui.release(); if (held.ui.attention()) this.reveal(held.ui.host); return; }
    const target = this.target(), ui = target && this.sections[target.provider];
    if (!ui) return;
    if (target.id !== this.current()?.id) this.choose(target.id);
    await ui.open();
    if (ui.attention()) this.reveal(ui.host);
  }
  /** When the terminal took the conversation and, for Codex, whether its terminal is still connected. */
  holding(held) {
    const session = held.ui.session(), id = session?.conversationId || session?.id;
    const since = session?.terminal?.since || this.state()?.conversations.find(item => item.id === id)?.terminal?.since || null;
    return {since, connected: typeof session?.connected === 'boolean' ? session.connected : null};
  }
  render() {
    const held = this.held(), target = held ? null : this.target(), reason = target ? this.reason(target) : 'unavailable';
    const record = this.current() && this.dual()?.record(this.current());
    const holding = held && this.holding(held);
    const view = held ? ['held', held.provider, held.ui.pending, held.ui.releasable(), holding.since, holding.connected, Boolean(held.ui.command), this.copying || null] : reason === 'unavailable' ? null : ['open', target.provider, target.id, reason, Boolean(record), this.sections[target.provider].pending];
    const signature = JSON.stringify(view);
    this.host.hidden = !view;
    if (this.host.dataset.signature === signature) return;
    this.host.dataset.signature = signature;
    this.host.replaceChildren();
    if (!view) return;
    const button = (action, label, tip, disabled) => {
      const element = document.createElement('button');
      element.type = 'button'; element.className = 'terminal-switch-button'; element.dataset.terminal = action;
      element.textContent = label; element.dataset.tip = tip; element.disabled = disabled;
      return element;
    };
    const caption = text => { if (this.detail && text) { const note = document.createElement('small'); note.className = 'terminal-switch-caption'; note.textContent = text; this.host.append(note); } };
    if (held) {
      const name = terminalNames[held.provider], pending = Boolean(held.ui.pending);
      this.host.dataset.state = 'held'; this.host.dataset.client = held.provider;
      this.host.dataset.live = holding.connected === null ? 'unknown' : String(holding.connected);
      const status = document.createElement('strong');
      status.className = 'terminal-switch-status';
      status.textContent = [`${name} no terminal`, holding.since && `desde as ${clock(holding.since)}`, holding.connected === false && 'desligado'].filter(Boolean).join(' · ');
      const steps = holding.connected === false ? disconnected : returnSteps[held.provider];
      status.dataset.tip = steps;
      this.host.append(status);
      if (held.ui.command) this.host.append(button('command', this.copying === 'done' ? 'Copiado ✓' : this.copying ? 'A obter…' : 'Copiar comando', `Copia o comando que volta a abrir esta sessão no ${name} original, noutro terminal.`, pending || Boolean(this.copying)));
      this.host.append(button('release', pending ? 'A voltar…' : 'Continuar na HYDRAQ', `Traz a conversa de volta do ${name} original, com o que fizeste no terminal. ${steps}`, pending || !held.ui.releasable()));
      caption(steps);
      return;
    }
    const name = terminalNames[target.provider], pending = Boolean(this.sections[target.provider].pending);
    this.host.dataset.state = 'open'; this.host.dataset.client = target.provider; delete this.host.dataset.live;
    const tip = reason || `Continua a mesma sessão no ${name} original, num terminal. Voltas com «Continuar na HYDRAQ», aqui.${record ? ' No Dual, só o principal abre no terminal e o Dual fica em pausa até voltares.' : ''}`;
    this.host.append(button('open', pending ? `A abrir no terminal · ${name}…` : `Abrir no terminal · ${name}${record ? ' (principal)' : ''}`, tip, Boolean(reason) || pending));
    caption(reason);
  }
}
