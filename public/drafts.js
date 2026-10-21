// The operation intent travels with the text; returning to an old steer draft never
// converts it into a new model request. Model settings are kept separately by client.
export const draftKey = (conversation, projectId) => conversation ? `chat:${conversation.group || conversation.id}` : `new:${projectId || 'loose'}`;
export class ComposerDrafts {
  constructor() { this.records = new Map(); }
  save(key, text, intent, cwd) { this.records.set(key, { text, intent: intent ? { ...intent } : null, cwd }); }
  get(key) { return this.records.get(key) || { text: '', intent: null, cwd: '' }; }
  move(from, to) { if (from !== to && this.records.has(from)) { this.records.set(to, this.records.get(from)); this.records.delete(from); } }
  clear(key, expectedText) { if (this.records.get(key)?.text === expectedText) this.records.delete(key); }
}
