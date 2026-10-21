const finished = new Set(['completed', 'failed', 'interrupted', 'uncertain']);
const actionTypesToSkip = new Set(['reasoning', 'plan', 'userMessage', 'agentMessage']);

export function actionStatus(item) {
  if (item.status === 'completed' && typeof item.exitCode === 'number' && item.exitCode !== 0) return 'failed';
  return item.status || 'inProgress';
}

function describe(item) {
  if (item.type === 'commandExecution') return { title: 'A executar um comando', detail: item.command || 'Comando do projeto' };
  if (item.type === 'fileChange') return { title: 'A alterar ficheiros', detail: (item.changes || []).map(change => change.path).join(', ') };
  if (item.type === 'webSearch') return { title: 'A pesquisar na web', detail: item.query || '' };
  if (item.type === 'subagent') return { title: 'A delegar em subagentes', detail: item.detail || (item.subagents || []).join(', ') || 'Subagente' };
  if (item.type === 'mcpToolCall') return { title: 'A usar uma ferramenta', detail: [item.server, item.tool].filter(Boolean).join(' / ') };
  if (item.type === 'reasoning') return { title: 'A analisar o pedido', detail: '' };
  return { title: 'A trabalhar no pedido', detail: item.type || '' };
}

/** Public messages, native plans and tool events only; no inferred completion percentages. */
export function summarizeProgress(conversation) {
  const turn = conversation.turns?.at(-1);
  if (!turn) return null;
  const status = turn.status;
  const agent = { antigravity: 'Antigravity', claude: 'Claude Code', cursor: 'Cursor' }[conversation.provider] || 'Codex';
  const items = conversation.items.filter(item => item.turnId && item.turnId === turn.id);
  const actions = items.filter(item => !actionTypesToSkip.has(item.type));
  const counts = { completed: 0, running: 0, failed: 0, declined: 0, interrupted: 0 };
  for (const item of actions) {
    const state = actionStatus(item);
    if (state === 'completed') counts.completed++;
    else if (state === 'failed') counts.failed++;
    else if (state === 'declined') counts.declined++;
    else if (state === 'interrupted' || state === 'cancelled') counts.interrupted++;
    else if (!finished.has(status)) counts.running++;
  }
  const steps = turn.plan?.steps || [];
  const currentStep = steps.find(step => step.status === 'inProgress');
  const commentary = conversation.messages.findLast(message => message.role === 'assistant' && message.turnId === turn.id && message.phase === 'commentary');
  const activeItem = [...items].reverse().find(item => actionStatus(item) === 'inProgress');
  let activity = activeItem ? describe(activeItem) : {
    title: currentStep ? 'Em curso' : `${agent} a trabalhar`,
    detail: currentStep?.step || '',
  };
  if (status === 'starting') activity = { title: 'A iniciar o pedido', detail: `A preparar a sessão ${agent}.` };
  if (status === 'waiting') activity = { title: 'A aguardar a tua resposta', detail: 'Há uma autorização ou pergunta pendente.' };
  if (status === 'completed') activity = { title: 'Pedido concluído', detail: `O ${agent} terminou este pedido.` };
  if (status === 'failed') activity = { title: 'Pedido terminou com erro', detail: conversation.error || '' };
  if (status === 'interrupted') activity = { title: 'Pedido interrompido', detail: 'O trabalho realizado mantém-se no histórico.' };
  if (status === 'uncertain') activity = { title: 'Estado por confirmar', detail: 'A ligação terminou sem confirmação do resultado.' };
  return {
    turnId: turn.id, status, ...activity, counts, steps,
    explanation: turn.plan?.explanation || null,
    commentary: commentary?.text?.slice(-1800) || null,
    completedSteps: steps.filter(step => step.status === 'completed').length,
    actions: actions.slice(-30).map(item => ({ id: item.id, status: finished.has(status) && actionStatus(item) === 'inProgress' ? 'unfinished' : actionStatus(item), type: item.type, detail: describe(item).detail, at: item.at })),
  };
}
