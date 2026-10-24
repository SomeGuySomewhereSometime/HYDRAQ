/**
 * Reads the steps agy keeps for a conversation: SQLite with protobuf payloads and no published schema
 * (observed with agy 1.4.7). Only what HYDRAQ shows is taken — the request text, the answer text and the
 * tool calls — and anything unexpected makes the reading fail, so the caller keeps what it can prove.
 */
const USER = 14, MODEL = 15;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function varint(buffer, at) {
  let value = 0, scale = 1;
  for (let i = 0; i < 10; i++) {
    if (at >= buffer.length) throw Error('Passo do agy truncado.');
    const byte = buffer[at++];
    value += (byte & 0x7f) * scale; scale *= 128;
    if (byte < 0x80) return [value, at];
  }
  throw Error('Número inválido num passo do agy.');
}
/** Protobuf wire format, without a schema: [field number, number | bytes] pairs. */
export function wireFields(buffer) {
  const out = [];
  let at = 0;
  while (at < buffer.length) {
    const [key, next] = varint(buffer, at); at = next;
    const number = Math.floor(key / 8), wire = key % 8;
    if (number < 1) throw Error('Campo inválido num passo do agy.');
    if (wire === 0) { const [value, after] = varint(buffer, at); out.push([number, value]); at = after; }
    else if (wire === 2) {
      const [length, after] = varint(buffer, at); at = after;
      if (at + length > buffer.length) throw Error('Passo do agy truncado.');
      out.push([number, buffer.subarray(at, at + length)]); at += length;
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else throw Error('Formato desconhecido num passo do agy.');
  }
  if (at !== buffer.length) throw Error('Passo do agy truncado.');
  return out;
}
const field = (list, number) => list.find(([n]) => n === number)?.[1];
const message = value => value instanceof Uint8Array ? wireFields(value) : null;
const text = value => value instanceof Uint8Array ? utf8.decode(value) : null;

function stepTime(top) {
  const time = message(field(message(field(top, 5)) || [], 1));
  const seconds = time && field(time, 1);
  return Number.isFinite(seconds) ? new Date(seconds * 1000 + Math.floor((field(time, 2) || 0) / 1e6)).toISOString() : null;
}

/** A request (14), a model step with its answer text and tool calls (15), or another kind kept only by index. */
export function decodeStep({ idx, step_type: type, step_payload: payload }) {
  const top = wireFields(payload instanceof Uint8Array ? payload : new Uint8Array());
  const at = stepTime(top);
  if (type === USER) {
    const prompt = text(field(message(field(top, 19)) || [], 2));
    if (typeof prompt !== 'string') throw Error('Pedido do agy sem texto.');
    return { idx, kind: 'user', at, text: prompt };
  }
  if (type === MODEL) {
    const parts = message(field(top, 20));
    if (!parts) throw Error('Passo do modelo sem conteúdo.');
    const tools = parts.filter(([n]) => n === 7).map(([, raw]) => {
      const call = message(raw), name = text(field(call, 2));
      let args = {};
      try { args = JSON.parse(text(field(call, 3)) || '{}'); } catch { args = {}; }
      return { name, args: args && typeof args === 'object' ? args : {} };
    }).filter(tool => tool.name);
    return { idx, kind: 'model', at, text: text(field(parts, 1)), tools };
  }
  return { idx, kind: 'other', at };
}

async function database(file) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}
/** Every step after `after` (all with -1), oldest first. */
export async function readSteps(file, after = -1) {
  const db = await database(file);
  try { return db.prepare('SELECT idx, step_type, step_payload FROM steps WHERE idx > ? ORDER BY idx').all(after).map(decodeStep); }
  finally { db.close(); }
}
/** Index of the last step, -1 for none; null when the store cannot be read. */
export async function lastStep(file) {
  try {
    const db = await database(file);
    try { const row = db.prepare('SELECT MAX(idx) AS last FROM steps').get(); return Number.isInteger(row?.last) ? row.last : -1; }
    finally { db.close(); }
  } catch { return null; }
}

/** Steps grouped by request: each request with the answers and tool calls that followed it. */
export function stepTurns(steps) {
  const turns = [];
  for (const step of steps) {
    if (step.kind === 'user') turns.push({ prompt: step, start: step.idx, answers: [], tools: [] });
    else if (step.kind === 'model') {
      if (!turns.length) turns.push({ prompt: null, start: step.idx, answers: [], tools: [] });
      const turn = turns.at(-1);
      if (step.text?.trim()) turn.answers.push(step);
      turn.tools.push(...step.tools);
    }
  }
  return turns;
}
