import {stripVTControlCharacters} from 'node:util';
import {redact} from './context-text.mjs';

export function nativeErrorText(error) {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return '';
  const code = error.type || error.code || error.status;
  return [code, typeof error.message === 'string' ? error.message : ''].filter(Boolean).join(': ') || JSON.stringify(error);
}

const permission = /soft[- ]denied|(?:permission|approval|autoriza\w*|aprova\w*)[^\n]{0,100}(?:denied|refused|unavailable|required|not available|indispon[ií]vel|recusad[ao]|necess[aá]ri[ao])|(?:denied|refused|recusad[ao])[^\n]{0,80}(?:permission|approval|autoriza\w*|aprova\w*)/i;
const quota = /(?:quota|usage limit|rate limit|limite de utiliza[çc][aã]o)[^\n]{0,100}(?:exhausted|exceeded|reached|esgotad[ao]|atingid[ao]|ultrapassad[ao])|(?:exhausted|exceeded|esgotad[ao]|atingid[ao])[^\n]{0,80}(?:quota|usage limit|rate limit)/i;
const quotaCode = /\b(?:QUOTA_EXCEEDED|QUOTA_EXHAUSTED|USAGE_LIMIT_EXCEEDED|RATE_LIMIT_EXCEEDED|RATE_LIMITED)\b/i;
export const antigravityPermissionError = error => Boolean(error && (/\b(?:PERMISSION_DENIED|APPROVAL_REQUIRED|TOOL_APPROVAL_DENIED)\b/i.test(nativeErrorText(error)) || permission.test(nativeErrorText(error))));
const evidence = value => {
  const text = redact(stripVTControlCharacters(String(value || ''))).trim();
  return text.length > 1200 ? text.slice(0, 1200) + '\n[Diagnóstico abreviado.]' : text;
};

/** Only native errors, stderr and observed refusals are evidence. Assistant prose, token counts,
 * a 429 on its own or RESOURCE_EXHAUSTED alone do not prove that the subscription quota ran out. */
export function antigravityDiagnostics({error, stderr = '', declined = 0, tools = [], empty = false} = {}) {
  const diagnostics = [], native = nativeErrorText(error);
  const lines = stripVTControlCharacters(String(stderr)).split(/\r?\n/);
  const quotaLine = lines.find(line => quotaCode.test(line) || quota.test(line));
  if (quotaCode.test(native) || quota.test(native) || quotaLine) diagnostics.push({
    code: 'quota', label: 'Quota ou limite', source: quotaCode.test(native) || quota.test(native) ? 'native-error' : 'stderr',
    message: 'O Antigravity indicou um limite de utilização. Um eventual prazo comunicado pelo cliente aparece nos detalhes.',
    detail: evidence(quotaCode.test(native) || quota.test(native) ? native : quotaLine),
  });
  const permissionLine = lines.find(line => antigravityPermissionError(line));
  if (declined > 0 || antigravityPermissionError(error) || permissionLine) diagnostics.push({
    code: 'permission', label: 'Ferramenta recusada', source: declined > 0 ? 'tool-result' : permissionLine ? 'stderr' : 'native-error',
    message: declined > 0 ? `${declined} ferramenta(s) recusada(s) por falta de autorização. Essas ações não foram executadas; a resposta pode estar limitada.`
      : 'O Antigravity comunicou uma recusa de ferramenta por falta de autorização. A resposta pode estar limitada.',
    detail: evidence(tools.length ? [...new Set(tools)].slice(0, 5).join('\n') + (declined > 5 ? '\n[Mostrar as ações para consultar as restantes recusas.]' : '') : declined > 0 ? `Recusas registadas nos factos do pedido: ${declined}.` : permissionLine || native),
  });
  if (empty) diagnostics.push({code: 'empty', label: 'Sem resposta', source: 'native-result', message: 'O Antigravity terminou sem uma resposta de texto. Não foi recebido um resultado para este pedido.'});
  return diagnostics;
}

export function antigravityEmptyError(diagnostics = []) {
  const refusal = diagnostics.find(d => d.code === 'permission'), limit = diagnostics.find(d => d.code === 'quota');
  return ['O Antigravity terminou sem uma resposta.', limit?.message, refusal?.message].filter(Boolean).join(' ');
}

export function antigravityOpinionDiagnostics(job) {
  if (job.provider !== 'antigravity') return job.diagnostics || [];
  // Old review records retain facts even when the native stderr was never stored.
  const derived = antigravityDiagnostics({error: job.error, declined: job.facts?.declined || 0,
    tools: (job.facts?.commands || []).filter(c => c.status === 'declined').map(c => c.command),
    empty: ['completed','failed'].includes(job.status) && !job.text?.trim()});
  const result = new Map((job.diagnostics || []).map(d => [d.code, d]));
  for (const diagnostic of derived) if (!result.has(diagnostic.code)) result.set(diagnostic.code, diagnostic);
  return [...result.values()];
}
