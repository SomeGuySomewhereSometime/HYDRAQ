import { mkdir, readFile, writeFile, rename, copyFile, constants } from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// agy ignores `--mode plan` while slash commands are disabled, and its real plan mode never calls MCP tools.
// Read-only comes from HYDRAQ's own entry in agy's global hooks.json instead: agy runs it before every tool, in
// every session. It acts only on conversations HYDRAQ has marked read-only and answers "ask" (agy's normal
// permission flow) everywhere else. A failing or missing hook makes agy refuse the tool.
export const GUARD_HOOK = 'hydraq';

export function guardPaths(home = os.homedir()) {
  return { hooksFile: path.join(home, '.gemini', 'config', 'hooks.json'), directory: path.join(home, '.local', 'state', 'hydraq', 'agy-guard') };
}

const readTools = ['read_file', 'view_file', 'list_dir', 'find_by_name', 'grep_search', 'search_web', 'view_code_item', 'codebase_search', 'command_status'];
export function readOnlyPolicy() {
  return { version: 1, reason: 'HYDRAQ: esta conversa está em Planear/Só leitura.', tools: readTools, mcp: {} };
}

/** A single read-only command: no shell operators, substitutions or redirections, and no flags that write or run programs. */
export function readOnlyCommand(line) {
  if (typeof line !== 'string' || !line.trim() || line.length > 2000 || /[;&|<>`$\\\r\n(){}]/.test(line)) return false;
  const words = line.trim().split(/\s+/).map(word => word.replace(/^['"]|['"]$/g, ''));
  const [command, sub] = words;
  if (!['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'file', 'stat', 'pwd', 'tree', 'du', 'realpath', 'dirname', 'basename', 'echo', 'which', 'date', 'nl', 'cut', 'diff', 'cmp', 'jq', 'sort', 'git'].includes(command)) return false;
  const has = (...flags) => words.some(word => flags.some(flag => word === flag || word.startsWith(flag + '=')));
  if (command === 'find' && has('-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls')) return false;
  if (command === 'rg' && has('--pre')) return false;
  if ((command === 'sort' || command === 'tree') && words.some(word => /^-[A-Za-z]*o/.test(word) || word.startsWith('--output'))) return false;
  if (command === 'git' && (!['status', 'log', 'diff', 'show', 'ls-files', 'ls-tree', 'grep', 'blame', 'rev-parse', 'describe', 'shortlog', 'cat-file'].includes(sub) || words.some(word => /^(--output|--ext-diff|--textconv|--open-files-in-pager|-O)/.test(word)))) return false;
  return true;
}

/** Public http(s) addresses only: the local HYDRAQ server and private networks stay out of reach by name or literal address. */
export function publicUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host) || (!host.includes('.') && !host.includes(':'))) return false;
  if (/^\d+$/.test(host) || /^0x/.test(host) || /^(0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return false;
  if (host.includes(':') && (host === '::1' || host === '::' || /^(fc|fd|fe8|fe9|fea|feb)/.test(host) || host.startsWith('::ffff:'))) return false;
  return true;
}

/** The hook's answer for one tool call of a read-only conversation. */
export function decide(input, policy) {
  const call = input && input.toolCall || {}, name = String(call.name || ''), args = call.args && typeof call.args === 'object' ? call.args : {};
  const deny = reason => ({ decision: 'deny', reason: policy.reason + ' ' + reason });
  if (policy.tools.includes(name)) return { decision: 'ask' };
  if (name === 'run_command') return readOnlyCommand(args.CommandLine) ? { decision: 'ask' } : deny('Só são permitidos comandos simples de leitura (por exemplo ls, cat, grep, find, git status/log/diff/show), sem ;, |, &, redirecionamentos ou substituições.');
  if (name === 'call_mcp_tool') return (policy.mcp[args.ServerName] || []).includes(args.ToolName) ? { decision: 'ask' } : deny('Este servidor ou ferramenta MCP não está disponível.');
  if (name === 'read_url_content') return publicUrl(args.Url ?? args.url) ? { decision: 'ask' } : deny('Só são permitidos endereços públicos http ou https.');
  if (['write_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(name)) {
    // agy keeps its own plans and notes in the conversation's artifact folder; the project stays untouched.
    const target = args.Path ?? args.TargetFile ?? args.file_path, artifacts = input.artifactDirectoryPath;
    if (typeof target === 'string' && typeof artifacts === 'string' && path.isAbsolute(target) && path.isAbsolute(artifacts) && path.resolve(target).startsWith(path.resolve(artifacts) + path.sep)) return { decision: 'ask' };
    return deny('Não pode criar nem alterar ficheiros.');
  }
  return deny('A ferramenta ' + name + ' não está disponível.');
}

// The hook program itself. It records every decision so HYDRAQ can stop a turn whose tools the hook never saw.
function main() {
  const directory = process.argv[1];
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    let answer = { decision: 'ask' }, q = null;
    try { q = JSON.parse(input); } catch {}
    const id = q && typeof q.conversationId === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(q.conversationId) ? q.conversationId : null;
    let text = null;
    if (id) try { text = fs.readFileSync(path.join(directory, id + '.json'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') answer = { decision: 'deny', reason: 'HYDRAQ: a regra só de leitura desta conversa não pôde ser lida.' }; }
    if (text !== null) {
      try {
        answer = decide(q, JSON.parse(text));
        fs.appendFileSync(path.join(directory, id + '.log'), JSON.stringify({ at: new Date().toISOString(), stepIdx: q.stepIdx ?? null, name: String(q.toolCall && q.toolCall.name || ''), decision: answer.decision }) + '\n');
      } catch { answer = { decision: 'deny', reason: 'HYDRAQ: a proteção só de leitura falhou nesta conversa.' }; }
    }
    process.stdout.write(JSON.stringify(answer));
  });
}
const script = ['const fs = require("fs"), path = require("path");', readOnlyCommand, publicUrl, decide, main, 'main();'].map(String).join('\n');
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

/** agy runs this through `sh -c`. Without Node the shell answers alone: refuse in a read-only conversation, "ask" elsewhere. */
export function guardCommand({ node = process.execPath, directory }) {
  const conversation = `sed -n 's/.*"conversationId" *: *"\\([A-Za-z0-9-]*\\)".*/\\1/p'`;
  return `in=$(cat); printf '%s' "$in" | ${quote(node)} -e ${quote(script)} ${quote(directory)} 2>/dev/null || { id=$(printf '%s' "$in" | ${conversation}); if [ -n "$id" ] && [ -e ${quote(directory)}/"$id".json ]; then printf '%s' '{"decision":"deny","reason":"HYDRAQ: a proteção só de leitura não respondeu."}'; else printf '%s' '{"decision":"ask"}'; fi; }`;
}

const guardEntry = options => ({ PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: guardCommand(options), timeout: 10 }] }] });

/** Adds or updates only HYDRAQ's entry, keeping every other hook. The first change keeps a copy of the original file. */
export async function ensureGuard({ hooksFile, directory, node = process.execPath }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let text = null, hooks = {};
  try { text = await readFile(hooksFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (text?.trim()) {
    try { hooks = JSON.parse(text); } catch { hooks = null; }
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error(`${hooksFile} não é JSON válido; a HYDRAQ não o altera.`);
  }
  const entry = guardEntry({ node, directory });
  if (JSON.stringify(hooks[GUARD_HOOK]) === JSON.stringify(entry)) return false;
  await mkdir(path.dirname(hooksFile), { recursive: true, mode: 0o700 });
  if (text !== null) await copyFile(hooksFile, hooksFile + '.before-hydraq', constants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const temporary = `${hooksFile}.hydraq-${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...hooks, [GUARD_HOOK]: entry }, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, hooksFile);
  return true;
}

// The hook only recognises these identifiers, so a rule under any other name would protect nothing.
const guardable = id => typeof id === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(id);

/** Marks one agy conversation read-only for the next turn and clears the decisions of the previous one. */
export async function openGuard(directory, conversationId, policy = readOnlyPolicy()) {
  if (!guardable(conversationId)) throw new Error('identificador de conversa do agy inesperado.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, conversationId + '.json'), temporary = `${file}.${process.pid}.tmp`;
  await writeFile(path.join(directory, conversationId + '.log'), '', { mode: 0o600 });
  await writeFile(temporary, JSON.stringify(policy), { mode: 0o600 });
  await rename(temporary, file);
}

// Synchronous so that closing one turn can never remove the rule of the turn that follows it.
export function closeGuard(directory, conversationId) {
  if (!guardable(conversationId)) return;
  for (const suffix of ['.json', '.log']) rmSync(path.join(directory, conversationId + suffix), { force: true });
}

export function guardDecisions(directory, conversationId) {
  const decisions = new Map();
  if (!guardable(conversationId)) return decisions;
  let text = '';
  try { text = readFileSync(path.join(directory, conversationId + '.log'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const line of text.split('\n')) { if (!line) continue; try { const entry = JSON.parse(line); decisions.set(entry.stepIdx, entry.decision); } catch {} }
  return decisions;
}
