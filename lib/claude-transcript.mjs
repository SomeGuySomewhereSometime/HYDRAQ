import os from 'node:os';
import path from 'node:path';
import { open } from 'node:fs/promises';

// Native Claude Code transcripts (`<config>/projects/<folder>/<session>.jsonl`) are append-only JSON
// lines. Only the active branch of the main conversation is read: subagent sidechains, metadata and
// local slash-command records stay in the native session.
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_TRANSCRIPT = 256 * 1024 * 1024;
const SAMPLE = 512 * 1024;
const localRecord = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/;
const interruption = /^\[Request interrupted by user/;
const chained = new Set(['user', 'assistant', 'system', 'attachment']);

export const claudeHome = env => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
/** The CLI names the folder after the launch directory, replacing every other character by '-'. */
export const projectDirectory = (env, cwd) => path.join(claudeHome(env), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

export function parseLines(text) {
  const entries = [];
  let skipped = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try { const entry = JSON.parse(line); if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry); else skipped++; }
    catch { skipped++; }
  }
  return { entries, skipped };
}

/** Head and tail of a large transcript, enough for a listing; partial lines at the cut are dropped. */
export async function sampleTranscript(file, size) {
  const handle = await open(file, 'r');
  try {
    const read = async (position, length) => { const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, position); return buffer.subarray(0, bytesRead).toString('utf8'); };
    if (size <= SAMPLE * 2) return parseLines(await read(0, size)).entries;
    const head = await read(0, SAMPLE), tail = await read(size - SAMPLE, SAMPLE);
    return [...parseLines(head.slice(0, head.lastIndexOf('\n'))).entries, ...parseLines(tail.slice(tail.indexOf('\n') + 1)).entries];
  } finally { await handle.close(); }
}

const blocksOf = entry => {
  const content = entry.message?.content;
  return Array.isArray(content) ? content.filter(block => block && typeof block === 'object') : [{ type: 'text', text: typeof content === 'string' ? content : '' }];
};
const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(block => block?.type === 'text' ? String(block.text || '') : '').filter(Boolean).join('\n') : '';

/** A prompt the person typed (terminal) or sent (app), not a tool result, notice or local command. */
export function promptOf(entry) {
  if (entry.type !== 'user' || entry.isSidechain || entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly || entry.promptSource === 'system') return null;
  const blocks = blocksOf(entry);
  if (blocks.some(block => block.type === 'tool_result')) return null;
  const text = blocks.filter(block => block.type === 'text').map(block => String(block.text || '')).join('\n').trim();
  const images = blocks.filter(block => block.type === 'image').length;
  if ((!text && !images) || localRecord.test(text) || interruption.test(text)) return null;
  return { uuid: typeof entry.uuid === 'string' ? entry.uuid : null, text, images, at: typeof entry.timestamp === 'string' ? entry.timestamp : null };
}

/** Entries of the branch that ends at the last main-chain entry, oldest first. A compaction keeps
 * its link in `logicalParentUuid`; a rewind leaves the abandoned branch out. */
export function activeChain(entries) {
  const byId = new Map();
  let leaf = null;
  for (const entry of entries) if (typeof entry.uuid === 'string' && !entry.isSidechain && chained.has(entry.type)) { byId.set(entry.uuid, entry); leaf = entry; }
  const chain = [], seen = new Set();
  for (let entry = leaf; entry && !seen.has(entry.uuid); entry = byId.get(entry.parentUuid ?? entry.logicalParentUuid)) { seen.add(entry.uuid); chain.push(entry); }
  return chain.reverse();
}

/** Groups chain entries into requests: one prompt, the visible text replies and the tool calls.
 * Parallel tool calls leave each result on its own side branch, so results are matched by tool ID
 * across every main-conversation entry (`all`), not only along the chain. */
export function transcriptTurns(entries, all = entries) {
  const turns = [], tools = new Map(), results = new Map();
  for (const entry of all) if (entry.type === 'user' && !entry.isSidechain) for (const block of blocksOf(entry)) if (block.type === 'tool_result' && block.tool_use_id) results.set(block.tool_use_id, block);
  let turn = null, compactions = 0;
  const start = prompt => { turn = { prompt, messages: [], tools: [], status: 'completed', model: null, startedAt: prompt?.at || null, completedAt: prompt?.at || null }; turns.push(turn); };
  for (const entry of entries) {
    const at = typeof entry.timestamp === 'string' ? entry.timestamp : null;
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') { compactions++; continue; }
    if (entry.type === 'user' && !entry.isSidechain) {
      for (const block of blocksOf(entry).filter(block => block.type === 'tool_result')) {
        const tool = tools.get(block.tool_use_id);
        if (tool) Object.assign(tool, { done: true, isError: Boolean(block.is_error), result: textOf(block.content) });
      }
      if (interruption.test(textOf(entry.message?.content).trim()) && turn) { turn.status = 'interrupted'; continue; }
      const prompt = promptOf(entry);
      if (prompt) start(prompt);
      continue;
    }
    if (entry.type !== 'assistant' || entry.isSidechain) continue;
    const message = entry.message || {};
    if (!turn) start(null);
    if (typeof message.model === 'string' && message.model !== '<synthetic>') turn.model = message.model;
    turn.stop = message.stop_reason ?? null;
    turn.apiError = Boolean(entry.isApiErrorMessage);
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'text' && String(block.text || '').trim()) {
        const id = String(message.id || entry.uuid || turn.messages.length), last = turn.messages.at(-1);
        if (last?.id === id) last.text += block.text;
        else turn.messages.push({ id, text: String(block.text), at });
      } else if (block?.type === 'tool_use' && typeof block.id === 'string') {
        const tool = { id: block.id, name: String(block.name || 'Ferramenta'), input: block.input && typeof block.input === 'object' ? block.input : {}, at, done: false, isError: false, result: '' };
        tools.set(block.id, tool); turn.tools.push(tool);
      }
    }
    if (at) turn.completedAt = at;
  }
  // Only the CLI's own end marker confirms a request. A prompt without reply, partial text or a tool
  // call without result (the terminal closed mid-turn) stays unconfirmed, never completed.
  for (const tool of tools.values()) {
    const block = !tool.done && results.get(tool.id);
    if (block) Object.assign(tool, { done: true, isError: Boolean(block.is_error), result: textOf(block.content) });
  }
  for (const item of turns) {
    if (item.status === 'interrupted') continue;
    if (item.apiError || item.stop === 'refusal') item.status = 'failed';
    else if (!['end_turn', 'stop_sequence'].includes(item.stop) || item.tools.some(tool => !tool.done)) { item.status = 'interrupted'; item.unconfirmed = true; }
  }
  return { turns, compactions };
}

const SOURCES = { cli: 'Terminal', 'claude-desktop': 'App Claude', 'claude-vscode': 'VS Code', 'claude-jetbrains': 'JetBrains' };
export const sourceName = entrypoint => SOURCES[entrypoint] || entrypoint || 'Claude Code';

/** Listing details; titles come from the CLI (`/rename` or its own title) before the first prompt. */
export function sessionSummary(entries) {
  let custom = null, generated = null, prompt = null, cwd = null, model = null;
  const entrypoints = [];
  for (const entry of entries) {
    if (entry.type === 'custom-title' && typeof (entry.customTitle ?? entry.title) === 'string') custom = entry.customTitle ?? entry.title;
    if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') generated = entry.aiTitle;
    if (entry.type === 'summary' && typeof entry.summary === 'string') generated ||= entry.summary;
    if (entry.isSidechain) continue;
    if (typeof entry.entrypoint === 'string' && !entrypoints.includes(entry.entrypoint)) entrypoints.push(entry.entrypoint);
    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd;
    if (entry.type === 'assistant' && typeof entry.message?.model === 'string' && entry.message.model !== '<synthetic>') model = entry.message.model;
    prompt ||= promptOf(entry)?.text || null;
  }
  const external = entrypoints.find(entrypoint => !entrypoint.startsWith('sdk')) || null;
  // App prompts can arrive wrapped in markup (for example a mention); the title keeps only the text.
  const title = String(custom || generated || (prompt || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 80);
  return { title, cwd, model, entrypoints, external, source: sourceName(external) };
}
