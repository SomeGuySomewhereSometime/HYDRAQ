// The operation intent travels with the text; returning to an old steer draft never
// converts it into a new model request. Model settings are kept separately by client.
export const draftKey = (conversation, projectId) => conversation ? `chat:${conversation.group || conversation.id}` : `new:${projectId || 'loose'}`;
// Storage failure must never prevent editing or sending a request.
export class PersistentDraftMap extends Map {
  constructor(key, storage) {
    super(); this.key=key;
    try { this.storage=storage===undefined?globalThis.localStorage:storage;
      const saved=JSON.parse(this.storage?.getItem(key)||'null');
      if(saved?.version===1&&Array.isArray(saved.entries))for(const entry of saved.entries)if(Array.isArray(entry)&&typeof entry[0]==='string'&&entry[1]!==null&&['object','string'].includes(typeof entry[1]))super.set(...entry);
    } catch { this.failed=true; }
  }
  persist() {
    try { this.storage?.setItem(this.key,JSON.stringify({version:1,entries:[...this]})); }
    catch { this.failed=true; globalThis.dispatchEvent?.(new Event('hydraq-draft-storage-error')); }
  }
  set(key,value) { super.set(key,value); this.persist(); return this; }
  delete(key) { const result=super.delete(key); this.persist(); return result; }
  clear() { super.clear(); this.persist(); }
}
export class ComposerDrafts {
  constructor(storage) { this.records = new PersistentDraftMap('hydraq.drafts.v1',storage); }
  save(key, text, intent, cwd) { this.records.set(key, { text, intent: intent ? { ...intent } : null, cwd }); }
  get(key) { return this.records.get(key) || { text: '', intent: null, cwd: '' }; }
  move(from, to) { if (from !== to && this.records.has(from)) { this.records.set(to, this.records.get(from)); this.records.delete(from); } }
  clear(key, expectedText) { if (this.records.get(key)?.text === expectedText) this.records.delete(key); }
}
