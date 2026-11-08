import { randomUUID } from 'node:crypto';

const active = new Set(['starting', 'running', 'waiting']);
const pending = new Set(['queued', 'stopping', 'dispatching']);
export const followupModes = provider => ({ codex: ['steer', 'queue'], claude: ['next', 'now', 'queue'], antigravity: ['redirect', 'queue'], opencode:['steer','queue'] }[provider] || []);

/** Deferred messages live in the client's existing history, never in a second history store. */
export class Followups {
  constructor({ hub, owner, provider, deliver }) {
    Object.assign(this, { hub, owner, provider, deliver });
    this.reservations = new Map(); this.tasks = new Set(); this.loading = true;
  }
  entries() { return Object.values(this.hub.clients).flatMap(client => client.conversations.flatMap(c => (c.followups || []).map(record => ({ client, c, record })))); }
  scopes() {
    const occupied = new Set();
    for (const { c, record } of this.entries()) if (pending.has(record.status)) {
      occupied.add(c.id);
      if (!this.reservations.has(c.id)) this.reservations.set(c.id, { ...this.hub.scopeFor(c, this.provider(this.owner(c.id))), kind: 'followup', reason: 'Mensagem em fila ou redirecionamento pendente' });
    }
    for (const id of this.reservations.keys()) if (!occupied.has(id)) this.reservations.delete(id);
    return [...this.reservations.values()];
  }
  async load() {
    for (const { client, c, record } of this.entries()) if (pending.has(record.status) || record.status === 'saving') {
      const turn = c.turns.find(t => t.requestId === record.requestId);
      record.status = turn ? (turn.status === 'completed' ? 'delivered' : 'uncertain') : 'blocked';
      record.error = 'O HYDRAQ reiniciou. A mensagem foi conservada e não será reenviada automaticamente.';
      await client.persist();
    }
    this.loading = false;
  }
  async enqueue(id, text, requestId, expectedTurnId, mode) {
    if (this.hub.closing) throw Error('O HYDRAQ está a encerrar.');
    const client = this.owner(id), c = client.conversation(id);
    if (typeof text !== 'string' || !text.trim() || typeof requestId !== 'string' || !requestId || requestId.length > 100) throw Error('Mensagem ou identificador inválido.');
    const old = c.followups?.find(r => r.requestId === requestId);
    if (old) {
      if(old.status==='saving')throw Error('A mensagem ainda está a ser guardada.');
      if (old.text !== text.trim() || old.mode !== mode || old.originTurnId !== expectedTurnId) throw Error('Identificador já usado para outra mensagem.');
      return { accepted: true, delivery: old.status, duplicate: true };
    }
    if (!['queue', 'redirect'].includes(mode) || !followupModes(this.provider(client)).includes(mode)) throw Error('Este cliente não suporta essa forma de envio.');
    if (!expectedTurnId || c.turnId !== expectedTurnId || !active.has(c.status)) throw Error('Esse turno já terminou. A mensagem não iniciou outro pedido.');
    if (c.messages.some(m => m.requestId === requestId)) throw Error('Identificador já usado por outro pedido.');
    if((c.followups||[]).some(r=>r.status==='saving'))throw Error('Já há uma mensagem a ser guardada nesta conversa.');
    if ((c.followups || []).filter(r => pending.has(r.status)).length >= 10) throw Error('Já existem dez mensagens pendentes nesta conversa.');
    if ((c.followups || []).some(r => r.mode === 'redirect' && pending.has(r.status)) || (mode === 'redirect' && (c.followups || []).some(r => pending.has(r.status)))) throw Error('Conclui ou cancela as mensagens pendentes antes de redirecionar.');
    const record = { id: randomUUID(), requestId, originTurnId: expectedTurnId, text: text.trim(), mode, status: 'saving', admitting:true, at: new Date().toISOString(), settings: { permissionPolicy:c.turns.at(-1)?.permissionPolicy, model: c.model, effort: c.effort, sandbox: c.sandbox, context: c.context, fast: c.fast } };
    (c.followups ||= []).push(record);
    try { await client.persist(); } catch (e) { c.followups.splice(c.followups.indexOf(record), 1); throw e; }
    if(record.status==='cancelled'){record.admitting=false;return {accepted:true,delivery:'cancelled',id:record.id};}
    // No await between the final turn check and taking ownership of the queue.
    if (c.turnId !== expectedTurnId || !active.has(c.status)) { record.status = 'blocked'; record.error = 'O turno terminou antes de guardar o envio. Nada foi enviado.'; }
    else record.status = mode === 'redirect' ? 'stopping' : 'queued';
    try{await client.persist();}catch(error){record.status='blocked';record.error='A gravação da mensagem não foi confirmada. Nada foi enviado.';record.admitting=false;client.changed();this.changed();throw error;}
    record.admitting=false;client.changed();
    if (record.status === 'stopping') {
      try { await client.interrupt(id); } catch (e) { record.status = 'blocked'; record.error = e.message; await client.persist(); client.changed(); }
    }
    this.changed();
    return { accepted: true, delivery: record.status, id: record.id };
  }
  async cancel(id, recordId) {
    const client = this.owner(id), c = client.conversation(id), record = c.followups?.find(r => r.id === recordId);
    if (!record) throw Error('Mensagem pendente não encontrada.');
    if (record.status === 'dispatching' || record.status === 'delivered') throw Error('O envio já começou. Usa Parar para interromper o pedido.');
    record.status = 'cancelled'; record.error = null; await client.persist(); client.changed(); this.changed();
    return { cancelled: true };
  }
  async cancelPending(id) {
    const client = this.owner(id), c = client.conversation(id);
    let cancelled=false;for (const r of c.followups || []) if (['saving','queued', 'stopping','dispatching'].includes(r.status)){r.status='cancelled';cancelled=true;}
    if(cancelled){await client.persist();client.changed();this.scopes();}return cancelled;
  }
  changed() {
    this.scopes();
    if (this.loading || this.hub.closing || this.scheduled) return;
    this.scheduled = setTimeout(() => { this.scheduled = null; this.pump(); }, 0);
  }
  pump() {
    if (this.loading || this.hub.closing || this.hub.workScopes().some(s=>s.resources?.includes('normal-preparation'))) return;
    for (const client of Object.values(this.hub.clients)) for (const c of client.conversations) {
      if (active.has(c.status) || this.tasks.has(c.id) || this.hub.automaticReviews?.holds(c.id)) continue;
      const record = c.followups?.find(r => pending.has(r.status));
      if (!record || record.admitting) continue;
      if (record.mode === 'redirect' && client.session?.conversation === c) continue; // Wait for the old process to close.
      const task = this.advance(client, c, record).catch(error => { if(record.status!=='cancelled')record.status = 'blocked'; record.error = error.message; return client.persist().catch(() => {}); }).finally(() => { this.tasks.delete(c.id); client.changed(); this.changed(); });
      this.tasks.add(c.id); (this.running ||= new Set()).add(task); task.finally(() => this.running.delete(task));
    }
  }
  async advance(client, c, record) {
    const origin = c.turns.find(t => t.id === record.originTurnId);
    const safeRedirect = record.mode === 'redirect' && origin?.processClosed && origin.nativeStopConfirmed && !origin.forcedStop;
    if (c.status !== 'completed' && !safeRedirect) { record.status = 'blocked'; record.error = 'O pedido não terminou com confirmação. A mensagem foi guardada; revê o estado antes de a enviar.'; await client.persist(); return; }
    const reservation = this.reservations.get(c.id);
    if (this.hub.workScopes().some(s => s !== reservation && s.resources?.includes('normal-preparation'))) return;
    record.status = 'dispatching'; await client.persist();
    if (this.hub.closing || record.status !== 'dispatching') return;
    try {
      await this.deliver(c.id, record.text, record.requestId, {...record.settings,isCancelled:()=>record.status==='cancelled'}, reservation);
      if(record.status!=='cancelled')record.status = 'delivered'; record.deliveredAt = new Date().toISOString();
    } catch (e) {
      const turn = c.turns.find(t => t.requestId === record.requestId);
      if(record.status!=='cancelled')record.status = turn ? 'uncertain' : e.code === 'WORK_RESERVED' ? 'queued' : 'blocked'; record.error = e.message;
    }
    await client.persist();
  }
  async close() { clearTimeout(this.scheduled); await Promise.allSettled([...(this.running || [])]); }
}
