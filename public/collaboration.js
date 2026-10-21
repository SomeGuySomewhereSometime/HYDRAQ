import { elicitationForm } from './elicitation.js';

const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const statuses = { idle: 'Pronta', principal: 'Principal a trabalhar', queued: 'Executor em fila', executor: 'Grok a trabalhar', reporting: 'Principal a avaliar', stopping: 'A parar', completed: 'Concluída', interrupted: 'Interrompida', failed: 'Falhou', uncertain: 'Resultado por confirmar', running: 'Em curso' };
const active = new Set(['principal', 'queued', 'executor', 'reporting', 'stopping']);
const efforts = { low: 'Leve', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo', ultra: 'Ultra' };

export class CollaborationUI {
  constructor({ api, getState, toast, changed, markdown }) {
    Object.assign(this, { api, getState, toast, changed, markdown });
    this.root = document.querySelector('#collaboration-view');
    this.view = location.hash==='#collaboration'||localStorage.getItem('hydraq.view') === 'collaboration' ? 'collaboration' : 'conversations';
    this.selected = localStorage.getItem('hydraq.collaboration');
    this.controls = {};
    document.querySelector('#tab-conversations').addEventListener('click', () => this.show('conversations'));
    document.querySelector('#tab-collaboration').addEventListener('click', () => this.show('collaboration'));
    this.build();
    this.timer = setInterval(() => { if (this.view === 'collaboration' && this.selected && active.has(this.detail?.status)) this.refresh(); }, 1000);
  }
  show(view, notify = true) { this.view = view; localStorage.setItem('hydraq.view', view);const url=new URL(location.href);url.hash=view==='collaboration'?'collaboration':'';history.replaceState(null,'',url); if (notify) this.changed(); }
  button(text, fn, cls = '') {
    const b = node('button', cls, text); b.type = 'button'; b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } catch (e) { this.toast(e.message); } finally { b.disabled = false; } }); return b;
  }
  field(parent, key, label, type = 'select') {
    const l = node('label', 'col-field', label), input = node(type); input.id = 'col-' + key; l.htmlFor = input.id;
    if (type === 'input') input.type = 'text'; this.controls[key] = input; l.append(input); parent.append(l); return input;
  }
  build() {
    this.history = node('aside', 'col-history'); this.history.setAttribute('aria-label', 'Colaborações guardadas');
    this.newButton = this.button('＋ Nova colaboração', () => this.choose(null), 'col-new');
    this.list = node('nav', 'col-session-list'); this.history.append(this.newButton, this.list);
    this.main = node('section', 'col-conversation'); this.main.setAttribute('aria-label', 'Conversa com o principal');
    const heading = node('div', 'col-heading'); heading.append(node('h1', '', 'Principal + executor')); this.badge = node('span', 'col-status'); heading.append(this.badge);
    this.error = node('div', 'notice hidden'); this.error.setAttribute('role', 'alert');
    this.recover=this.button('Verificar limpeza e desbloquear',async()=>{await this.api('/api/collaboration/recover',{});await this.refresh(true);},'col-recover hidden');
    this.settings = node('details', 'col-settings'); this.settings.open = !this.selected; this.settingsSummary = node('summary', '', 'Equipa e pasta');
    const fields = node('div', 'col-settings-grid');
    this.field(fields, 'project', 'Projeto'); this.field(fields, 'cwd', 'Pasta de trabalho', 'input');
    this.field(fields, 'model', 'Principal · Codex'); this.field(fields, 'effort', 'Raciocínio do principal');
    this.field(fields, 'workerEffort', 'Executor · Grok 4.7 · raciocínio'); this.field(fields, 'context', 'Contexto do executor');
    const fast = this.field(fields, 'fast', 'Fast do executor'); this.options(fast, [{ value: 'false', label: 'Desligado' }, { value: 'true', label: 'Ligado · maior consumo' }], 'false');
    this.settings.append(this.settingsSummary, fields, node('p', 'col-hint', 'O principal decide e avalia, com acesso só de leitura. O Grok pode alterar ficheiros na pasta escolhida; as autorizações nativas aparecem aqui. Até três delegações por pedido, dez minutos por tarefa e trinta minutos no total.'));
    this.thread = node('div', 'col-thread'); this.thread.setAttribute('aria-live', 'polite');
    this.approvals = node('section', 'col-approvals'); this.approvals.setAttribute('aria-label', 'Decisões pendentes da colaboração');
    this.review = node('section', 'col-review hidden');
    this.form = node('form', 'col-composer'); const label = node('label', 'sr-only', 'Pedido para o principal');
    this.prompt = node('textarea'); this.prompt.id = 'col-prompt'; this.prompt.rows = 2; this.prompt.maxLength = 60000; this.prompt.placeholder = 'Descreve o objetivo. O principal decide o que delegar…'; label.htmlFor = this.prompt.id;
    const footer = node('div', 'col-composer-footer'); this.hint = node('span', 'col-hint', 'Enter para enviar · Shift + Enter para nova linha');
    this.stop = this.button('■ Parar', async () => { await this.api(`/api/collaborations/${this.selected}/interrupt`, {}); await this.refresh(true); }, 'stop hidden');
    this.send = node('button', 'send', 'Enviar ↗'); this.send.type = 'submit'; footer.append(this.hint, this.stop, this.send); this.form.append(label, this.prompt, footer);
    this.form.addEventListener('submit', e => { e.preventDefault(); this.submit(); });
    this.prompt.addEventListener('input', () => { this.saveDraft(); this.renderButtons(); });
    this.prompt.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!this.send.disabled) this.form.requestSubmit(); } });
    this.main.append(heading, this.error,this.recover, this.settings, this.thread, this.review, this.approvals, this.form);
    this.work = node('aside', 'col-workstream'); this.work.setAttribute('aria-label', 'Trabalho delegado');
    this.root.append(this.history, this.main, this.work);
    this.controls.project.addEventListener('change', () => {
      this.saveDraft(); const p = this.getState().projectCatalog.projects.find(p => p.id === this.controls.project.value);
      if (p) this.controls.cwd.value = p.root; this.draftOwner = this.draftKey(); this.restoreDraft(); this.controls.cwd.disabled = Boolean(p);
    });
    this.controls.model.addEventListener('change', () => this.populateEfforts());
  }
  options(select, items, selected) {
    const signature = JSON.stringify(items); if (select.dataset.options !== signature) { select.replaceChildren(...items.map(i => { const o = node('option', '', i.label); o.value = i.value; return o; })); select.dataset.options = signature; }
    if (selected !== undefined) select.value = selected;
  }
  populateEfforts(value) {
    const m = this.getState()?.providers.codex.models.find(m => m.id === this.controls.model.value);
    this.options(this.controls.effort, (m?.efforts || []).map(value => ({ value, label: efforts[value] || value })), value || (m?.efforts.includes('medium') ? 'medium' : m?.defaultEffort));
  }
  draftKey() { return this.selected || 'new:' + (this.controls.project.value || 'folder'); }
  saveDraft() { try { sessionStorage.setItem('hydraq.col.draft.' + (this.draftOwner || this.draftKey()), this.prompt.value); } catch {} }
  restoreDraft() { try { this.prompt.value = sessionStorage.getItem('hydraq.col.draft.' + this.draftKey()) || ''; } catch { this.prompt.value = ''; } }
  choose(id) {
    this.saveDraft(); this.selected = id; this.detail = null; this.owner = null; this.pendingSend = null; this.signature = this.workSignature = this.approvalSignature = '';
    if(id){this.thread.replaceChildren(node('p','col-hint','A abrir colaboração…'));this.work.replaceChildren();}
    if (id) localStorage.setItem('hydraq.collaboration', id); else localStorage.removeItem('hydraq.collaboration');
    this.settings.open = !id; this.draftOwner = id || 'new:' + (this.controls.project.value || 'folder'); this.restoreDraft(); this.render(); if (id) this.refresh(true);
  }
  render() {
    const state = this.getState(); if (!state) return;
    const visible = this.view === 'collaboration';
    this.root.classList.toggle('hidden', !visible);
    document.querySelector('#tab-collaboration').setAttribute('aria-selected', String(visible)); document.querySelector('#tab-conversations').setAttribute('aria-selected', String(!visible));
    if (!visible) return;
    document.querySelector('#chat-workspace').classList.add('hidden'); document.querySelector('#project-overview').classList.add('hidden');
    document.querySelector('#project-name').textContent = 'Colaboração';
    const catalog = state.collaboration;
    if (this.selected && !catalog?.sessions.some(s => s.id === this.selected) && this.detail?.id!==this.selected) { this.selected = null; this.detail = null; this.owner = null; }
    const listSig = JSON.stringify(catalog?.sessions || []);
    if (this.listSignature !== listSig + this.selected) {
      this.listSignature = listSig + this.selected;
      this.list.replaceChildren(...(catalog?.sessions || []).map(s => {
        const b = this.button('', () => this.choose(s.id), 'col-session' + (s.id === this.selected ? ' selected' : ''));
        b.append(node('strong', '', s.title), node('small', '', `${statuses[s.status] || s.status} · ${state.projectCatalog.projects.find(p => p.id === s.projectId)?.name || s.cwd.split('/').at(-1)}`)); return b;
      }));
    }
    const d = this.detail;
    if(!this.selected&&((!this.controls.model.options.length&&state.providers.codex?.models?.length)||(!this.controls.workerEffort.options.length&&state.providers.cursor?.models?.some(m=>m.id==='grok-4.7'))))this.owner=null;
    if (this.owner !== (this.selected || 'new') && (!this.selected || d)) {
      this.owner = this.selected || 'new';
      const models = state.providers.codex?.models || [], worker = state.providers.cursor?.models?.find(m => m.id === 'grok-4.7');
      const pm = d?.principal.model || (models.some(m => m.id === 'gpt-6.1-sol') ? 'gpt-6.1-sol' : models.find(m => m.isDefault)?.id);
      this.options(this.controls.model, models.map(m => ({ value: m.id, label: m.name })), pm); this.populateEfforts(d?.principal.effort);
      this.options(this.controls.workerEffort, (worker?.efforts || []).map(value => ({ value, label: efforts[value] || value })), d?.executor.effort || (worker?.efforts.includes('low') ? 'low' : worker?.defaultEffort));
      this.options(this.controls.context, (worker?.contexts || []).map(value => ({ value, label: value.toUpperCase() })), d?.executor.context || worker?.defaultContext);
      this.controls.fast.value = String(d?.executor.fast || false); this.controls.fast.disabled = !worker?.supportsFast;
      const projects = state.projectCatalog?.projects.filter(p => !p.archived) || [];
      this.options(this.controls.project, [{ value: '', label: 'Outra pasta…' }, ...projects.map(p => ({ value: p.id, label: p.name }))], d?.projectId || '');
      this.controls.cwd.value = d?.cwd || state.defaultCwd || ''; this.controls.project.disabled = Boolean(d); this.controls.cwd.disabled = Boolean(d?.projectId || d);
      this.draftOwner = this.draftKey(); this.restoreDraft();
    }
    // Catalogues can arrive after the first bootstrap, before the user configures a new session.
    if (!this.selected && !this.controls.model.options.length && state.providers.codex?.models?.length) this.owner = null;
    if(!this.selected&&!this.controls.workerEffort.options.length&&state.providers.cursor?.models?.some(m=>m.id==='grok-4.7'))this.owner=null;
    const selectedSummary = catalog?.sessions.find(s => s.id === this.selected);
    this.badge.textContent = d?.approvals.length?'Aguarda a tua decisão':statuses[selectedSummary?.status || 'idle']; this.badge.dataset.status = selectedSummary?.status || 'idle';
    this.error.textContent = catalog?.error || d?.error || ''; this.error.classList.toggle('hidden', !this.error.textContent);
    this.recover.classList.toggle('hidden',!catalog?.recoverable);
    this.renderButtons();
    if (!this.selected) { this.thread.replaceChildren(node('div', 'col-welcome', 'Define o objetivo com o principal. Ele pode planear, delegar trabalho no Grok e avaliar o resultado nesta mesma conversa.')); this.work.replaceChildren(node('h2', '', 'Executor'), node('p', 'col-hint', 'As tarefas delegadas, autorizações e resultados aparecem aqui.')); }
    else if (!this.detail || this.detail.status!==selectedSummary?.status || this.detail.updatedAt !== selectedSummary?.updatedAt || active.has(selectedSummary?.status)) this.refresh();
  }
  renderButtons() {
    const state = this.getState(), summary = state?.collaboration?.sessions.find(s => s.id === this.selected), ownBusy = active.has(this.detail?.status) || active.has(summary?.status);
    const busy = state?.collaboration?.busy || state?.handoff || state?.conversations.some(c => ['starting', 'running', 'waiting'].includes(c.status));
    this.send.disabled = !state || !this.prompt.value.trim() || this.sending || busy || ownBusy || state.collaboration?.error || this.detail?.status === 'uncertain' || !this.controls.model.value || !this.controls.workerEffort.value;
    this.send.textContent = this.sending ? 'A enviar…' : 'Enviar ↗'; this.stop.classList.toggle('hidden', !ownBusy);
    for (const k of ['model', 'effort', 'workerEffort', 'context']) this.controls[k].disabled = Boolean(ownBusy || this.sending);
    this.controls.fast.disabled = Boolean(ownBusy || this.sending || !state?.providers.cursor?.models.find(m => m.id === 'grok-4.7')?.supportsFast);
    this.hint.textContent = ownBusy ? 'Podes preparar o próximo pedido. Parar interrompe o ciclo.' : 'Enter para enviar · Shift + Enter para nova linha';
  }
  async refresh(force = false) {
    if(this.loading){if(force)this.pendingRefresh=true;return;}
    if (!this.selected || (this.view !== 'collaboration' && !force) || (!force && Date.now() - (this.loadedAt || 0) < 800)) return;
    this.loading = true; const id = this.selected;
    try { const d = await this.api(`/api/collaborations/${id}`); if (id !== this.selected) return; this.detail = d; this.loadedAt = Date.now(); this.renderDetail(); this.render(); }
    catch (e) { if (force) this.toast(e.message); }
    finally { this.loading = false;if(this.pendingRefresh){this.pendingRefresh=false;this.refresh(true);} }
  }
  renderDetail() {
    const d = this.detail; if (!d) return;
    const sig = JSON.stringify(d.messages);
    if (this.signature !== sig) {
      const nearBottom = this.thread.scrollHeight - this.thread.scrollTop - this.thread.clientHeight < 90; this.signature = sig;
      this.thread.replaceChildren();
      if (d.messagesOmitted) this.thread.append(node('p', 'col-hint', `Mostradas as últimas 80 mensagens; ${d.messagesOmitted} anteriores conservadas no histórico local.`));
      for (const m of d.messages) {
        if (m.role === 'user' && m.internal) continue;
        const card = node('article', 'col-message ' + m.role); card.append(node('small', '', m.role === 'user' ? 'Tu' : `${m.model || d.principal.model} · Principal`), this.markdown(m.text)); this.thread.append(card);
      }
      if (nearBottom||this.scrollToEnd) this.thread.scrollTop = this.thread.scrollHeight;this.scrollToEnd=false;
    }
    const wsig = JSON.stringify([d.jobs, d.executorState?.items,d.principalState?.usage]);
    if (this.workSignature !== wsig) {
      this.workSignature = wsig; this.work.replaceChildren(node('h2', '', 'Trabalho do Grok'));
      const usage=d.principalState?.usage;if(usage){const f=n=>new Intl.NumberFormat('pt-PT').format(n||0);this.work.append(node('p','col-hint',`Último turno do principal: ${f(usage.inputTokens)} tokens de entrada · ${f(usage.cachedInputTokens)} em cache · ${f(usage.outputTokens)} de saída.`));}
      this.work.append(node('p','col-hint','O executor não comunica contadores de consumo. A poupança de quota depende da tarefa.'));
      if (!d.jobs.length) this.work.append(node('p', 'col-hint', 'O principal ainda não delegou nenhuma tarefa.'));
      for (const j of [...d.jobs].reverse()) {
        const card = node('details', 'col-job'); if (j===d.jobs.at(-1)||['queued', 'running', 'uncertain'].includes(j.status)) card.open = true;
        card.append(node('summary', '', `${statuses[j.status] || j.status} · ${{ implement: 'Implementar', explore: 'Investigar', test: 'Testar' }[j.task] || j.task}`));
        card.append(node('p', 'col-job-instructions', j.instructions));
        if (j.error) card.append(node('p', 'col-job-error', j.error));
        if (j.result || j.partial) card.append(this.markdown(j.result || j.partial));
        if (j.resultTruncated) card.append(node('p', 'col-hint', 'Relatório limitado a 60 000 caracteres; original conservado na sessão nativa.'));
        if (j.facts) card.append(node('p', 'col-hint', `Ficheiros observados: ${j.facts.files?.join(', ') || 'nenhum'}`));
        const actions = j.requestId===d.executorState?.requestId?(d.executorState?.items || []).filter(i => i.turnId === d.executorState.turnId && i.type !== 'reasoning'):[];
        if (j === d.jobs.at(-1)) for (const i of actions.slice(-12)) {
          const item = node('details', 'col-action'); item.append(node('summary', '', `${i.status || ''} · ${i.command || i.tool || i.type}`));
          if (i.aggregatedOutput) item.append(node('pre', '', i.aggregatedOutput));
          if (i.changes?.length) item.append(node('pre', '', i.changes.map(c => `${c.path}\n${c.diff || ''}`).join('\n'))); card.append(item);
        }
        this.work.append(card);
      }
    }
    this.review.classList.toggle('hidden', d.status !== 'uncertain'); this.review.replaceChildren();
    if (d.status === 'uncertain') {
      const label = node('label'), check = node('input'); check.type = 'checkbox'; label.append(check, document.createTextNode('Revi os ficheiros e resultados parciais. Quero permitir um novo pedido, sem repetir tarefas automaticamente.'));
      const b = this.button('Confirmar revisão do estado', async () => { await this.api(`/api/collaborations/${d.id}/acknowledge`, {}); await this.refresh(true); }); b.disabled = true; check.addEventListener('change', () => { b.disabled = !check.checked; }); this.review.append(label, b);
    }
    this.renderApprovals(d); this.renderButtons();
  }
  renderApprovals(d) {
    const approvalItem=r=>(r.role==='executor'?d.executorState:d.principalState)?.items.find(i=>(!r.params.turnId||i.turnId===r.params.turnId)&&((r.params.toolCall?.toolCallId&&i.nativeId===r.params.toolCall.toolCallId)||(r.params.itemId&&i.id===r.params.itemId)));
    const signature = JSON.stringify(d.approvals.map(r=>[r,approvalItem(r)])); if (signature === this.approvalSignature) return; this.approvalSignature = signature; this.approvals.replaceChildren();
    for (const r of d.approvals) {
      const card = node('section', 'approval'); const respond = body => this.api(`/api/collaborations/${d.id}/respond`, { id: r.id, ...body });
      card.append(node('h3', '', `${r.role === 'executor' ? 'Grok' : 'Principal'} · decisão pendente`));
      if (r.method === 'session/request_permission') {
        card.append(node('pre', '', r.params.toolCall?.title || 'Ferramenta do Cursor'));
        const tool = r.params.toolCall,item=approvalItem(r),input=tool?.rawInput||item?.parameters; if (input) card.append(node('pre', '', typeof input==='string'?input:JSON.stringify(input, null, 2)));
        const locations=tool?.locations||item?.locations;if(locations?.length)card.append(node('p','',`Caminhos: ${locations.map(l=>l.path).join(', ')}`));
        for (const block of tool?.content || []) if (block.type === 'diff') card.append(node('pre', '', `${block.path}\nAntes:\n${block.oldText || ''}\nDepois:\n${block.newText || ''}`));
        if(!(tool?.content||[]).some(b=>b.type==='diff')&&item?.changes?.length)card.append(node('pre','',item.changes.map(c=>`${c.path}\n${c.diff||''}`).join('\n')));
        for (const o of r.params.options || []) card.append(this.button(({ allow_once: 'Permitir desta vez', allow_always: 'Permitir sempre', reject_once: 'Recusar', reject_always: 'Recusar sempre' })[o.kind] || o.name, async () => { await respond({ optionId: o.optionId }); this.approvalSignature = ''; await this.refresh(true); }));
      } else if (r.method.endsWith('/requestApproval')) {
        card.append(node('pre', '', r.params.command || JSON.stringify(r.params.fileChanges || r.params.changes || {}, null, 2)));
        for (const decision of ['accept', 'decline']) card.append(this.button(decision === 'accept' ? 'Permitir' : 'Recusar', () => respond({ decision })));
      } else if (r.method === 'cursor/ask_question') {
        const fields = r.params.questions.map(q => { const l = node('label', '', q.prompt), select = node('select'); for (const o of q.options) { const option = node('option', '', o.label || o.name || o.id); option.value = o.id; select.append(option); } select.multiple = Boolean(q.allowMultiple); l.append(select); card.append(l); return { q, select }; });
        card.append(this.button('Responder', () => respond({ answers: fields.map(({ q, select }) => ({ questionId: q.id, selectedOptionIds: [...select.selectedOptions].map(o => o.value) })) })));
      } else if (r.method === 'cursor/create_plan') {
        const plan=r.params.plan||r.params.content||r.params.title||r.params;card.append(node('pre', '', typeof plan==='string'?plan:JSON.stringify(plan,null,2)));
        card.append(this.button('Aceitar plano', () => respond({ decision: 'accept' })), this.button('Recusar', () => respond({ decision: 'decline' })));
      } else if (r.method === 'tool/requestUserInput') {
        const fields = (r.params.questions || []).map(q => { const l = node('label', '', q.question || q.header), input = node('input'); l.append(input); card.append(l); return { q, input }; });
        card.append(this.button('Responder', () => respond({ answers: Object.fromEntries(fields.map(({ q, input }) => [q.id, input.value])) })));
      } else {
        card.append(node('p', '', r.params.message || 'Confirma o pedido.')); const form = elicitationForm(r.params.requestedSchema); card.append(form.container);
        card.append(this.button('Confirmar', () => respond({ action: 'accept', content: form.read() })), this.button('Recusar', () => respond({ action: 'decline' })));
      }
      this.approvals.append(card);
    }
  }
  settingsBody() { return { principal: { model: this.controls.model.value, effort: this.controls.effort.value }, executor: { model: 'grok-4.7', effort: this.controls.workerEffort.value, context: this.controls.context.value || null, fast: this.controls.fast.value === 'true' } }; }
  async submit() {
    if (this.send.disabled || this.sending) return;
    const text = this.prompt.value.trim(); this.sending = true; this.renderButtons();
    this.scrollToEnd=true;
    try {
      const settings = this.settingsBody();
      if (!this.selected) {
        const body = { ...settings, projectId: this.controls.project.value || null, cwd: this.controls.cwd.value };
        const signature = JSON.stringify(body); if (this.pendingCreate?.signature !== signature) this.pendingCreate = { signature, key: crypto.randomUUID() };
        this.originDraftKey=this.draftOwner;
        const c = await this.api('/api/collaborations', { ...body, requestId: this.pendingCreate.key }); this.selected = c.id; this.detail = c; this.owner = c.id; localStorage.setItem('hydraq.collaboration', c.id); this.settings.open = false;this.controls.project.disabled=this.controls.cwd.disabled=true;
      }
      if (!this.pendingSend || this.pendingSend.text !== text || this.pendingSend.id !== this.selected) this.pendingSend = { id: this.selected, text, key: crypto.randomUUID() };
      await this.api(`/api/collaborations/${this.selected}/send`, { text, requestId: this.pendingSend.key, ...settings });
      this.pendingSend = null; if (this.prompt.value.trim() === text) this.prompt.value = '';
      try{if(this.originDraftKey&&sessionStorage.getItem('hydraq.col.draft.'+this.originDraftKey)?.trim()===text)sessionStorage.removeItem('hydraq.col.draft.'+this.originDraftKey);}catch{}
      this.originDraftKey=null;this.draftOwner = this.selected; this.saveDraft(); await this.refresh(true);
    } catch (e) { this.toast(e.message); }
    finally { this.sending = false; this.renderButtons(); }
  }
}
