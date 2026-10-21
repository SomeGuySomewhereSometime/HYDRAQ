export const uncertaintyKey = conversation => conversation.turns?.findLast(turn => turn.status === 'uncertain')?.requestId || conversation.updatedAt;
export const needsUncertaintyReview = conversation => conversation.status === 'uncertain' && conversation.uncertaintyReview?.key !== uncertaintyKey(conversation);
export const reviewedTurn = (conversation, turn) => turn.status === 'uncertain' && conversation.uncertaintyReview?.requestIds?.includes(turn.requestId);
