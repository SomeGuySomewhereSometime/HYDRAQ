import {randomUUID} from 'node:crypto';
import {groupOf, turnFacts} from './handoff.mjs';
import {redact} from './project-context.mjs';
import {reviewReturnMode} from './review-decision.mjs';

const nativeActive = new Set(['starting', 'running', 'waiting']);
const pending = new Set(['waiting-main', 'preparing', 'reviewing', 'delivering', 'assessing']);
const time = () => new Date().toISOString();

export function reviewReason(config, turn, facts) {
  if (turn.status !== 'completed') return 'O pedido não terminou com confirmação; não foi revisto automaticamente.';
  if (config.trigger === 'implementation' && !facts.files.length) return 'Não foram observadas alterações de ficheiros neste pedido. Não houve revisão de implementação.';
  if (config.trigger === 'plan' && (facts.files.length || !['plan', 'read-only'].includes(turn.sandbox))) return 'O pedido não decorreu em Planear/Só leitura sem alterações observadas. Não houve crítica automática ao plano.';
  return null;
}

/** One review and one optional return, armed before the source turn. Completed
 * cycles may be archived; historical turns never schedule fresh work. */
export class AutomaticReviews {
  constructor(hub) {
    this.hub = hub;
    this.store = hub.opinions;
    this.policies = {};
    this.cycles = [];
    this.tasks = new Map();
    this.reservations = new Map();
    this.loading = true;
  }

  restore(saved = {}) {
    const invalid = !saved || !Array.isArray(saved.cycles || []) || !saved.policies ||
      typeof saved.policies !== 'object' || Array.isArray(saved.policies) ||
      (saved.cycles || []).some(r => !r || typeof r.id !== 'string' ||
        typeof r.status !== 'string' || typeof r.conversationId !== 'string' || !r.config || !r.settings);
    if (invalid) throw Error('Arquivo de revisões automáticas inválido.');
    this.cycles = saved.cycles || [];
    this.policies = saved.policies;
  }

  state() { return {policies: this.policies, cycles: this.cycles}; }
  isPending(record) { return pending.has(record.status); }

  validate(config) {
    if (config === null || config === undefined) return null;
    if (typeof config !== 'object' || !['all', 'plan', 'implementation'].includes(config.trigger) ||
        !['request', 'conversation'].includes(config.scope) || !['always', 'necessary', 'manual'].includes(reviewReturnMode(config)) ||
        (config.returnToPrincipal !== undefined && typeof config.returnToPrincipal !== 'boolean') ||
        typeof (config.focus ?? '') !== 'string' || (config.focus || '').length > 3000) {
      throw Error('Configuração de revisão inválida.');
    }
    // Old single-reviewer policies stay readable, but never inherit source write access.
    const requested = config.participants ?? (config.participant ? [config.participant] : []);
    if (!Array.isArray(requested) || !requested.length || requested.length > 4) throw Error('Escolhe entre um e quatro revisores.');
    const participants = requested.map(participant => {
      const model = this.hub.clients[participant?.provider]?.models.find(m => m.id === participant.model);
      if (!this.store.snapshot().capabilities[participant?.provider]?.available || !model ||
          !model.efforts.includes(participant.effort) || (participant.provider === 'opencode' && !model.free) ||
          (participant.allowWrite !== undefined && typeof participant.allowWrite !== 'boolean')) {
        throw Error('Escolhe um revisor, modelo, raciocínio e acesso válidos.');
      }
      return {provider: participant.provider, model: participant.model, effort: participant.effort, allowWrite: participant.allowWrite === true};
    });
    if (new Set(participants.map(p => [p.provider,p.model,p.effort].join(':'))).size !== participants.length) throw Error('O mesmo revisor está repetido.');
    const returnMode = reviewReturnMode(config);
    return {trigger: config.trigger, scope: config.scope, returnMode, returnToPrincipal: returnMode !== 'manual', focus: config.focus?.trim() || '', participants};
  }

  async policy(id, config) {
    if (this.store.error || this.hub.closing) throw Error(this.store.error || 'O HYDRAQ está a encerrar.');
    const conversation = this.store.owner(id);
    await this.store.usable(conversation);
    const valid = this.validate(config);
    return this.store.serial(async () => {
      const group = groupOf(conversation), old = this.policies[group];
      if (valid) this.policies[group] = {...valid, scope: 'conversation'};
      else delete this.policies[group];
      try { await this.store.persist(); }
      catch (error) {
        if (old) this.policies[group] = old;
        else delete this.policies[group];
        throw error;
      }
      this.hub.emit('state', this.hub.snapshot());
      return {saved: true};
    });
  }

  async load() {
    for (const cycle of this.cycles) {
      if (!pending.has(cycle.status)) continue;
      const conversation = this.hub.conversations().find(c => c.id === cycle.conversationId);
      const turn = conversation?.turns.find(t => t.requestId === cycle.returnRequestId);
      cycle.status = cycle.status === 'assessing' && turn?.status === 'completed' ? 'completed' : 'suspended';
      cycle.error = 'O HYDRAQ reiniciou. O ciclo foi conservado e não será retomado nem reenviado automaticamente.';
    }
    this.loading = false;
  }

  scope(record) {
    if (!this.reservations.has(record.id)) this.reservations.set(record.id, {
      id: record.id, cwd: record.cwd, projectId: record.projectId,
      resources: ['normal:' + record.provider], kind: 'automatic-review',
      reason: 'Revisão automática em curso ou à espera de decisão', label: record.title,
    });
    return this.reservations.get(record.id);
  }

  scopes() { return this.cycles.filter(r => pending.has(r.status)).map(r => this.scope(r)); }
  holds(id) { return this.cycles.some(r => r.conversationId === id && pending.has(r.status)); }

 async arm(c, requestId, settings) {
  if (this.loading || this.hub.closing || this.cycles.some(r => r.returnRequestId === requestId)) return null;
  const existing = this.cycles.find(r => r.conversationId === c.id && r.requestId === requestId);
  if (existing) return existing;
  if (c.messages.some(m => m.requestId === requestId)) return null;
  const value = settings.autoReview === undefined ? this.policies[groupOf(c)] : settings.autoReview;
  // Explicitly sending without review must work even if its archive is unavailable.
  if (value === null || value === undefined) return null;
  try {
   const config = this.validate(value);
   if (this.store.error) throw Error(this.store.error);
   if (await this.store.archive.find('returns', requestId)) return null;
   const archived = await this.store.archive.find('cycles', requestId);
   if (archived) return null; // Old source/return attempts never arm another cycle.
   const availability = await this.store.supervisor.available();
   if (!availability.available) throw Error(availability.reason);
   const record = {
    id: randomUUID(), requestId, returnRequestId: 'review-return-' + randomUUID(),
    conversationId: c.id, groupId: groupOf(c),
    projectId: this.hub.projects.group(groupOf(c))?.projectId || null,
    cwd: c.cwd, title: c.title,
    provider: c.provider || Object.keys(this.hub.clients).find(p => this.hub.clients[p].conversations.includes(c)),
    config, status: 'waiting-main', createdAt: time(), admitting: true,
    settings: Object.fromEntries(['model','effort','sandbox','context','fast'].map(name => [name, settings[name] ?? c[name]])),
   };
   await this.store.serial(async () => {
    this.cycles.push(record);
    const old = this.policies[record.groupId];
    if (config.scope === 'conversation') this.policies[record.groupId] = config;
    try { await this.store.persist(); }
    catch (error) {
     this.cycles.splice(this.cycles.indexOf(record), 1);
     if (old) this.policies[record.groupId] = old;
     else delete this.policies[record.groupId];
     throw error;
    }
   });
   return record;
  } catch (error) {
   const reason = ['EACCES','EPERM'].includes(error.code) ? 'Não foi possível aceder ao arquivo de pareceres.' : error.code === 'ENOSPC' ? 'Não há espaço disponível para guardar a revisão.' : redact(error.message);
   throw Object.assign(new Error('A revisão automática não pode iniciar: ' + reason), {
    code: 'REVIEW_UNAVAILABLE', status: 409, beforeSend: true,
   });
  }
 }

  async admitted(record, error) {
    if (!record) return;
    record.admitting = false;
    if (error && record.status !== 'cancelled') {
      const conversation = this.hub.conversations().find(c => c.id === record.conversationId);
      if (!conversation?.turns.some(t => t.requestId === record.requestId)) {
        record.status = 'failed';
        record.error = redact(error.message);
      }
    }
    try { await this.store.serial(() => this.store.persist()); }
    catch (error) {
      record.status = 'suspended';
      record.error = 'A gravação do ciclo não ficou confirmada. Revisão suspensa, sem envio automático.';
      throw error;
    }
    this.changed();
  }

  changed() {
    if (this.loading || this.hub.closing || this.scheduled) return;
    this.scheduled = setTimeout(() => { this.scheduled = null; this.pump(); }, 0);
  }

  pump() {
    if (this.loading || this.hub.closing || this.hub.handoff ||
        this.hub.workScopes().some(s => s.resources?.includes('normal-preparation'))) return;
    for (const record of this.cycles) {
      if (!pending.has(record.status) || record.admitting || this.tasks.has(record.id)) continue;
      const conversation = this.hub.conversations().find(c => c.id === record.conversationId);
      if (conversation && nativeActive.has(conversation.status)) continue;
      const task = this.advance(record, conversation).catch(async error => {
        if (record.status !== 'cancelled') record.status = 'failed';
        record.error = redact(error.message);
        await this.store.serial(() => this.store.persist()).catch(() => {});
      }).finally(() => {
        this.tasks.delete(record.id);
        this.hub.followups.changed();
        this.hub.emit('state', this.hub.snapshot());
      });
      this.tasks.set(record.id, task);
    }
  }

  async advance(record, conversation) {
    if (!conversation) throw Error('Conversa de origem indisponível.');
    await this.store.usable(conversation);
    if (record.status === 'assessing') {
      const turn = conversation.turns.find(t => t.requestId === record.returnRequestId);
      record.status = turn?.status === 'completed' ? 'completed' : 'failed';
      record.error = record.status === 'failed' ? 'A avaliação do principal não terminou com confirmação. Nada foi reenviado.' : null;
      await this.save();
      return;
    }
    const turn = conversation.turns.find(t => t.requestId === record.requestId);
    if (!turn) throw Error('O pedido original não confirmou um turno.');
    const facts = turn.facts || turnFacts(conversation, turn);
    const reason = reviewReason(record.config, {...turn, sandbox: turn.sandbox ?? record.settings.sandbox}, facts);
    if (reason) {
      record.status = 'skipped'; record.reason = reason;
      await this.save();
      return;
    }
    const messages = conversation.messages.filter(m => !m.internal && m.role === 'assistant' &&
      (m.requestId === record.requestId || turn.id && m.turnId === turn.id));
    const message = messages.at(-1);
    if (!message?.text?.trim()) throw Error('O principal não deixou uma resposta final para rever.');
    for (const name of ['model', 'effort', 'sandbox', 'context', 'fast']) {
      if (turn[name] !== undefined) record.settings[name] = turn[name];
    }
    const messageKey = message.id || `${message.requestId || message.turnId || 'legacy'}:${message.role}:${conversation.messages.indexOf(message)}`;
    record.status = 'preparing';
    await this.save();
    if (!this.valid(record)) return;

    const mode = {all: 'comment', plan: 'plan', implementation: 'implementation'}[record.config.trigger];
    const ignored = [this.scope(record), ...this.hub.followups.scopes().filter(s => s.id === conversation.id)];
    const created = await this.store.create(conversation.id, {
      requestId: 'auto-review-' + record.id, messageKey,
      participants: record.config.participants || [record.config.participant], comment: record.config.focus, reviewMode: mode,
      askRecommendation: reviewReturnMode(record.config) === 'necessary',
    }, ignored);
    record.batchId = created.id;
    const batch = this.store.batches.find(b => b.id === created.id);
    batch.automaticCycleId = record.id;
    if (!this.valid(record)) {
      for (const job of batch.jobs) await this.store.stop(job.id);
      await this.save();
      return;
    }
    record.status = 'reviewing';
    await this.save();
    await Promise.allSettled(batch.jobs.map(j => this.store.tasks.get(j.id)));
    if (!this.valid(record)) return;
    if (this.store.unsafe) throw Error('A limpeza dos processos não ficou confirmada. Parecer conservado, sem envio ao principal.');
    const returnMode = reviewReturnMode(record.config);
    if (returnMode !== 'necessary' && batch.jobs.some(j => j.status !== 'completed' || !j.text)) {
      throw Error('Um ou mais revisores não terminaram com um parecer confirmado. Falha não é aprovação; os pareceres concluídos ficaram separados, sem envio automático parcial ao principal.');
    }
    if (returnMode === 'manual') {
      record.status = 'completed'; record.reason = 'Pareceres concluídos e separados do contexto principal; escolhe quais enviar.';
      await this.save();
      return;
    }
    let selected = batch.jobs;
    if (returnMode === 'necessary') {
      selected = batch.jobs.filter(j => j.status === 'completed' && j.text && j.recommendation?.status === 'decided' && j.recommendation.sendToPrincipal === true);
      record.undecidedJobIds = batch.jobs.filter(j => j.status !== 'completed' || !j.text || j.recommendation?.status !== 'decided').map(j => j.id);
      const separate = batch.jobs.length - selected.length;
      record.reason = `${selected.length} ${selected.length === 1 ? 'parecer recomendado para envio' : 'pareceres recomendados para envio'}; ${separate} ${separate === 1 ? 'mantido separado' : 'mantidos separados'}.`;
      if (record.undecidedJobIds.length) record.reason += ` ${record.undecidedJobIds.length} ${record.undecidedJobIds.length === 1 ? 'decisão pendente ou falhada' : 'decisões pendentes ou falhadas'}, sem aprovação implícita.`;
      if (!selected.length) {
        record.status = record.undecidedJobIds.length ? 'needs-decision' : 'completed';
        if (!record.undecidedJobIds.length) record.reason = 'Nenhum revisor recomendou enviar. Os pareceres continuam separados e disponíveis para envio manual; isto não equivale a uma aprovação.';
        await this.save();
        return;
      }
    }
    record.selectedJobIds = selected.map(j => j.id);
    record.status = 'delivering';
    await this.save();
    if (!this.valid(record)) return;
    const comment = (returnMode === 'necessary' ? 'Recebes apenas os pareceres que recomendaram envio. Não deduzas a opinião dos restantes revisores nem trates ausência de parecer como aprovação. ' : '') + 'Revisão automática do pedido anterior. Avalia as críticas e aceita apenas as justificadas. Entrega a resposta final completa ao pedido original, com a resposta inicial e as melhorias integradas; não respondas apenas às críticas. Mantém o objetivo e as permissões do pedido original. Se esse pedido autorizava implementação, podes corrigir problemas dentro desse âmbito; se era planeamento ou consulta, limita-te a melhorar o plano ou a resposta. Esta é a única avaliação automática deste ciclo; não voltes a pedir revisão.';
    try {
      await this.store.incorporate(conversation.id, {
        requestId: record.returnRequestId, jobIds: record.selectedJobIds, comment,
        settings: {...record.settings, autoReview: null, isCancelled: () => !this.valid(record)},
      }, ignored);
      if (this.valid(record)) { record.status = 'assessing'; await this.save(); }
    } catch (error) {
      if (record.status === 'cancelled') return;
      record.status = conversation.turns.some(t => t.requestId === record.returnRequestId) ? 'suspended' : 'failed';
      record.error = redact(error.message);
      await this.save();
      return;
    }
    this.changed();
  }

  valid(record) { return !this.hub.closing && pending.has(record.status); }

  async save() {
    await this.store.serial(() => this.store.persist());
    this.hub.emit('state', this.hub.snapshot());
  }

  async cancel(id) {
    const record = this.cycles.find(r => r.id === id);
    if (!record) throw Error('Revisão automática não encontrada.');
    if (!pending.has(record.status)) return {cancelled: true};
    const assessing = ['delivering', 'assessing'].includes(record.status);
    record.status = 'cancelled';
    record.error = 'Ciclo automático parado pelo utilizador. Não será retomado.';
    await this.save();
    const batch = this.store.batches.find(b => b.id === record.batchId);
    for (const job of batch?.jobs || []) await this.store.stop(job.id);
    if (assessing) {
      const client = this.hub.clients[record.provider];
      const conversation = client?.conversations.find(c => c.id === record.conversationId);
      if (conversation && nativeActive.has(conversation.status) && conversation.turns.at(-1)?.requestId === record.returnRequestId) {
        await client.interrupt(conversation.id);
      }
    }
    return {cancelled: true};
  }

  async close() {
    clearTimeout(this.scheduled);
    for (const record of this.cycles) if (pending.has(record.status)) await this.cancel(record.id).catch(() => {});
    await Promise.allSettled([...this.tasks.values()]);
  }
}
