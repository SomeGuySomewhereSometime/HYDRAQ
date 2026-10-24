/** Attach terminal MCP reads to the imported request whose native calls match them. Reads matching calls
 * of more than one request stay explicitly unattributed: time alone never decides ownership. */
const canonical = value => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
export const terminalReadKey = (server, tool, args) => canonical([server, tool, canonical(args || {})]);

export function attachTerminalContextReads(conversation, parsedTurns) {
  const pending = conversation.terminal?.contextReads || [];
  if (!pending.length) return;
  const calls = new Map(), reads = new Map();
  for (const parsed of parsedTurns) {
    const key = parsed.prompt?.uuid || parsed.messages[0]?.id || parsed.tools[0]?.id;
    const turn = conversation.turns.find(item => item.requestId === `terminal:${key}`);
    if (!turn) continue;
    for (const tool of parsed.tools) {
      const read = pending.find(read => tool.name === `mcp__${read.server}__${read.tool}`);
      if (!read) continue;
      const match = terminalReadKey(read.server, read.tool, tool.input);
      calls.set(match, [...(calls.get(match) || []), {turn, tool}]);
    }
  }
  for (const read of pending) {
    const key = terminalReadKey(read.server, read.tool, read.arguments);
    reads.set(key, [...(reads.get(key) || []), read]);
  }
  conversation.terminal.contextReads = pending.filter(read => {
    const key = terminalReadKey(read.server, read.tool, read.arguments), candidates = calls.get(key) || [];
    const turns = new Set(candidates.map(candidate => candidate.turn));
    if (turns.size !== 1) return true;
    const [turn] = turns, first = candidates.map(candidate => candidate.tool.at).filter(Boolean).sort()[0];
    // Each read must fall inside that request; a subagent's read in it belongs to the same request.
    if (first && read.at < first || turn.completedAt && read.at > turn.completedAt) return true;
    // Only a single read for a single call names the native call; repeated ones name just the request.
    const exact = candidates.length === 1 && reads.get(key).length === 1;
    turn.contextReads ||= [];
    if (!turn.contextReads.some(item => item.id === read.id)) turn.contextReads.push({...read,
      ...(exact ? {nativeToolCallId: candidates[0].tool.id, association: 'tool-and-arguments'} : {association: 'request', nativeCalls: candidates.length})});
    return false;
  });
}
