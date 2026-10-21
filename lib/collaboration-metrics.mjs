const number = n => Number.isFinite(n) && n >= 0;

/** Account the previous observed state before moving to the next one. Overlapping
 * permissions form one waiting interval; restarting never counts offline time. */
export function observeTiming(cycle, waiting, time = Date.now(), stop = false) {
  const t = cycle.timing;
  if (!t || t.stoppedAt !== undefined) return false;
  const elapsed = Math.max(0, time - t.observedAt);
  t[t.waiting ? 'waitMs' : 'workMs'] += elapsed;
  const changed = t.waiting !== waiting || stop;
  t.observedAt = time; t.waiting = waiting;
  if (stop) t.stoppedAt = time;
  return changed;
}
export function cycleMetrics(cycle, principal, live = false, time = Date.now(), reviews = [], jobs = []) {
  const t = cycle.timing;
  let workMs = null, waitMs = null, complete = false;
  if (t) {
    const delta = live && t.stoppedAt === undefined ? Math.max(0, time - t.observedAt) : 0;
    workMs = t.workMs + (t.waiting ? 0 : delta); waitMs = t.waitMs + (t.waiting ? delta : 0); complete = !t.incomplete;
  }
  const turns = (principal?.turns || []).filter(turn => turn.requestId === `col-${cycle.id}` || turn.requestId?.startsWith(`col-result-${cycle.id}-`));
  const measured = turns.filter(turn => ['inputTokens', 'cachedInputTokens', 'outputTokens'].every(k => number(turn.usage?.[k])));
  const usage = { expectedTurns: Math.max(cycle.principalTurns || 0, turns.length), measuredTurns: measured.length };
  for (const key of ['inputTokens', 'cachedInputTokens', 'uncachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']) usage[key] = measured.reduce((sum, turn) => sum + (number(turn.usage[key]) ? turn.usage[key] : 0), 0);
  usage.complete = usage.measuredTurns === usage.expectedTurns;
  const reviewTurns=reviews.filter(r=>r.cycleId===cycle.id);
  const measuredReviews=reviewTurns.filter(r=>['inputTokens','cachedInputTokens','outputTokens'].every(k=>number(r.usage?.[k])));
  const reviewerUsage={expectedTurns:reviewTurns.length,measuredTurns:measuredReviews.length};
  for(const key of ['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens'])reviewerUsage[key]=measuredReviews.reduce((sum,r)=>sum+(number(r.usage?.[key])?r.usage[key]:0),0);
  reviewerUsage.complete=reviewerUsage.measuredTurns===reviewerUsage.expectedTurns;
  const workerJobs=jobs.filter(j=>j.cycleId===cycle.id&&j.requestId).length;
  const measuredUsage={complete:usage.complete&&reviewerUsage.complete&&!workerJobs};
  for(const key of ['inputTokens','cachedInputTokens','outputTokens'])measuredUsage[key]=usage[key]+reviewerUsage[key];
  const executorUsage={expectedTurns:workerJobs,measuredTurns:0,available:false};
  const start = Date.parse(cycle.startedAt), end = cycle.completedAt ? Date.parse(cycle.completedAt) : time;
  return { workMs, waitMs, complete, elapsedMs: Math.max(0, end - start), principalUsage: usage, reviewerUsage, executorUsage, measuredUsage };
}
