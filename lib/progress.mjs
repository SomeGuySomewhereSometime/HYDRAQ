import { actionPhrase, currentWork, latestThought } from '../public/actions.js';

const finished = new Set(['completed', 'failed', 'interrupted', 'uncertain']);
const actionTypesToSkip = new Set(['reasoning', 'plan', 'userMessage', 'agentMessage']);

const TASK_STATES = { pending: 'pending', in_progress: 'inProgress', inProgress: 'inProgress', completed: 'completed' };
/**
 * A client's task list as the request's plan: the list lives in the session, so a task finished in an earlier
 * request is left out; one still open, or touched in this request, is shown.
 */
export function taskPlan(tasks, turn) {
  const steps = (tasks || []).filter(task => task.status !== 'completed' || task.turnId === turn.id).map(task => ({ step: String(task.subject || '').slice(0, 500), status: TASK_STATES[task.status] || 'pending' })).filter(step => step.step);
  return steps.length ? { steps } : null;
}

export function actionStatus(item) {
  if (item.status === 'completed' && typeof item.exitCode === 'number' && item.exitCode !== 0) return 'failed';
  return item.status || 'inProgress';
}

/**
 * Public messages, native plans and tool events only; no inferred completion percentages and no guessed «thinking».
 * The page draws the full list of actions from the conversation's items; this keeps the last ones for the summary.
 */
export function summarizeProgress(conversation) {
  const turn = conversation.turns?.at(-1);
  if (!turn) return null;
  const status = turn.status;
  const agent = { antigravity: 'Antigravity', claude: 'Claude Code', cursor: 'Cursor', opencode: 'OpenCode' }[conversation.provider] || 'Codex';
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
  const work = currentWork(conversation, turn), cwd = conversation.cwd;
  // Working without detail names the client: in a Dual, the card says whose request it follows.
  let activity = work ? { title: work.state === 'working' ? `${agent} a trabalhar · sem atividade detalhada` : work.title, detail: work.detail || (work.actions?.length > 1 ? work.actions.map(item => actionPhrase(item, { live: true, cwd })).join(' · ') : work.state === 'working' ? currentStep?.step || '' : '') } : { title: `${agent} a trabalhar`, detail: currentStep?.step || '' };
  if (status === 'starting') activity = { title: 'A iniciar o pedido', detail: `A preparar a sessão ${agent}.` };
  if (status === 'completed') activity = { title: 'Pedido concluído', detail: `O ${agent} terminou este pedido.` };
  if (status === 'failed') activity = { title: 'Pedido terminou com erro', detail: conversation.error || '' };
  if (status === 'interrupted') activity = { title: 'Pedido interrompido', detail: 'O trabalho realizado mantém-se no histórico.' };
  if (status === 'uncertain') activity = { title: 'Estado por confirmar', detail: 'A ligação terminou sem confirmação do resultado.' };
  return {
    turnId: turn.id, status, ...activity, counts, steps,
    startedAt: turn.startedAt || null, completedAt: turn.completedAt || null,
    explanation: turn.plan?.explanation || null,
    commentary: commentary?.text?.slice(-1800) || null,
    thought: latestThought(conversation, turn) || null,
    completedSteps: steps.filter(step => step.status === 'completed').length,
    actions: actions.slice(-30).map(item => ({ id: item.id, status: finished.has(status) && actionStatus(item) === 'inProgress' ? 'unfinished' : actionStatus(item), type: item.type, detail: actionPhrase(item, { cwd }), at: item.at })),
  };
}
