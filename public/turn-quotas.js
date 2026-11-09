import { locale as uiLocale } from './i18n.js';
import { t as uiText } from './i18n.js';
const format = new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: 6 });
const reasons = {
  overlap: uiText('turnos simultâneos na mesma conta'),
  reset: uiText('o contador mudou de janela ou foi reposto'),
  missing: uiText('faltam leituras comparáveis'),
};

export function quotaUsageView(usage, { heading = uiText('Quota usada') } = {}) {
  const view = document.createElement('div');
  view.className = 'message-usage turn-quota-usage';
  const notes = [uiText('Estimativa pela diferença entre leituras do contador da conta ou do grupo. Depende da precisão e atualização do cliente e pode incluir atividade noutros clientes.')];
  if (usage.partial) notes.push(uiText('Medição parcial.'));
  const title = document.createElement('strong');
  title.textContent = heading;
  const showGroup = new Set(usage.windows.map(window => window.group)).size > 1;
  const labels = usage.windows.map(window => {
    const name = [showGroup && window.group, window.label].filter(Boolean).join(' · ');
    if (window.spent === null) {
      notes.push(name + uiText(' sem estimativa. ') + reasons[window.reason] + '.');
      return name + ' · —';
    }
    if (window.spent === 0) notes.push(name + uiText(' sem variação detetada à precisão do contador.'));
    return name + ' · ' + format.format(window.spent) + '%';
  });
  if (!labels.length) {
    labels.push('—');
    notes.push(uiText('Sem estimativa. ') + reasons[usage.reason] + '.');
  }
  view.title = notes.join(' ');
  view.append(title, document.createTextNode(' · ' + labels.join(' | ')));
  return view;
}

// In-place tasks can reuse a conversation. The dispatch IDs isolate this task's turns.
export function hydraQuotaUsage(task, conversations) {
  if (!task) return [];
  const rows = [];
  const roles = new Map([
    ...Object.entries(task.members || {}).map(([role, member]) => [role, member.conversationId]),
    ...(task.removedParticipants || []).map(member => [member.role, member.conversationId]),
  ]);
  for (const [provider, id] of roles) {
    const requests = new Set((task.dispatches || []).filter(entry => entry.role === provider).map(entry => entry.requestId));
    const scoped = task.quotaTurns?.[provider];
    const turns = scoped || conversations.find(c => c.id === id)?.turns || [];
    const groups = new Map();
    for (const turn of turns) {
      if ((!scoped && !requests.has(turn.requestId)) || turn.delivery === 'preparing' || ['starting','running','waiting'].includes(turn.status)) continue;
      const group = groups.get(turn.model) || [];
      group.push(turn.quotaUsage);
      groups.set(turn.model, group);
    }
    for (const [model, samples] of groups) {
      if (!samples.some(Boolean)) continue;
      const sums = new Map();
      let partial = false;
      for (const sample of samples) {
        if (!sample?.windows.length) partial = true;
        for (const window of sample?.windows || []) {
          const key = JSON.stringify([window.id, window.group, window.label]);
          const old = sums.get(key);
          partial ||= window.spent === null;
          if (!old || old.spent === null) sums.set(key, { ...window });
          else if (window.spent !== null) old.spent += window.spent;
        }
      }
      rows.push({ provider, model, partial, windows: [...sums.values()], reason: samples.find(Boolean).reason });
    }
  }
  return rows;
}
