// What a client is doing, in words: one description shared by the server (progress, Hydra) and the page (progress
// card, Activity, Dual, Hydra). It only reads what each client recorded; the original fields stay as they are,
// because permissions, facts and context handoffs use them too.

const FINISHED_TURN = new Set(['completed', 'failed', 'interrupted', 'uncertain']);
const LIVE_TURN = new Set(['starting', 'running', 'waiting']);
const DONE = new Set(['completed']);
const HYDRA_TOOLS = { initial_position: 'dar a posição inicial', read_dialogue: 'ler o diálogo', send_to_peer: 'escrever ao parceiro', resolve_question: 'responder a uma pergunta', ready_to_conclude: 'dizer que está pronto a concluir', propose_final: 'propor a resposta comum', review_final: 'rever a resposta comum', declare_impasse: 'declarar um impasse' };
const CONTEXT_TOOLS = { get_project_memory: 'Ler a memória do projeto', list_project_conversations: 'Listar as conversas do projeto', search_project_conversations: 'Pesquisar nas conversas do projeto', read_conversation_excerpt: 'Ler um excerto de outra conversa' };
// Each kind in the two forms the page needs: in progress («A ler») and as a line of the request («Ler»).
const KINDS = {
  read: ['A ler', 'Ler'], search: ['A procurar', 'Procurar'], list: ['A listar', 'Listar'], edit: ['A alterar', 'Alterar'],
  command: ['A correr', 'Correr'], web: ['A pesquisar na web', 'Pesquisar na web'], fetch: ['A abrir', 'Abrir'],
  subagent: ['A delegar num subagente', 'Delegar num subagente'], hydra: ['Hydra · a', 'Hydra ·'], context: ['A consultar o projeto', 'Consultar o projeto'],
  question: ['A perguntar-te', 'Perguntar-te'], plan: ['A organizar o trabalho', 'Organizar o trabalho'], reasoning: ['A pensar', 'Raciocínio'], tool: ['A usar', 'Usar'],
};

export const actionState = item => {
  if (item.permissionDenied || item.denied || item.status === 'declined') return 'declined';
  if (item.status === 'completed' && typeof item.exitCode === 'number' && item.exitCode !== 0) return 'failed';
  if (item.status === 'cancelled') return 'interrupted';
  return item.status || 'inProgress';
};
const text = value => typeof value === 'string' ? value.trim() : '';
const first = (object, ...keys) => { for (const key of keys) { const value = text(object?.[key]); if (value) return value; } return ''; };
const lines = (start, end) => { const a = Number(start), b = Number(end); return Number.isFinite(a) && a > 0 ? (Number.isFinite(b) && b >= a ? `${a}–${b}` : `${a}…`) : ''; };
const toolName = item => String(item.tool || '');
// Task lists under each client's naming: Claude Code (TodoWrite, Task*), Cursor (updateTodos).
const PLAN_TOOLS = /^(TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet)$|^todo|^Update TODOs/i;
// Codex runs commands through a login shell; the command shown is the one inside it.
const unwrap = command => { const match = /^(?:\/usr)?(?:\/bin\/)?(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/.exec(String(command || '').trim()); return match ? match[2] : String(command || ''); };

/**
 * Kind and detail of one action. `path` is the file or folder concerned, when there is one; `query` is what was searched.
 * Paths stay absolute here; the page shortens them against the conversation's folder.
 */
export function describeAction(item) {
  const params = item.parameters || item.arguments || {}, tool = toolName(item), server = String(item.server || '');
  const result = (kind, detail = '', extra = {}) => ({ kind, detail: String(detail).replace(/\s+/g, ' ').trim().slice(0, 300), ...extra });
  // Hydra and project context tools, under any client's naming: mcp__server__tool (Claude), server/tool (Codex, agy).
  const hydraMatch = /^mcp__hydraq_cx_[^_]+_[a-z]+__(.+)$/.exec(tool), hydraTool = hydraMatch?.[1] || (/^hydraq_cx_/.test(server) || server === 'hydraq' || HYDRA_TOOLS[tool] ? tool : '');
  if (hydraTool && HYDRA_TOOLS[hydraTool]) return result('hydra', HYDRA_TOOLS[hydraTool], { tool: hydraTool });
  const contextTool = Object.keys(CONTEXT_TOOLS).find(name => tool === name || tool.endsWith('__' + name));
  if (contextTool) return result('context', CONTEXT_TOOLS[contextTool], { tool: contextTool });
  if (item.type === 'reasoning') return result('reasoning', reasoningText(item));
  if (item.type === 'plan' || PLAN_TOOLS.test(tool) || params._toolName === 'updateTodos') return result('plan', item.planDetail || '');
  if (item.type === 'subagent') return result('subagent', item.detail || (item.subagents || []).join(', '));
  if (tool === 'AskUserQuestion') return result('question');
  // Cursor and OpenCode (ACP) say what kind of action it is; their title is already readable.
  const kind = item.nativeKind, location = text(item.locations?.[0]?.path) || first(params, 'path', 'filePath', 'file_path');
  if (kind === 'read') return result('read', location || tool, { path: location || null });
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return result('edit', location || tool, { path: location || null });
  if (kind === 'search') { const query = first(params, 'pattern', 'query'); return result('search', query ? `${/glob/i.test(tool) ? 'ficheiros ' : ''}«${query}»` : tool, { query: query || null, path: location || null }); }
  if (kind === 'execute') return result('command', first(params, 'command') || item.command || tool, { command: first(params, 'command') || item.command || tool });
  if (kind === 'fetch') return result('fetch', first(params, 'url') || tool);
  if (kind === 'think') return result('reasoning');
  if (item.type === 'fileChange') { const paths = (item.changes || []).map(change => text(change.path)).filter(Boolean); return result('edit', paths.join(', '), { path: paths[0] || null, paths }); }
  if (item.type === 'commandExecution') {
    // Codex parses the command: a single read, listing or search is shown as such.
    const actions = (item.commandActions || []).filter(action => action.type !== 'unknown');
    if (actions.length === 1 && (item.commandActions || []).length === 1) {
      const action = actions[0];
      if (action.type === 'read' && action.path) return result('read', action.path, { path: action.path, command: item.command });
      if (action.type === 'listFiles') return result('list', action.path || '.', { path: action.path || null, command: item.command });
      if (action.type === 'search') return result('search', [action.query && `«${action.query}»`, action.path && `em ${action.path}`].filter(Boolean).join(' '), { query: action.query || null, path: action.path || null, command: item.command });
    }
    return result('command', unwrap(item.command) || tool, { command: unwrap(item.command) || tool });
  }
  if (item.type === 'webSearch' && !kind) {
    const url = first(params, 'url', 'Url');
    const query = text(item.query) || first(params, 'query', 'Query');
    return url ? result('fetch', url) : result('web', query && `«${query}»`, { query: query || null });
  }
  // Claude Code, Antigravity and OpenCode tools by name.
  const path = first(params, 'file_path', 'filePath', 'Path', 'AbsolutePath', 'TargetFile', 'path', 'notebook_path');
  if (/^(Read|read|read_file|view_file|view_code_item)$/.test(tool)) return result('read', [path, lines(params.offset ?? params.StartLine, params.limit ? Number(params.offset || 1) + Number(params.limit) - 1 : params.EndLine)].filter(Boolean).join(' · '), { path: path || null });
  if (/^(Grep|grep|grep_search|codebase_search|search_files)$/.test(tool)) { const query = first(params, 'pattern', 'Query', 'query'), where = first(params, 'path', 'SearchPath', 'SearchDirectory'); return result('search', [query && `«${query}»`, where && `em ${where}`].filter(Boolean).join(' '), { query: query || null, path: where || null }); }
  if (/^(Glob|glob|find_by_name)$/.test(tool)) { const pattern = first(params, 'pattern', 'Pattern'), where = first(params, 'path', 'SearchDirectory'); return result('search', [pattern && `ficheiros «${pattern}»`, where && `em ${where}`].filter(Boolean).join(' '), { query: pattern || null, path: where || null }); }
  if (/^(LS|ls|list|list_dir)$/.test(tool)) { const where = first(params, 'path', 'DirectoryPath'); return result('list', where || '.', { path: where || null }); }
  if (/^(WebSearch|websearch|search_web)$/.test(tool)) { const query = first(params, 'query', 'Query'); return result('web', query && `«${query}»`, { query: query || null }); }
  if (tool === 'task') return result('subagent', first(params, 'description', 'subagent_type'));
  if (/^(WebFetch|webfetch|read_url_content)$/.test(tool)) return result('fetch', first(params, 'url', 'Url'));
  if (item.type === 'mcpToolCall' || item.type === 'nativeTool') {
    const title = first(params, 'title'), label = [server && !/^(Claude Code|Antigravity|OpenCode|Cursor)$/.test(server) ? server : '', tool.replace(/^mcp__/, '').replace(/__/g, ' / ')].filter(Boolean).join(' / ');
    return result('tool', title || item.summary && text(String(item.summary)) && `${label} · ${String(item.summary)}` || label || 'ferramenta');
  }
  return result('tool', item.type || 'ação');
}

/** The phrase for an action: «A ler public/app.js» while it runs, «Ler public/app.js» in a list. */
export function actionPhrase(item, { live = false, cwd = '' } = {}) {
  const { kind, detail } = describeAction(item), [doing, line] = KINDS[kind] || KINDS.tool;
  const shown = shortPaths(detail, cwd);
  if (kind === 'hydra') return `${live ? doing : line} ${shown}`;
  if (kind === 'reasoning') return [live ? doing : line, shown.length > 160 ? shown.slice(0, 159) + '…' : shown].filter(Boolean).join(' · ');
  if (kind === 'context' || kind === 'plan' || kind === 'question') return live ? (kind === 'context' ? `A ${shown.charAt(0).toLowerCase()}${shown.slice(1)}` : doing) : (shown || line);
  return [live ? doing : line, shown].filter(Boolean).join(' ');
}
/** Paths inside the conversation's folder are shown relative to it. */
export function shortPaths(value, cwd) {
  if (!cwd) return value;
  const root = cwd.endsWith('/') ? cwd : cwd + '/';
  return String(value).split(root).join('');
}

/**
 * Duration of an action. A client's own measure counts as native; otherwise the time between the events HYDRAQ
 * received, marked as measured. No end, no duration: an interrupted or old action keeps none.
 */
export function actionDuration(item) {
  if (Number.isFinite(item.durationMs) && item.durationMs >= 0) return { ms: item.durationMs, measured: false };
  const start = Date.parse(item.at || ''), end = Date.parse(item.completedAt || '');
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start && actionState(item) !== 'interrupted') return { ms: end - start, measured: true };
  return null;
}
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 100) return '< 0,1 s';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** The reasoning text a client sent (Codex and Claude summaries, Gemini summaries, Grok thoughts); empty when it sent none. */
export function reasoningText(item) {
  return (Array.isArray(item.summary) ? item.summary.join('\n\n') : text(item.summary)).trim();
}
// Clients whose reasoning text HYDRAQ keeps, and what it is: Claude and agy send summaries, Cursor its thoughts.
// agy and Cursor show their reasoning open while the request runs (as asked for both).
const THOUGHTS = { claude: { label: 'Resumo do raciocínio · Claude' }, antigravity: { label: 'Resumo do raciocínio · Antigravity', openWhileLive: true }, cursor: { label: 'Raciocínio · Cursor', openWhileLive: true } };
/** The heading for a client's reasoning, or '' for one whose text is not shown. */
export const thoughtLabel = provider => THOUGHTS[provider]?.label || '';
export const thoughtOpensLive = provider => Boolean(THOUGHTS[provider]?.openWhileLive);
/**
 * Whether the reasoning box is open: the person's choice while the request stays in the same phase (running or
 * finished); otherwise open while a client like agy works and closed once the answer is ready; else as it was.
 */
export function thoughtOpen(provider, live, choice, previous) {
  if (choice && choice.live === live) return choice.open;
  return thoughtOpensLive(provider) ? live : previous;
}
/** The latest reasoning with text in a request, ending with what arrived last. */
export function latestThought(conversation, turn, size = 600) {
  const thought = reasoningText(turnActions(conversation, turn).findLast(item => item.type === 'reasoning' && reasoningText(item)) || {});
  return thought.length > size ? '…' + thought.slice(-size + 1) : thought;
}

/** Actions of one turn, in order; reasoning and messages are not actions. */
export function turnActions(conversation, turn) {
  return (conversation?.items || []).filter(item => turn && item.turnId === turn.id && !['userMessage', 'agentMessage'].includes(item.type));
}
/** The actions still running: only while the turn itself runs; a finished turn leaves none running. */
export function activeActions(conversation, turn) {
  if (!turn || !LIVE_TURN.has(turn.status)) return [];
  return turnActions(conversation, turn).filter(item => actionState(item) === 'inProgress' && item.type !== 'reasoning');
}

/**
 * What the request did, counting only what was confirmed: distinct files read or changed, commands by result, searches
 * in the project apart from the web, refused attempts apart from failures.
 */
export function requestSummary(conversation, turn) {
  const files = { read: new Set(), changed: new Set() }, count = { commands: 0, commandsFailed: 0, searches: 0, web: 0, tools: 0, subagents: 0, hydra: 0, refused: 0, editsRefused: 0, failed: 0 };
  for (const item of turnActions(conversation, turn)) {
    const state = actionState(item), action = describeAction(item);
    if (action.kind === 'reasoning' || action.kind === 'plan') continue;
    if (state === 'declined') { count.refused++; if (action.kind === 'edit') count.editsRefused++; continue; }
    if (action.kind === 'command') { if (state === 'completed') count.commands++; else if (state === 'failed') { count.commands++; count.commandsFailed++; } continue; }
    if (state === 'failed') { count.failed++; continue; }
    if (!DONE.has(state)) continue;
    if (action.kind === 'read' && action.path) files.read.add(action.path);
    else if (action.kind === 'edit') for (const path of action.paths || [action.path]) { if (path) files.changed.add(path); }
    else if (action.kind === 'search' || action.kind === 'list') count.searches++;
    else if (action.kind === 'web' || action.kind === 'fetch') count.web++;
    else if (action.kind === 'subagent') count.subagents++;
    else if (action.kind === 'hydra') count.hydra++;
    else count.tools++;
  }
  const start = Date.parse(turn?.startedAt || ''), end = Date.parse(turn?.completedAt || '');
  return { filesRead: files.read.size, filesChanged: files.changed.size, ...count, durationMs: FINISHED_TURN.has(turn?.status) && Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null };
}
/** The summary in one line: «Leu 6 ficheiros · alterou 2 · 3 comandos (1 falhou) · …». */
export function summaryLine(summary) {
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return [
    summary.filesRead && `leu ${plural(summary.filesRead, 'ficheiro', 'ficheiros')}`,
    summary.filesChanged && `alterou ${plural(summary.filesChanged, 'ficheiro', 'ficheiros')}`,
    summary.commands && `${plural(summary.commands, 'comando', 'comandos')}${summary.commandsFailed ? ` (${summary.commandsFailed} ${summary.commandsFailed === 1 ? 'falhou' : 'falharam'})` : ''}`,
    summary.searches && plural(summary.searches, 'pesquisa no projeto', 'pesquisas no projeto'),
    summary.web && plural(summary.web, 'pesquisa na web', 'pesquisas na web'),
    summary.tools && plural(summary.tools, 'ferramenta', 'ferramentas'),
    summary.hydra && plural(summary.hydra, 'passo do Hydra', 'passos do Hydra'),
    summary.subagents && plural(summary.subagents, 'subagente', 'subagentes'),
    summary.editsRefused && plural(summary.editsRefused, 'alteração recusada', 'alterações recusadas'),
    summary.refused - summary.editsRefused > 0 && plural(summary.refused - summary.editsRefused, 'ação recusada', 'ações recusadas'),
    summary.failed && plural(summary.failed, 'ação com erro', 'ações com erro'),
    summary.durationMs !== null && formatDuration(summary.durationMs),
  ].filter(Boolean).join(' · ').replace(/^./, letter => letter.toUpperCase());
}

/**
 * What the request is doing now, without guessing: the running actions; text arriving; a decision pending; a
 * reasoning event the client itself sent; otherwise «a trabalhar», with no detail claimed.
 */
export function currentWork(conversation, turn) {
  if (!turn) return null;
  if (turn.status === 'starting') return { state: 'starting', title: 'A iniciar o pedido' };
  if (turn.status === 'waiting') return { state: 'waiting', title: 'A aguardar a tua decisão', detail: 'Há uma autorização ou pergunta pendente.' };
  if (!LIVE_TURN.has(turn.status)) return null;
  const active = activeActions(conversation, turn);
  if (active.length) return { state: 'actions', title: active.length > 1 ? `${active.length} ações em curso` : actionPhrase(active[0], { live: true, cwd: conversation.cwd }), actions: active, since: active.length === 1 ? active[0].at : null };
  if ((conversation.messages || []).some(message => message.role === 'assistant' && message.turnId === turn.id && message.streaming)) return { state: 'writing', title: 'A escrever a resposta' };
  if (turnActions(conversation, turn).some(item => item.type === 'reasoning' && actionState(item) === 'inProgress')) return { state: 'reasoning', title: 'A pensar' };
  return { state: 'working', title: 'A trabalhar · sem atividade detalhada' };
}
