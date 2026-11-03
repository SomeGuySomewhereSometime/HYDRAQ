import { mkdir, readFile, writeFile, rename, copyFile, constants } from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { shellQuote, homeBinaries, toolFolders, externalGitFolder, confinedCommand, writablePath } from './command-sandbox.mjs';

// agy ignores `--mode plan` while slash commands are disabled, and its real plan mode never calls MCP tools.
// Read-only comes from HYDRAQ's own entry in agy's global hooks.json instead: agy runs it before every tool, in
// every session. It acts only on conversations HYDRAQ has marked read-only and answers "ask" (agy's normal
// permission flow) everywhere else. A failing or missing hook makes agy refuse the tool.
export const GUARD_HOOK = 'hydraq';

export function guardPaths(home = os.homedir()) {
  const config = path.join(home, '.gemini', 'config'), state = path.join(home, '.local', 'state', 'hydraq');
  return { hooksFile: path.join(config, 'hooks.json'), directory: path.join(state, 'agy-guard'), mcpFile: path.join(config, 'mcp_config.json'), routeDirectory: path.join(state, 'agy-route') };
}

const readTools = ['read_file', 'view_file', 'list_dir', 'find_by_name', 'grep_search', 'search_web', 'view_code_item', 'codebase_search', 'command_status'];
export function readOnlyPolicy(cwd = null) {
  return { version: 1, reason: 'HYDRAQ: esta conversa está em Planear/Só leitura.', tools: readTools, mcp: {}, cwd };
}
/** A Hydra round: read-only, plus exactly the tools of its task on HYDRAQ's own MCP server. */
export function hydraPolicy(names,{write=false,cwd=null,origin=null}={}) {
  return { ...readOnlyPolicy(), write, cwd, ...(origin ? { origin } : {}), reason: write?'HYDRAQ: principal autorizado a implementar o plano nesta fase.':'HYDRAQ: ronda Hydra, só análise e diálogo com os colegas.', mcp: { [GUARD_HOOK]: [...names] } };
}

/** The words agy's `bash -c` passes on, for a line already free of $, `, \ and operators: there quotes only group, so
 *  -de''lete and "-del"ete both reach the program as -delete. Null for an unterminated quote. `glob` marks a word
 *  with an unquoted *, ? or [, which the shell may replace by file names. */
export function shellWords(line) {
  const words = [];
  let word = null, quote = null, glob = false;
  for (const char of line) {
    if (quote) { if (char === quote) quote = null; else word += char; continue; }
    if (char === ' ' || char === '\t') { if (word !== null) words.push({ text: word, glob }); word = null; glob = false; continue; }
    if (word === null && char === '#') break;
    word ??= '';
    if (char === "'" || char === '"') quote = char;
    else { if ('*?['.includes(char)) glob = true; word += char; }
  }
  if (quote) return null;
  if (word !== null) words.push({ text: word, glob });
  return words;
}

/** A single read-only command: no shell operators, substitutions or redirections, and no flags that write or run programs.
 *  Only programs without such options are listed; file (-C), tree (-R, -o), sort (-o, --compress-program) and date (-s)
 *  are left out, and the remaining exceptions are refused by flag, on the words as the shell passes them. */
export function readOnlyCommand(line) {
  if (typeof line !== 'string' || !line.trim() || line.length > 2000 || /[;&|<>`$\\(){}\x00-\x08\x0a-\x1f\x7f]/.test(line)) return false;
  const parsed = shellWords(line);
  if (!parsed?.length) return false;
  const words = parsed.map(word => word.text), [command, sub] = words;
  if (!['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'stat', 'pwd', 'du', 'realpath', 'dirname', 'basename', 'echo', 'which', 'nl', 'cut', 'diff', 'cmp', 'jq', 'git'].includes(command)) return false;
  // Only find, rg and git have such flags; an unquoted pattern could turn a file named -delete into one.
  if (['find', 'rg', 'git'].includes(command) && parsed.some(word => word.glob)) return false;
  const has = (...flags) => words.some(word => flags.some(flag => word === flag || word.startsWith(flag + '=')));
  if (command === 'find' && has('-exec', '-execdir', '-ok', '-okdir', '-delete', '-rm', '-fprint', '-fprint0', '-fprintf', '-fls')) return false;
  if (command === 'rg' && has('--pre', '--hostname-bin')) return false;
  if (command === 'git') {
    if (!['status', 'log', 'diff', 'show', 'ls-files', 'ls-tree', 'grep', 'blame', 'rev-parse', 'describe', 'shortlog', 'cat-file'].includes(sub)) return false;
    // git grep, ls-files and cat-file take any unambiguous abbreviation (--op for --open-files-in-pager) and joined short flags (-nO).
    const risky = ['output', 'ext-diff', 'textconv', 'filters', 'open-files-in-pager'];
    const long = word => word.startsWith('--') && word.slice(2).split('=')[0];
    if (words.slice(2).some(word => { const name = long(word); return name ? risky.some(option => option.startsWith(name) || name.startsWith(option)) : /^-[^-]*O/.test(word); })) return false;
  }
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
  // agy keeps a long command's full output there and tells the model to read it.
  const notes = typeof input.artifactDirectoryPath === 'string' && path.isAbsolute(input.artifactDirectoryPath) ? [input.artifactDirectoryPath] : [];
  const fileTool = ['write_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'edit_file'].includes(name), target = args.Path ?? args.TargetFile ?? args.file_path;
  // The principal: every command runs confined, whatever it asks for. File tools run inside agy, so their target is checked here.
  if (policy.write && name === 'run_command') return typeof args.CommandLine === 'string' && args.CommandLine.trim() && policy.cwd ? { decision: 'allow', overwrite: { CommandLine: confinedCommand(args.CommandLine, policy.cwd, true, notes, policy.origin || null) } } : deny('Comando inválido.');
  if (policy.write && fileTool && writablePath(target, policy.cwd)) return { decision: 'ask' };
  if (policy.tools.includes(name)) return { decision: 'ask' };
  // The filter says what may be asked for; only the sandbox guarantees it: Git, for one, runs what a repository configures.
  if (name === 'run_command') return readOnlyCommand(args.CommandLine) ? { decision: 'allow', overwrite: { CommandLine: confinedCommand(args.CommandLine, policy.cwd || args.Cwd, false, notes, policy.origin || null) } } : deny('Só são permitidos comandos simples de leitura (por exemplo ls, cat, grep, find, git status/log/diff/show), sem ;, |, &, redirecionamentos ou substituições.');
  if (name === 'call_mcp_tool') return (policy.mcp[args.ServerName] || []).includes(args.ToolName) ? { decision: 'ask' } : deny('Este servidor ou ferramenta MCP não está disponível.');
  if (name === 'read_url_content') return publicUrl(args.Url ?? args.url) ? { decision: 'ask' } : deny('Só são permitidos endereços públicos http ou https.');
  if (fileTool) {
    // agy keeps its own plans and notes in the conversation's artifact folder; the project stays untouched.
    const artifacts = input.artifactDirectoryPath;
    if (typeof target === 'string' && typeof artifacts === 'string' && path.isAbsolute(target) && path.isAbsolute(artifacts) && path.resolve(target).startsWith(path.resolve(artifacts) + path.sep)) return { decision: 'ask' };
    return deny(policy.write ? 'Só podes alterar ficheiros dentro do projeto, fora de .git e .hydraq.' : 'Não pode criar nem alterar ficheiros.');
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
const script = ['const fs = require("fs"), os = require("os"), path = require("path");', shellWords, readOnlyCommand, publicUrl, shellQuote, homeBinaries, toolFolders, externalGitFolder, confinedCommand, writablePath, decide, main, 'main();'].map(String).join('\n');
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

/** agy runs this through `sh -c`. Without Node the shell answers alone: refuse in a read-only conversation, "ask" elsewhere. */
export function guardCommand({ node = process.execPath, directory }) {
  const conversation = `sed -n 's/.*"conversationId" *: *"\\([A-Za-z0-9-]*\\)".*/\\1/p'`;
  return `in=$(cat); printf '%s' "$in" | ${quote(node)} -e ${quote(script)} ${quote(directory)} 2>/dev/null || { id=$(printf '%s' "$in" | ${conversation}); if [ -n "$id" ] && [ -e ${quote(directory)}/"$id".json ]; then printf '%s' '{"decision":"deny","reason":"HYDRAQ: a proteção só de leitura não respondeu."}'; else printf '%s' '{"decision":"ask"}'; fi; }`;
}

const guardEntry = options => ({ PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: guardCommand(options), timeout: 10 }] }] });

/** Sets one entry of an agy JSON configuration, keeping the rest. The first change to a file with the user's own
 *  content keeps a copy of it; a file that only holds HYDRAQ's entry has nothing of the user's to keep. */
async function ensureEntry(file, read, write, entry, onlyOurs) {
  let text = null, data = {};
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (text?.trim()) {
    try { data = JSON.parse(text); } catch { data = null; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} não é JSON válido; a HYDRAQ não o altera.`);
  }
  if (JSON.stringify(read(data)) === JSON.stringify(entry)) return false;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (text?.trim() && !onlyOurs(data)) await copyFile(file, file + '.before-hydraq', constants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const temporary = `${file}.hydraq-${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(write(data), null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
  return true;
}

/** Adds or updates only HYDRAQ's hook, keeping every other hook. */
export async function ensureGuard({ hooksFile, directory, node = process.execPath }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = guardEntry({ node, directory });
  return ensureEntry(hooksFile, hooks => hooks[GUARD_HOOK], hooks => ({ ...hooks, [GUARD_HOOK]: entry }), entry, hooks => Object.keys(hooks).every(key => key === GUARD_HOOK));
}

// agy reads MCP servers only from its global configuration, so the Hydra server is registered there once, for every
// session. It answers a call only when HYDRAQ has routed that conversation to a task; elsewhere its tools refuse.
const routeServer = fileURLToPath(new URL('./claudex-mcp-server.mjs', import.meta.url));
export async function ensureMcpRoute({ mcpFile, directory, node = process.execPath }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = { command: node, args: [routeServer, '--route', directory] };
  return ensureEntry(mcpFile, config => config.mcpServers?.[GUARD_HOOK], config => ({ ...config, mcpServers: { ...(config.mcpServers || {}), [GUARD_HOOK]: entry } }), entry,
    config => Object.keys(config).every(key => key === 'mcpServers') && Object.keys(config.mcpServers || {}).every(key => key === GUARD_HOOK));
}
/** Gives one agy conversation the task lease (url, token, tools) for the length of a turn. */
export async function openRoute(directory, conversationId, lease) {
  if (!guardable(conversationId)) throw new Error('identificador de conversa do agy inesperado.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, conversationId + '.json'), temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(lease), { mode: 0o600 });
  await rename(temporary, file);
}
export function closeRoute(directory, conversationId) { if (guardable(conversationId)) rmSync(path.join(directory, conversationId + '.json'), { force: true }); }

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
