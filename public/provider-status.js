import { selectedQuotas, quotaWindowOrder } from './quota-windows.js';
export { selectedQuotas } from './quota-windows.js';

const names = { codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity', cursor: 'Cursor', opencode: 'OpenCode' };
const tracked = ['codex', 'claude', 'antigravity'];
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
const numeric = n => typeof n === 'number' && Number.isFinite(n);
const pct = n => numeric(n) ? `${Math.round(n * 10) / 10}%` : '—';
const time = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'por confirmar'; };
export function resetLabel(value, now = Date.now()) {
  const delta = Date.parse(value) - now;
  if (!value || !Number.isFinite(delta)) return 'Reposição não comunicada';
  if (delta <= 0) return 'Aguarda reposição';
  const minutes = Math.ceil(delta / 60_000), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  return `Repõe em ${days ? `${days}d${hours ? ` ${hours}h` : ''}` : hours ? `${hours}h${mins ? ` ${mins}m` : ''}` : `${mins}m`}`;
}
const age = (value, now) => { const mins = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000)); return !value || !Number.isFinite(mins) ? 'Por consultar' : mins < 1 ? 'Atualizado agora' : mins < 60 ? `Há ${mins} min` : `Há ${Math.floor(mins / 60)} h`; };

export class ProviderStatus {
  constructor({ root, api, getState, getProvider, getSelections, accept, render, toast, now = Date.now }) {
    Object.assign(this, { root, api, getState, getProvider, getSelections, accept, renderApp: render, toast, now });
    this.busy = new Set(); this.openModels = new Set(); this.openCards = new Set();
    // Existing tabs can still have the previous details element when new scripts arrive.
    if (root.tagName === 'DETAILS') { const section = el('section', root.className); section.id = root.id; root.replaceWith(section); this.root = section; }
    this.root.setAttribute('aria-label', 'Limites dos modelos selecionados');
    this.active = el('div', 'quota-selected');
    this.details = el('details', 'quota-browser');
    this.summary = el('summary', '', 'Todos os clientes e modelos'); this.body = el('div', 'provider-status-body');
    this.details.append(this.summary, this.body); this.root.replaceChildren(this.active, this.details);
    this.timer = setInterval(() => this.render(), 60_000);
  }
  render() {
    const providers = this.getState()?.providers || {}, now = this.now();
    const selections = (this.getSelections?.() || [{ provider: this.getProvider(), model: null }]).filter(s => s.provider);
    const signature = JSON.stringify([selections, Math.floor(now / 60_000), ...Object.keys(names).map(id => [providers[id]?.models, providers[id]?.catalog, providers[id]?.quotas, providers[id]?.connection, this.busy.has(id)])]);
    if (signature === this.signature) return; this.signature = signature;
    const focused = document.activeElement?.dataset.quotaRefresh;
    this.active.replaceChildren(); this.body.replaceChildren();
    for (const selection of selections) {
      const provider = providers[selection.provider] || {}, model = provider.models?.find(m => m.id === selection.model);
      const match = selectedQuotas(selection.provider, selection.model, provider.quotas?.windows, model);
      this.active.append(this.selectedCard(selection, provider, model, match, now));
    }
    for (const id of tracked) if (providers[id]) this.body.append(this.providerCard(id, providers[id], now));
    this.summary.replaceChildren(el('span', '', 'Todos os clientes e modelos'), el('span', 'quota-browser-count', `${tracked.filter(id => providers[id]).length} clientes`));
    if (focused) this.root.querySelector(`[data-quota-refresh="${focused}"]`)?.focus({ preventScroll: true });
  }
  refreshButton(id, provider, compact = false) {
    const working = this.busy.has(id) || provider.catalog?.refreshing;
    const button = el('button', compact ? 'quota-refresh' : 'text-button', working ? '↻' : compact ? '↻' : '↻ Atualizar'); button.type = 'button';
    button.dataset.quotaRefresh = compact ? `${id}-selected` : id; button.dataset.loading = String(Boolean(working));
    button.setAttribute('aria-label', `Atualizar modelos e quotas do ${names[id]}`); button.title = working ? 'A atualizar…' : 'Atualizar agora';
    button.disabled = working || provider.connection !== 'connected'; button.addEventListener('click', () => this.refresh(id)); return button;
  }
  selectedCard(selection, provider, model, match, now) {
    const id = selection.provider, quotas = provider.quotas, card = el('section', 'quota-selected-card'); card.dataset.provider = id; card.dataset.model = selection.model || '';
    const head = el('div', 'quota-selected-head'), identity = el('div', 'quota-selected-identity');
    const eyebrow = el('div', 'quota-selected-provider'); eyebrow.append(el('span', 'quota-client-dot'), document.createTextNode(names[id] || id));
    if (selection.mode) eyebrow.append(el('span', 'quota-mode', selection.mode));
    identity.append(eyebrow, el('h3', '', model?.name || selection.model || 'Escolhe um modelo'));
    if (selection.effort) identity.append(el('span', 'quota-effort', `Raciocínio · ${selection.effort}`));
    head.append(identity); if (tracked.includes(id)) head.append(this.refreshButton(id, provider, true)); card.append(head);
    card.append(el('p', 'quota-scope', match.scope));
    const grid = el('div', 'quota-metrics');
    const multipleGroups = new Set(match.windows.map(w => w.group)).size > 1;
    for (const quota of match.windows) {
      const metric = this.window(quota, id, now, true, Boolean(quotas?.stale || quotas?.error || provider.connection !== 'connected'));
      if (multipleGroups) metric.prepend(el('small', 'quota-bucket', quota.group));
      grid.append(metric);
    }
    if (match.windows.length) card.append(grid);
    else card.append(el('p', 'quota-empty', match.unmapped ? 'Consulta os grupos em «Todos os clientes e modelos».' : !tracked.includes(id) ? 'Sem quotas comunicadas por este cliente.' : quotas?.refreshing ? 'A consultar os limites…' : 'Limites por confirmar. Atualiza para consultar.'));
    const footer = el('div', 'quota-selected-footer');
    const stale = quotas?.stale || quotas?.error || provider.connection !== 'connected';
    footer.append(el('span', stale ? 'quota-freshness is-stale' : 'quota-freshness', provider.connection !== 'connected' ? 'Cliente desligado' : quotas?.error ? 'Consulta falhou · dados anteriores' : stale ? 'Dados por atualizar' : age(quotas?.checkedAt, now)));
    if (quotas?.checkedAt) footer.title = `Última consulta: ${time(quotas.checkedAt)} · atualização automática a cada 2 minutos`;
    card.append(footer); return card;
  }
  window(quota, id, now, compact, stale = false) {
    const row = el('div', compact ? 'quota-window quota-metric' : 'quota-window'); row.dataset.window = quota.id;
    const remaining = quota.remainingPercent, blocked = quota.status === 'rejected' || remaining === 0;
    row.dataset.level = blocked ? 'empty' : numeric(remaining) && remaining <= 15 ? 'low' : 'normal';
    row.dataset.stale = String(Boolean(stale || quota.stale));
    const heading = el('div', 'quota-window-title'); heading.append(el('span', '', quota.windowDurationMins === 300 ? '5 horas' : quota.label));
    const value = el('div', 'quota-value'); value.append(el('strong', '', pct(remaining)), el('span', '', numeric(remaining) ? ' livre' : ' não comunicado'));
    if (compact) row.append(heading, value); else { heading.append(value); row.append(heading); }
    if (numeric(remaining)) {
      const bar = el('progress'); bar.max = 100; bar.value = remaining;
      bar.setAttribute('aria-label', `${names[id]} · ${quota.group} · ${quota.label}: ${pct(remaining)} livre`); row.append(bar);
    }
    if (blocked || row.dataset.level === 'low') row.append(el('span', 'quota-warning', blocked ? 'Limite atingido' : 'Pouca quota'));
    if (row.dataset.stale === 'true') row.append(el('small', 'quota-old', 'Valor anterior'));
    const reset = el('small', 'quota-reset', resetLabel(quota.resetsAt, now)); reset.title = quota.resetsAt ? `Reposição prevista: ${time(quota.resetsAt)}` : 'O cliente não indicou a hora de reposição'; row.append(reset);
    if (quota.resetsAt) { const absolute = el('time', 'quota-reset-date', time(quota.resetsAt)); absolute.dateTime = quota.resetsAt; row.append(absolute); }
    return row;
  }
  providerCard(id, provider, now) {
    const card = el('section', 'provider-quota-card'); card.dataset.provider = id;
    const head = el('div', 'provider-quota-head'), title = el('h4', ''); title.append(el('span', 'quota-client-dot'), document.createTextNode(names[id]));
    head.append(title, this.refreshButton(id, provider)); card.append(head);
    const catalog = provider.catalog, quotas = provider.quotas, modelInfo = el('details', 'provider-models'); modelInfo.open = this.openCards.has(id);
    modelInfo.addEventListener('toggle', () => modelInfo.open ? this.openCards.add(id) : this.openCards.delete(id));
    modelInfo.append(el('summary', '', `${provider.models?.length || 0} modelos disponíveis`));
    modelInfo.append(el('p', 'provider-status-note', catalog?.error || (catalog?.stale ? 'Catálogo anterior; aguarda nova confirmação.' : `Verificado ${time(catalog?.checkedAt)} · atualização a cada 6 horas.`)));
    for (const model of provider.models || []) {
      const detail = el('details', 'provider-model-detail'), key = `${id}:${model.id}`; detail.open = this.openModels.has(key);
      detail.addEventListener('toggle', () => detail.open ? this.openModels.add(key) : this.openModels.delete(key));
      detail.append(el('summary', '', (model.name || model.id) + (model.isDefault ? ' · predefinido' : '')), el('p', '', model.description || model.id), el('p', '', `Raciocínio: ${(model.efforts || []).join(' · ') || 'não comunicado'}${model.defaultEffort ? ` · predefinido: ${model.defaultEffort}` : ''}`));
      const modalities = model.inputModalities || model.metadata?.inputModalities;
      if (modalities?.length) detail.append(el('p', '', 'Entrada: ' + modalities.map(m => ({ text: 'texto', image: 'imagens' }[m] || m)).join(' · ')));
      if (model.contextWindow) detail.append(el('p', '', `Contexto: ${Number(model.contextWindow).toLocaleString('pt-PT')} tokens`)); modelInfo.append(detail);
    }
    card.append(modelInfo);
    if (provider.connection !== 'connected') card.append(el('p', 'provider-status-note', 'Cliente desligado. Os valores anteriores podem estar desatualizados.'));
    if (quotas?.error) card.append(el('p', 'provider-status-note', quotas.error));
    if (!quotas?.windows?.length) card.append(el('p', 'provider-status-note', 'Quotas não disponíveis nesta consulta.'));
    let group;
    for (const quota of (quotas?.windows || []).slice().sort((a, b) => a.group.localeCompare(b.group) || quotaWindowOrder(a, b))) {
      if (quota.group !== group) { group = quota.group; card.append(el('h5', '', group)); }
      card.append(this.window(quota, id, now, false, Boolean(quotas.stale || quotas.error || provider.connection !== 'connected')));
    }
    if (quotas?.checkedAt) card.append(el('p', 'provider-status-note', `Quotas: ${time(quotas.checkedAt)}${quotas.stale ? ' · valores anteriores' : ''}`)); return card;
  }
  async refresh(id) {
    if (this.busy.has(id)) return;
    this.busy.add(id); this.render();
    try { this.accept(await this.api('/api/providers/refresh', { provider: id })); this.renderApp(); }
    catch (error) { this.toast(error.message); }
    finally { this.busy.delete(id); this.render(); }
  }
}
