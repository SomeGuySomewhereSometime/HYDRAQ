import { redact } from './context-text.mjs';

const busy = new Set(['starting', 'running', 'waiting']);
const time = (value, fallback) => Number.isFinite(Date.parse(value)) ? value : fallback;
const limitText = value => {
  const text = redact(value || '');
  return {text: text.slice(0, 60000), truncated: text.length > 60000};
};

/** User-facing projection only. Never used as a model prompt or project memory. */
export function collaborationTimeline(s, principal, executor, reviewerConversation) {
  const units = [], base = time(s.createdAt, '1970-01-01T00:00:00.000Z');
  const principalMessages = principal?.messages || [];
  const known = new Set();
  for (const turn of principal?.turns || []) {
    const messages = principalMessages.filter(m => (turn.requestId && m.requestId === turn.requestId) || (m.turnId && m.turnId === turn.id));
    messages.forEach(m => known.add(m));
    addPrincipal(messages, turn, `principal:${turn.requestId}`);
  }
  // Older records can lack a native turn or message ID.
  principalMessages.filter(m => !known.has(m)).forEach((m, i) => addPrincipal([m], {}, `principal:legacy:${i}`));
  function addPrincipal(messages, turn, id) {
    const events = messages.filter(m => ['user','assistant'].includes(m.role) && !(m.role === 'user' && m.internal)).map((m, i) => ({
      id: `${id}:${m.id || i}`, kind: 'message', role: m.role === 'user' ? 'user' : 'principal',
      model: m.model || turn.model || principal?.model || s.principal.model,
      at: time(m.at, time(turn.startedAt, base)), status: turn.status,
      streaming: busy.has(turn.status) && Boolean(m.streaming), ...limitText(m.text),
      ...(m.projectContext ? {projectContext: m.projectContext} : {})
    }));
    if (events.length) units.push({at: time(turn.startedAt, events[0].at), priority: turn.internal === 'collaboration-result' || turn.requestId?.startsWith('col-result-') ? 6 : 0, events});
  }
  function addWorker(record, conversation, role, model) {
    const turn = record.requestId && conversation?.turns.find(t => t.requestId === record.requestId);
    const start = time(record.startedAt, time(turn?.startedAt, time(record.createdAt, base)));
    const events = [{id: `${role}:${record.id}:task`, kind: 'task', role, model, at: start,
      status: record.status, task: record.task, referenceId: record.id, instructions: role === 'executor' ? redact(record.instructions || '') : '',
      files: record.facts?.files?.length || 0, commands: record.facts?.commands?.length || 0}];
    const messages = record.requestId ? (conversation?.messages || []).filter(m => m.role === 'assistant' && !m.internal && (m.requestId === record.requestId || (turn?.id && m.turnId === turn.id))) : [];
    for (const [i,m] of messages.entries()) events.push({id: `${role}:${record.id}:${m.id || i}`, kind: 'message', role, model: m.model || model,
      at: time(m.at, start), status: record.status, referenceId: record.id,
      streaming: busy.has(record.status) && Boolean(m.streaming), ...limitText(m.text)});
    const report = record.result || record.partial || '', visible=limitText(report);
    const reportText=visible.text.trim(), publicTexts=events.slice(1).map(m=>m.text.trim());
    const excerpt=record.resultTruncated||report.length>=60000;
    const matches=text=>text===reportText||(excerpt&&text.startsWith(reportText));
    // Stored excerpts and composed partials must not repeat the public messages.
    if (report && !publicTexts.some(matches) && !matches(publicTexts.join('\n\n'))) {
      events.push({id: `${role}:${record.id}:report`,kind:'message',role,model,at:time(record.completedAt,start),status:record.status,referenceId:record.id,...visible,truncated:Boolean(record.resultTruncated || visible.truncated)});
    }
    if (record.error) events.push({id:`${role}:${record.id}:error`,kind:'error',role,model,at:time(record.completedAt,start),status:record.status,referenceId:record.id,...limitText(record.error)});
    units.push({at:start,priority:role==='executor'?2:4,events});
  }
  for (const job of s.jobs) addWorker(job, executor, 'executor', s.executor.model);
  for (const review of s.reviews || []) addWorker(review, reviewerConversation(review.conversationId), 'reviewer', review.model);
  // Keep each native turn together; equal timestamps still preserve the delegation/review/report order.
  units.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.priority-b.priority);
  const all = units.flatMap(u=>u.events), entries=[];let size=0;
  for(let i=all.length-1;i>=0&&entries.length<160;i--){const entry=all[i],bytes=(entry.text?.length||0)+(entry.instructions?.length||0)+(entry.projectContext?.length||0);if(entries.length&&size+bytes>600000)break;size+=bytes;entries.push(entry);}
  return {entries:entries.reverse(),omitted:all.length-entries.length};
}
