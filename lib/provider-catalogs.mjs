const MODEL_INTERVAL = 6 * 60 * 60_000, QUOTA_INTERVAL = 2 * 60_000;
const percent = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
const date = n => {
  const ms = typeof n === 'number' ? n * 1000 : typeof n === 'string' ? Date.parse(n) : NaN;
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null;
};
const label = s => typeof s === 'string' ? s.slice(0, 160) : '';
const windowLabel = mins => mins === 300 ? '5 horas' : mins === 10080 ? 'Semanal' : mins ? `${mins} minutos` : 'Limite';
function window(id, group, name, used, reset, mins = null, status = null) {
  const usedPercent = percent(used);
  return { id, group: label(group), label: label(name), usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent,
    resetsAt: date(reset), windowDurationMins: mins, status: ['allowed', 'allowed_warning', 'rejected'].includes(status) ? status : null };
}

// Keep only quota fields. Native responses may also contain billing, account and behavior data.
export function quotaWindows(provider, data) {
  if (provider === 'codex') {
    const buckets = data?.rateLimitsByLimitId && Object.keys(data.rateLimitsByLimitId).length
      ? Object.entries(data.rateLimitsByLimitId) : data?.rateLimits ? [[data.rateLimits.limitId || 'codex', data.rateLimits]] : [];
    return buckets.flatMap(([id, bucket]) => ['primary', 'secondary'].flatMap(key => {
      const value = bucket?.[key]; if (!value || typeof value !== 'object') return [];
      const mins = Number.isFinite(value.windowDurationMins) && value.windowDurationMins > 0 ? value.windowDurationMins : null;
      return [window(`${id}:${key}`, bucket.limitName || id, windowLabel(mins), value.usedPercent, value.resetsAt, mins)];
    }));
  }
  if (provider === 'claude') {
    const names = { five_hour: '5 horas', seven_day: 'Semanal', seven_day_opus: 'Semanal · Opus', seven_day_sonnet: 'Semanal · Sonnet', seven_day_oauth_apps: 'Semanal · aplicações OAuth', seven_day_overage_included: 'Semanal · modelos incluídos' };
    if (data?.nativeEvent) {
      const info = data.nativeEvent;
      const values = info.unifiedWindows || (info.rateLimitType ? { [info.rateLimitType]: info } : {});
      return Object.entries(values).filter(([key]) => names[key]).map(([key, v]) => window(key, 'Claude', names[key],
        typeof v.utilization === 'number' ? v.utilization * 100 : null, v.resetsAt, key === 'five_hour' ? 300 : 10080, v.status || info.status));
    }
    if (data?.rate_limits_available !== true) return [];
    const limits = data.rate_limits || {};
    return Object.entries(names).filter(([key]) => limits[key] && typeof limits[key] === 'object').map(([key, name]) =>
      window(key, 'Claude', name, limits[key].utilization, limits[key].resets_at, key === 'five_hour' ? 300 : 10080));
  }
  if (provider === 'antigravity') return (Array.isArray(data?.groups) ? data.groups : []).flatMap((group, i) =>
    (Array.isArray(group.buckets) ? group.buckets : []).map((bucket, j) => {
      const mins = bucket.window === '5h' ? 300 : bucket.window === 'weekly' ? 10080 : null;
      const remaining = typeof bucket.remaining_fraction === 'number' ? percent(bucket.remaining_fraction * 100) : null;
      return window(label(bucket.id) || `${i}:${j}`, group.name, mins ? windowLabel(mins) : bucket.name,
        remaining === null ? null : 100 - remaining, bucket.reset_time, mins);
    }));
  return [];
}

/** Shared read-only polling. Catalog failures never disconnect clients or change selected models. */
export class ProviderCatalogs {
  constructor(clients, changed, clock = Date.now) {
    Object.assign(this, { clients, changed, clock }); this.records = new Map(); this.pending = new Map(); this.quotaRevisions = new Map(); this.stopped = false;
    for (const [id, client] of Object.entries(clients)) if (['codex', 'claude', 'antigravity'].includes(id)) {
      this.records.set(id, { catalog: { checkedAt: null, attemptedAt: null, error: null }, quotas: { checkedAt: null, attemptedAt: null, error: null, windows: [], status: 'unavailable' } });
      client.on('quotas', data => this.receive(id, data));
    }
  }
  state(id) {
    const record = this.records.get(id); if (!record) return {};
    const disconnected = this.clients[id].connection !== 'connected';
    const staleWindow = w => Boolean(w.checkedAt && this.clock() - Date.parse(w.checkedAt) > QUOTA_INTERVAL + 60_000);
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, { ...value,
      ...(key === 'quotas' ? { windows: value.windows.map(w => ({ ...w, stale: disconnected || staleWindow(w) })) } : {}),
      refreshing: this.pending.has(id), refreshIntervalMs: key === 'catalog' ? MODEL_INTERVAL : QUOTA_INTERVAL,
      stale: Boolean(value.checkedAt && (disconnected || value.error || (key === 'quotas' && value.windows.some(staleWindow)) || this.clock() - Date.parse(value.checkedAt) > (key === 'catalog' ? MODEL_INTERVAL : QUOTA_INTERVAL) + 60_000)),
    }]));
  }
  connected(id) {
    const record = this.records.get(id);
    if (record) record.catalog = { checkedAt: new Date(this.clock()).toISOString(), attemptedAt: new Date(this.clock()).toISOString(), error: null };
    if (!this.timer && !this.stopped) { this.timer = setInterval(() => { for (const id of this.records.keys()) this.refresh(id).catch(() => {}); }, 30_000); this.timer.unref(); }
  }
  receive(id, data) {
    if (this.stopped) return;
    const record = this.records.get(id); if (!record) return;
    this.quotaRevisions.set(id, (this.quotaRevisions.get(id) || 0) + 1);
    let windows = quotaWindows(id, data);
    // A notification can cover just one bucket; retain the other buckets with their original timestamps.
    if (data?.nativeEvent || (id === 'codex' && !data.rateLimitsByLimitId && data.rateLimits)) {
      const previous = new Map(record.quotas.windows.map(w => [w.id, w]));
      windows = windows.map(w => {
        const old = previous.get(w.id);
        return w.usedPercent === null && old && (!w.resetsAt || w.resetsAt === old.resetsAt)
          ? { ...w, usedPercent: old.usedPercent, remainingPercent: old.remainingPercent, resetsAt: w.resetsAt || old.resetsAt, checkedAt: old.checkedAt } : w;
      });
      const updates = new Set(windows.map(w => w.id));
      windows = [...record.quotas.windows.filter(w => !updates.has(w.id)), ...windows];
    }
    const checkedAt = new Date(this.clock()).toISOString();
    record.quotas = { checkedAt, attemptedAt: checkedAt, error: null, status: windows.length ? 'ready' : 'unavailable',
      windows: windows.map(w => ({ ...w, checkedAt: w.checkedAt || checkedAt })) };
    this.changed();
  }
  refresh(id, { force = false } = {}) {
    if (!this.records.has(id)) throw Error('A atualização automática está disponível para Codex, Claude Code e Antigravity.');
    if (this.pending.has(id)) return this.pending.get(id);
    if (this.stopped || this.clients[id].connection !== 'connected') return Promise.resolve();
    const record = this.records.get(id), at = this.clock();
    if (![['catalog', MODEL_INTERVAL], ['quotas', QUOTA_INTERVAL]].some(([key, interval]) => !record[key].attemptedAt || at - Date.parse(record[key].attemptedAt) >= (force ? 10_000 : interval))) return Promise.resolve();
    const task = this.#refresh(id, force).finally(() => { this.pending.delete(id); if (!this.stopped) this.changed(); });
    this.pending.set(id, task); this.changed(); return task;
  }
  async #refresh(id, force) {
    const client = this.clients[id], record = this.records.get(id), at = this.clock();
    const tasks = [['catalog', MODEL_INTERVAL, () => client.refreshCatalog?.()], ['quotas', QUOTA_INTERVAL, () => client.readQuotas?.()]];
    await Promise.all(tasks.map(async ([key, interval, read]) => {
      const old = record[key], elapsed = at - Date.parse(old.attemptedAt || 0);
      if (old.attemptedAt && elapsed < (force ? 10_000 : interval)) return;
      old.attemptedAt = new Date(at).toISOString();
      const revision = this.quotaRevisions.get(id) || 0;
      try {
        const result = await read(); if (this.stopped) return;
        if (key === 'quotas') {
          if ((this.quotaRevisions.get(id) || 0) !== revision) return;
          // A full read replaces the snapshot, including buckets that have disappeared.
          const windows = quotaWindows(id, result), checkedAt = new Date(this.clock()).toISOString();
          record.quotas = { checkedAt, attemptedAt: old.attemptedAt, error: null, windows: windows.map(w => ({ ...w, checkedAt })), status: windows.length ? 'ready' : 'unavailable' };
        } else record.catalog = { checkedAt: new Date(this.clock()).toISOString(), attemptedAt: old.attemptedAt, error: null };
      } catch {
        if (this.stopped || (key === 'quotas' && (this.quotaRevisions.get(id) || 0) !== revision)) return;
        record[key] = { ...old, error: key === 'catalog' ? 'Não foi possível atualizar os modelos. A última lista válida foi mantida.' : 'Não foi possível consultar as quotas no cliente original. Tenta atualizar novamente.', ...(key === 'quotas' ? { status: 'error' } : {}) };
      }
    }));
  }
  stop() { this.stopped = true; clearInterval(this.timer); }
  async settled() { await Promise.allSettled(this.pending.values()); }
}
