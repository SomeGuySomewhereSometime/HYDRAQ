export const followupDescriptions = {
  steer: ['Orientar', 'Acrescenta uma orientação ao pedido em curso, sem o cancelar. No OpenCode entra na próxima fronteira entre passos; não interrompe uma resposta ou ferramenta já em execução.'],
  next: ['Orientar na próxima oportunidade', 'O Claude recebe a orientação quando terminarem as ferramentas em curso; pode seguir no próximo ciclo se o atual terminar primeiro.'],
  now: ['Redirecionar agora', 'O Claude reage imediatamente: pode interromper a resposta ou passar ferramentas para segundo plano. Não aprova ações pendentes.'],
  redirect: ['Redirecionar agora', 'Interrompe o Antigravity e continua na mesma sessão apenas após confirmar a paragem. Não desfaz ações já executadas.'],
  queue: ['Enviar depois', 'Guarda a mensagem no HYDRAQ e envia-a após a conclusão do pedido, com as escolhas atuais da sessão. Uma falha ou reinício exige revisão.'],
};
export function followupOptions(conversation) {
  return conversation?.capabilities?.followupModes || (conversation?.capabilities?.steer !== false && conversation?.provider !== 'antigravity' ? ['steer'] : []);
}
export function canSteer(conversation) { return Boolean(followupOptions(conversation).length && conversation?.turnId && ['running', 'waiting'].includes(conversation.status)); }

// Capture the intended operation when writing starts, before the turn can finish.
export function captureDraftIntent(intent, text, conversation, deliveryMode) {
  if (!text.trim()) return null;
  if (intent) return intent;
  return canSteer(conversation)
    ? { kind: 'steer', conversationId: conversation.id, turnId: conversation.turnId, ...(deliveryMode ? {deliveryMode} : {}) }
    : { kind: 'send' };
}

export function draftMode(intent, conversation) {
  if (!intent) return canSteer(conversation) ? 'steer' : 'send';
  if (intent.kind !== 'steer') return 'send';
  return canSteer(conversation) && intent.conversationId === conversation.id && intent.turnId === conversation.turnId
    ? 'steer' : 'expired-steer';
}
