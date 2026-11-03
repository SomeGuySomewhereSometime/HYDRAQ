import { mkdir, readFile, writeFile, rename, lstat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * Coordination of a dual conversation: two normal conversations of the same group, a principal and the
 * rounds sent to them. Questions and answers stay in the conversations; only routing and delivery live here.
 */
import { DUAL_KEYS, memberKeys, targetKeys } from '../public/multi-state.js';
export { DUAL_KEYS, memberKeys, targetKeys };
export const DUAL_TARGETS = ['both', 'all', ...DUAL_KEYS];
export const isReadMode = sandbox => ['read-only', 'plan', 'ask'].includes(sandbox);
export const readMode = provider => provider === 'codex' ? 'read-only' : 'plan';
export const dualRequestId = (requestId, key) => `${requestId}:${key}`;
const MAX_ROUNDS = 400;
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const now = () => new Date().toISOString();
const delivery = new Set(['preparing', 'sending', 'sent', 'failed', 'uncertain', 'cancelled']);
const MAX_CHANGES = 100;
/** Who took part in a round, kept with it: a later change of client never relabels earlier answers. */
const pair = record => Object.fromEntries(memberKeys(record).map(key => [key, { provider: record.members[key].provider, conversationId: record.members[key].conversationId }]));
const stamp = record => { for (const round of record.rounds) round.members ||= pair(record); };

function validMembers(members) {
  if (!members || typeof members !== 'object' || Array.isArray(members)) return false;
  const keys = Object.keys(members);
  return keys.length >= 2 && keys.length <= 4 && keys.every(key => DUAL_KEYS.includes(key) && typeof members[key]?.provider === 'string' && typeof members[key]?.conversationId === 'string') && new Set(keys.map(key => members[key].provider)).size === keys.length;
}
function validRecord(record) {
  try {
    return record && uuid(record.id) && typeof record.groupId === 'string' && typeof record.active === 'boolean' && validMembers(record.members) &&
      memberKeys(record).includes(record.principal) && targetKeys(record).length > 0 && Array.isArray(record.rounds) &&
      record.rounds.every(round => round && uuid(round.id) && typeof round.requestId === 'string' && Array.isArray(round.targets) && round.targets.length > 0 && new Set(round.targets).size === round.targets.length &&
        (round.members === undefined || validMembers(round.members)) && round.targets.every(key => Object.hasOwn(round.members || record.members, key) && delivery.has(round.deliveries?.[key]?.status) && typeof round.deliveries[key].conversationId === 'string')) &&
      (record.changes === undefined || Array.isArray(record.changes)) &&
      (record.synthesis === undefined || (record.synthesis && typeof record.synthesis.auto === 'boolean' && typeof record.synthesis.context === 'boolean'));
  } catch { return false; }
}

export class DualSessions {
  constructor({ directory, conversations }) {
    Object.assign(this, { directory, conversations });
    this.records = [];
    this.queue = Promise.resolve();
  }
  serial(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }

  async load() {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if ((await lstat(this.directory)).isSymbolicLink()) throw Error('Pasta do Multi inválida.');
      let saved;
      try {
        const file = path.join(this.directory, 'state.json'), info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 8_000_000) throw Error('Registo do Multi inválido.');
        saved = JSON.parse(await readFile(file, 'utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (saved && (![1, 2].includes(saved.version) || !Array.isArray(saved.records) || !saved.records.every(validRecord))) throw Error('Registo do Multi inválido; o original foi preservado.');
      this.records = saved?.records || [];
      this.fileVersion = saved?.version || 2;
      // A restart never resends: unconfirmed deliveries keep what the conversation itself recorded.
      let recovered = false;
      for (const record of this.records) for (const round of record.rounds) for (const key of round.targets) {
        const entry = round.deliveries[key];
        if (!['preparing', 'sending'].includes(entry.status)) continue;
        const turn = this.conversations().find(c => c.id === entry.conversationId)?.turns?.find(t => t.requestId === entry.requestId);
        if (turn) entry.status = 'sent';
        else if (entry.status === 'preparing') Object.assign(entry, { status: 'failed', error: 'O HYDRAQ reiniciou antes do envio. Nada foi enviado.' });
        else Object.assign(entry, { status: 'uncertain', error: 'O HYDRAQ reiniciou sem confirmar este envio. Nada foi reenviado.' });
        recovered = true;
      }
      if (recovered) await this.persist();
      this.loaded = true;
    } catch (error) { this.error = 'Multi indisponível: ' + error.message; }
  }

  async persist() {
    if (this.error) throw Error(this.error);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'state.json');
    if (this.fileVersion === 1) await copyFile(file, file + '.v1.backup', constants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await writeFile(file + '.tmp', JSON.stringify({ version: 2, records: this.records }), { mode: 0o600 });
    await rename(file + '.tmp', file);
    this.fileVersion = 2;
  }

  /** Apply a change and save it; a failed save restores the previous records. */
  change(mutate) {
    return this.serial(async () => {
      if (this.error) throw Error(this.error);
      const previous = structuredClone(this.records);
      try { const result = await mutate(); await this.persist(); return result; }
      catch (error) { this.records = previous; throw error; }
    });
  }

  record(id) { const record = this.records.find(r => r.id === id); if (!record) throw Error('Conversa dual não encontrada.'); return record; }
  forGroup(groupId) { return this.records.find(r => r.groupId === groupId) || null; }
  activeFor(groupId) { const record = this.forGroup(groupId); return record?.active ? record : null; }
  running(record) {
    return record.rounds.some(round => round.targets.some(key => ['preparing', 'sending'].includes(round.deliveries[key].status)));
  }

  start(groupId, members, principal) {
    return this.change(() => {
      let record = this.forGroup(groupId);
      if (record?.active) throw Error('O Multi já está ativo nesta conversa.');
      if (!record) { record = { id: randomUUID(), groupId, rounds: [], createdAt: now() }; this.records.push(record); }
      else stamp(record);
      if (!validMembers(members) || !Object.hasOwn(members, principal)) throw Error('Escolhe entre dois e quatro clientes distintos e um principal válido.');
      Object.assign(record, { active: true, members, principal, target: memberKeys({members}).length === 2 ? 'both' : 'all', revision: (record.revision || 0) + 1, startedAt: now(), endedAt: null, updatedAt: now() });
      return record;
    });
  }
  update(id, changes) {
    return this.change(() => {
      const record = this.record(id);
      if (!record.active) throw Error('O Multi está desligado nesta conversa.');
      if (changes.target !== undefined) { targetKeys(record, changes.target); record.target = changes.target; }
      if (changes.principal !== undefined) { if (!Object.hasOwn(record.members, changes.principal)) throw Error('Principal inválido.'); record.principal = changes.principal; }
      for (const key of memberKeys(record)) if (changes.members?.[key]) Object.assign(record.members[key], changes.members[key]);
      record.updatedAt = now();
      record.revision = (record.revision || 0) + 1;
      return record;
    });
  }
  /** One member's client changes without ending the dual; the slot keeps its role unless the principal is chosen again. */
  replace(id, key, member, principal) {
    return this.change(() => {
      const record = this.record(id);
      if (!record.active) throw Error('O Multi está desligado nesta conversa.');
      if (!Object.hasOwn(record.members, key)) throw Error('Participante inválido.');
      if (this.running(record)) throw Error('Aguarda o fim da ronda para mudar de participante.');
      if (principal !== undefined && !Object.hasOwn(record.members, principal)) throw Error('Principal inválido.');
      stamp(record);
      if (memberKeys(record).some(k => k !== key && record.members[k].provider === member.provider)) throw Error('Este cliente já participa no Multi.');
      const from = record.members[key];
      record.members[key] = member;
      if (principal !== undefined) record.principal = principal;
      (record.changes ||= []).push({ at: now(), key, from: { provider: from.provider, conversationId: from.conversationId, model: from.model }, to: { provider: member.provider, conversationId: member.conversationId, model: member.model } });
      if (record.changes.length > MAX_CHANGES) record.changes.splice(0, record.changes.length - MAX_CHANGES);
      record.updatedAt = now();
      record.revision = (record.revision || 0) + 1;
      return record;
    });
  }
  operation(record, requestId, signature) {
    if (typeof requestId !== 'string' || !requestId || requestId.length > 100) throw Error('Identificador da alteração inválido.');
    const previous = record.changes?.find(change => change.requestId === requestId);
    if (previous && previous.signature !== signature) throw Error('Identificador já usado para outra alteração.');
    return previous;
  }
  roster(id, { key, member = null, principal, revision, requestId, signature }) {
    return this.change(() => {
      const record = this.record(id);
      if (this.operation(record, requestId, signature)) return record;
      if (!record.active || this.running(record)) throw Error('Aguarda o fim da ronda para alterar participantes.');
      if (revision !== (record.revision || 0)) throw Error('O Multi mudou entretanto. Abre a configuração de novo.');
      stamp(record);
      const from = record.members[key] || null;
      if (member) {
        if (from || !DUAL_KEYS.includes(key) || memberKeys(record).length >= 4) throw Error('O Multi já tem quatro participantes ou o lugar está ocupado.');
        record.members[key] = member;
      } else {
        if (!from || memberKeys(record).length <= 2) throw Error('O Multi precisa de pelo menos dois participantes. Usa «Desligar Multi» para continuar com um.');
        delete record.members[key];
      }
      if (principal !== undefined) record.principal = principal;
      if (!validMembers(record.members) || !Object.hasOwn(record.members, record.principal)) throw Error('Escolhe outro principal antes de remover o atual.');
      if (record.target === 'both') record.target = 'all';
      if (record.target !== 'all') {
        const selected = (Array.isArray(record.target) ? record.target : [record.target]).filter(k => Object.hasOwn(record.members, k));
        record.target = selected.length === 0 ? record.principal : selected.length === 1 ? selected[0] : selected;
      }
      (record.changes ||= []).push({ at: now(), key, from, to: member, requestId, signature });
      if (record.changes.length > MAX_CHANGES) record.changes.splice(0, record.changes.length - MAX_CHANGES);
      record.revision = (record.revision || 0) + 1;
      record.updatedAt = now();
      return record;
    });
  }
  end(id) {
    return this.change(() => {
      const record = this.record(id);
      Object.assign(record, { active: false, endedAt: now(), updatedAt: now() });
      return record;
    });
  }

  /** The round and each recipient's identity are saved before anything is sent. */
  addRound(id, round, members = {}) {
    return this.change(() => {
      const record = this.record(id);
      // The settings used last become each member's defaults for the next round.
      for (const key of memberKeys(record)) if (members[key]) Object.assign(record.members[key], members[key]);
      round.members ||= pair(record);
      round.principal ||= record.principal;
      record.rounds.push(round);
      if (record.rounds.length > MAX_ROUNDS) record.rounds.splice(0, record.rounds.length - MAX_ROUNDS);
      record.updatedAt = now();
      return round;
    });
  }
  removeRound(id, roundId) {
    return this.change(() => { const record = this.record(id); record.rounds = record.rounds.filter(r => r.id !== roundId); });
  }
  setDeliveries(id, roundId, changes) {
    return this.change(() => {
      const round = this.record(id).rounds.find(r => r.id === roundId);
      if (round) for (const [key, value] of Object.entries(changes)) Object.assign(round.deliveries[key], value, { at: now() });
    });
  }
  /** A failed recipient is sent again under a new id: what its conversation recorded for the failed attempt stays apart. */
  retryDelivery(id, roundId, key, requestId) {
    return this.change(() => {
      const round = this.record(id).rounds.find(r => r.id === roundId), entry = round?.deliveries[key];
      if (entry?.status !== 'failed') throw Error('Este envio não falhou. Nada foi reenviado.');
      Object.assign(entry, { attempts: [...(entry.attempts || []), entry.requestId], requestId, status: 'preparing', error: null, coverage: null, at: now() });
      return round;
    });
  }
  /** Synthesis options of the dual: automatic after each round to both, and whether the result goes to the next round. */
  setSynthesis(id, settings) {
    return this.change(() => { const record = this.record(id); record.synthesis = settings; record.updatedAt = now(); return record; });
  }
  /** An automatic synthesis is marked on its round before it starts, so that a restart never starts it again. */
  markSynthesis(id, roundId, mark) {
    return this.change(() => { const round = this.record(id).rounds.find(r => r.id === roundId); if (round) round.synthesis = { ...(round.synthesis || {}), ...mark }; return round; });
  }
  /** Rounds sent to more than one model, by member request: the request text is shared, never repeated. */
  sharedRequests(groupId) {
    const shared = new Map(), ids = entry => [entry.requestId, ...(entry.attempts || [])].map(requestId => `${entry.conversationId}:${requestId}`);
    for (const round of this.forGroup(groupId)?.rounds || []) if (round.targets.length > 1) {
      const entries = round.targets.map(key => round.deliveries[key]);
      for (const entry of entries) for (const id of ids(entry)) shared.set(id, entries.filter(other => other !== entry).flatMap(ids));
    }
    return shared;
  }
  snapshot() { return { multiVersion: 2, error: this.error || null, records: this.records }; }
  async close() { await this.queue; }
}
