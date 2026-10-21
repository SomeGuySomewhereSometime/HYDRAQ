const clip = (text, size) => String(text ?? '').slice(0, size);

// Keep compact observations independently of the 200-item display window. Updates replace
// the same action so that a refusal or a later exit code cannot be counted as success.
export function observeAction(conversation, turn, item) {
  if (!turn || !item?.id) return;
  const observation = {
    type: item.type, status: item.status || 'inProgress',
    declined: Boolean(item.permissionDenied || item.denied || item.status === 'declined'),
    files: item.type === 'fileChange' ? (item.changes || []).map(change => change.path).filter(Boolean).map(String) : [],
    ...(item.type === 'commandExecution' ? { command: clip(item.command, 2000), exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null } : {}),
  };
  const actions = turn.actionFacts ||= {};
  if (JSON.stringify(actions[item.id]) !== JSON.stringify(observation)) {
    actions[item.id] = observation;
    if (turn.facts) turn.facts = null;
  }
}

export function turnFacts(conversation, turn) {
  for (const item of conversation.items || []) if (item.turnId && item.turnId === turn.id) observeAction(conversation, turn, item);
  const actions = Object.values(turn.actionFacts || {});
  const latest = conversation.turns.at(-1) === turn;
  const files = new Set(actions.filter(action => action.type === 'fileChange' && action.status === 'completed' && !action.declined).flatMap(action => action.files));
  // A native diff is an additional observation of applied edits, never of proposed edits.
  if (latest) for (const match of String(conversation.diff || '').matchAll(/^diff --git a\/(\S+) b\//gm)) files.add(match[1]);
  return {
    version: 2, files: [...files],
    commands: actions.filter(action => action.type === 'commandExecution').map(action => ({ command: action.command, exitCode: action.exitCode, status: action.status })),
    declined: actions.filter(action => action.declined).length,
    error: ['failed', 'uncertain'].includes(turn.status) && latest ? clip(conversation.error, 600) || null : null,
    capturedAt: new Date().toISOString(),
  };
}
