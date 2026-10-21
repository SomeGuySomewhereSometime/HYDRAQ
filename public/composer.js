export function canSteer(conversation) {
  return Boolean(conversation?.capabilities?.steer !== false && conversation?.provider !== 'antigravity' && conversation?.turnId && ['running', 'waiting'].includes(conversation.status));
}

// Capture the intended operation when writing starts, before the turn can finish.
export function captureDraftIntent(intent, text, conversation) {
  if (!text.trim()) return null;
  if (intent) return intent;
  return canSteer(conversation)
    ? { kind: 'steer', conversationId: conversation.id, turnId: conversation.turnId }
    : { kind: 'send' };
}

export function draftMode(intent, conversation) {
  if (!intent) return canSteer(conversation) ? 'steer' : 'send';
  if (intent.kind !== 'steer') return 'send';
  return canSteer(conversation) && intent.conversationId === conversation.id && intent.turnId === conversation.turnId
    ? 'steer' : 'expired-steer';
}
