import { quotaWindows } from './provider-catalogs.mjs';
import { selectedQuotas } from '../public/quota-windows.js';

const tracked = new Set(['codex', 'claude', 'antigravity']);
const active = new Set(['starting', 'running', 'waiting']);
const keyOf = window => JSON.stringify([window.id, window.group, window.windowDurationMins]);
const durationSupported = window => [300, 10080].includes(window.windowDurationMins);
const CACHE_MAX_AGE_MS = 30_000;

export function compareQuotaReads(before, after, { overlap = false, at = Date.now() } = {}) {
  const initial = new Map(before.map(window => [keyOf(window), window]));
  const final = new Map(after.map(window => [keyOf(window), window]));
  const windows = [...new Map([...initial, ...final])].map(([key, window]) => {
    const first = initial.get(key), last = final.get(key);
    const from = first?.usedPercent ?? null, to = last?.usedPercent ?? null;
    const reset = first?.resetsAt, nextReset = last?.resetsAt;
    // Claude may report the same reset with slightly different milliseconds.
    const sameReset = reset && nextReset && Math.abs(Date.parse(reset) - Date.parse(nextReset)) < 1000;
    const resetChanged = reset ? !sameReset || Date.parse(reset) <= at : from > 0 && Boolean(nextReset);
    let reason = null;
    if (overlap) reason = 'overlap';
    else if (from === null || to === null) reason = 'missing';
    else if (resetChanged || to < from - 1e-8) reason = 'reset';
    const spent = reason ? null : Number(Math.max(0, to - from).toFixed(6));
    return { id: window.id, group: window.group, label: window.label, from, to, spent, reason };
  });
  return { windows, reason: windows.length ? null : overlap ? 'overlap' : 'missing' };
}

// Account counters are shared by native processes. Keep simultaneous HYDRAQ turns
// in view even when a reviewer uses a separate process for the same subscription.
export class TurnQuotas {
  constructor(clients, { clock = Date.now, enabled = () => true } = {}) {
    this.clients = clients;
    this.clock = clock;
    this.enabled = enabled;
    this.providers = new WeakMap();
    this.pending = new Map();
    this.cache = new Map();
    this.revisions = new Map();
  }

  attach(provider, client) {
    if (!tracked.has(provider) || !client.readQuotas || this.providers.has(client)) return;
    this.providers.set(client, provider);
    client.turnQuotas = this;
    client.on('quotas', () => {
      this.cache.delete(provider);
      this.revisions.set(provider, (this.revisions.get(provider) || 0) + 1);
    });
  }

  async read(source, provider) {
    if (!this.enabled(provider)) return [];
    try {
      const windows = quotaWindows(provider, await source.readQuotas(6000));
      return windows.filter(durationSupported);
    } catch {
      return [];
    }
  }

  async begin(client, turn, model) {
    if (this.stopped || turn.internal === 'claudex') return;
    const started = performance.now();
    const provider = this.providers.get(client);
    const peers = () => [...this.pending.values()].filter(entry => entry.provider === provider);
    // Finish measuring already completed turns before starting another on the same account.
    await Promise.all(peers().filter(entry => !active.has(entry.turn.status)).map(entry => this.finish(entry)));
    const previousReadWaitMs = performance.now() - started;
    if (this.stopped || !this.enabled(provider) || !active.has(turn.status)) return;
    // Claude and agy use the same credentials in their isolated reviewer processes.
    // Run their metadata command outside the reviewer's supervised inference scope.
    const source = provider === 'codex' ? client : this.clients[provider];
    const cached = this.cache.get(provider), at = this.clock();
    const selected = selectedQuotas(provider, turn.model, cached?.windows || [], model, { strict: true }).windows;
    const reusedBefore = Boolean(cached && !peers().length && cached.source === source &&
      source.connection === 'connected' && cached.account === source.account &&
      at >= cached.checkedAt && at - cached.checkedAt < CACHE_MAX_AGE_MS &&
      selected.length && selected.every(window => window.usedPercent !== null &&
        (!window.resetsAt || Date.parse(window.resetsAt) > at)));
    // A baseline is consumed once. Any overlapping turn invalidates its attribution.
    this.cache.delete(provider);
    const entry = { provider, client, turn, model, source, overlap: Boolean(turn.quotaOverlap),
      timing: { reusedBefore, previousReadWaitMs: Math.round(previousReadWaitMs) } };
    for (const peer of peers()) {
      peer.overlap = true;
      if (peer.turn.quotaScope) peer.turn.quotaOverlap = true;
      entry.overlap = true;
    }
    entry.check = () => { if (!active.has(turn.status)) void this.finish(entry); };
    this.pending.set(turn, entry);
    client.on('state', entry.check);
    if (turn.quotaScope && entry.overlap) turn.quotaOverlap = true;
    entry.before = turn.quotaBefore ? Promise.resolve(turn.quotaUncertain ? [] : turn.quotaBefore) :
      reusedBefore ? Promise.resolve(cached.windows) : this.read(source, provider);
    await entry.before;
    entry.timing.beforeMs = Math.round(performance.now() - started);
    if (turn.quotaScope && !turn.quotaBefore) turn.quotaBefore = await entry.before;
  }

  async beginTask(record, provider) {
    const client = this.clients[provider];
    if (!this.enabled(provider) || !this.providers.has(client)) return false;
    const segments = (record.quotaTurns ||= {})[provider] ||= [];
    let turn = segments.at(-1);
    if (turn && active.has(turn.status)) {
      if (this.pending.has(turn)) return false;
      // A restarted server did not observe activity during the gap.
      if (turn.quotaBefore) turn.quotaUncertain = true;
    } else {
      turn = { model: record.members[provider].model, quotaScope: record.id,
        status: 'running', delivery: 'accepted', startedAt: new Date(this.clock()).toISOString() };
      segments.push(turn);
    }
    await this.begin(client, turn, client.models?.find(model => model.id === turn.model));
    return true;
  }

  async finishTask(record, provider) {
    const providers = provider ? [provider] : Object.keys(record.quotaTurns || {});
    await Promise.all(providers.map(async role => {
      const turn = record.quotaTurns?.[role]?.at(-1);
      if (!turn || !active.has(turn.status)) return;
      if (!this.pending.has(turn)) await this.beginTask(record, role);
      turn.status = 'completed';
      turn.completedAt = new Date(this.clock()).toISOString();
      await this.settle(turn);
    }));
  }

  finish(entry) {
    return entry.task ||= (async () => {
      const { client, turn, source, provider, model } = entry;
      client.off('state', entry.check);
      try {
        if (this.stopped || turn.delivery === 'preparing') return;
        const before = await entry.before;
        if (this.stopped) return;
        const readStarted = performance.now(), revision = this.revisions.get(provider) || 0;
        const after = await this.read(source, provider);
        entry.timing.afterMs = Math.round(performance.now() - readStarted);
        if (this.stopped) return;
        const select = windows => selectedQuotas(provider, turn.model, windows, model, { strict: true }).windows;
        turn.quotaUsage = { ...compareQuotaReads(select(turn.quotaUncertain ? [] : before), select(after), { overlap: entry.overlap }),
          timing: entry.timing };
        if (this.enabled(provider) && !entry.overlap && after.length && (this.revisions.get(provider) || 0) === revision) {
          this.cache.set(provider, { source, account: source.account, windows: after, checkedAt: this.clock() });
        }
        client.changed();
      } finally {
        this.pending.delete(turn);
      }
    })();
  }

  settle(turn) {
    const entry = this.pending.get(turn);
    if (entry && !active.has(turn.status)) return this.finish(entry);
  }

  async settledFor(provider) {
    const entries = [...this.pending.values()].filter(entry => entry.provider === provider && !active.has(entry.turn.status));
    await Promise.allSettled(entries.map(entry => this.finish(entry)));
  }

  async close() {
    await Promise.all([...this.pending.values()].filter(entry => !active.has(entry.turn.status)).map(entry => this.finish(entry)));
    this.stop();
  }

  stop() {
    this.stopped = true;
    for (const entry of this.pending.values()) entry.client.off('state', entry.check);
    this.pending.clear();
    this.cache.clear();
  }
}
