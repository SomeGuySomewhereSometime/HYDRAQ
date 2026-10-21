import { createHash } from 'node:crypto';
import { groupOf, finalAnswer, turnFacts } from './handoff.mjs';
import { redact } from './context-text.mjs';

const terminal = new Set(['completed', 'failed', 'interrupted', 'uncertain', 'limited']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const short = value => String(value || '').length>350?String(value).slice(0,350)+'… [excerto cortado]':String(value||'');

/** A disposable index, never another history. Providers invalidate on native/controller
 * events and catalog changes. Direct standalone users can opt out of caching. */
export class ProjectRecords {
  constructor({ projects, conversations, collaborations, cache, revision }) {
    Object.assign(this, { projects, conversations, collaborations, cache });this.sourceRevision=revision;
    this.values = new Map();
  }
  revisionOfSources(){return this.sourceRevision?.()||0;}
  invalidate() { this.values.clear(); }
  entries(projectId) {
    const revision = String(this.projects.data?.revision)+':'+this.revisionOfSources();
    if (this.revision !== revision) { this.invalidate(); this.revision = revision; }
    if (this.cache && this.values.has(projectId)) return this.values.get(projectId);
    const result = [];
    for (const c of this.conversations()) {
      const groupId = groupOf(c), org = this.projects.group(groupId);
      if (org?.projectId !== projectId) continue;
      for (const t of c.turns || []) {
        if (t.internal || !terminal.has(t.status)) continue;
        const messages = c.messages.filter(m => !m.internal && (m.requestId === t.requestId || (t.id && m.turnId === t.id)) && ['user', 'assistant'].includes(m.role));
        const user = messages.find(m => m.role === 'user');
        result.push(this.record({ kind: 'conversation', groupId, requestId: t.requestId, turnId: t.id || t.requestId,
          at: t.completedAt || t.startedAt, title: org.title || c.title, archived: org.archived, provider: c.provider, status: t.status,
          facts: t.facts || turnFacts(c, t), conclusion: finalAnswer(c, t.requestId), question: user?.text,
          attachments: user?.attachments || [], conversation: c, turn: t, plan: t.plan || [],
          segments: messages.map(m => ({ label: (m.role === 'user' ? 'Utilizador' : 'Modelo afirmou') + (m.delivery ? ` [${m.delivery}]` : ''), text: m.text })) }));
      }
    }
    // Only controller state is exposed. Native Cursor/Claude histories are deliberately absent.
    for (const s of this.collaborations()) {
      if (!s.projectId || s.projectId !== projectId) continue;
      for (const cycle of s.cycles) {
        if (!terminal.has(cycle.status)) continue;
        const jobs = s.jobs.filter(j => j.cycleId === cycle.id), reviews = (s.reviews || []).filter(r => r.cycleId === cycle.id);
        const segments = [{ label: 'Utilizador', text: cycle.text }];
        for (const p of cycle.principalResponses || []) segments.push({ label: 'Principal afirmou'+(p.status&&p.status!=='completed'?' (parcial · '+p.status+')':''), text: p.text+(p.truncated?'\n[Excerto limitado; original na colaboração.]':'') });
        for (const j of jobs) {
          segments.push({ label: `Tarefa ${j.id} · instruções delegadas`, text: j.instructions });
          segments.push({ label: `O executor afirmou · ${j.status}`, text: (j.result || j.partial || j.error || '(sem relatório)')+(j.resultTruncated?'\n[Relatório limitado; original no histórico nativo.]':'') });
          if(j.error)segments.push({label:'Erro comunicado pelo executor/controlador',text:j.error});
          if(j.facts)segments.push({label:'Ações observadas pelo HYDRAQ nesta tarefa',text:JSON.stringify(j.facts)});
        }
        for (const r of reviews) segments.push({ label: `Revisor afirmou · ${r.status} · sem execução de testes`, text: r.result || r.partial || r.error || '(sem parecer)' });
        if (cycle.error) segments.push({ label: 'Estado comunicado pelo controlador', text: cycle.error });
        if (!cycle.principalResponses && !cycle.finalAnswer) segments.push({ label: 'Limitação do histórico anterior', text: 'Resposta do principal não registada no ciclo; consultar a colaboração original.' });
        result.push(this.record({ kind: 'collaboration', groupId: 'col:' + s.id, requestId: cycle.requestId, turnId: cycle.id,
          at: cycle.completedAt || cycle.startedAt, title: s.title, provider: 'collaboration', status: cycle.status,
          question: cycle.text, conclusion: cycle.finalAnswer || '', attachments: [], segments,
          plan: (cycle.principalResponses || []).flatMap(p => p.plan || []),
          facts: { files: [...new Set(jobs.flatMap(j => j.facts?.files || []))], commands: jobs.flatMap(j => j.facts?.commands || []) } }));
      }
    }
    result.sort((a, b) => String(b.at).localeCompare(String(a.at)) || a.key.localeCompare(b.key));
    if (this.cache) this.values.set(projectId, result);
    return result;
  }
  record({ facts, ...entry }) {
    entry.title = redact(entry.title); entry.question = redact(entry.question);
    entry.segments = entry.segments.map(m => ({ label: m.label, text: redact(m.text) }));
    const clean = v => typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(clean) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x])=>[k,clean(x)])) : v;
    entry.plan = clean(entry.plan || []);
    entry.files = (facts.files || []).map(redact);
    entry.commands = (facts.commands || []).map(c => ({ command: redact(c.command), status: c.status, exitCode: c.exitCode }));
    // Hash full relevant content, not a shortened conclusion or only the request ID.
    entry.key = `${entry.kind}:${entry.groupId}:${entry.requestId}:${entry.status}:${hash([entry.segments, entry.plan, entry.files, entry.commands])}`;
    entry.conclusion = short(redact(entry.conclusion));
    return entry;
  }
}
