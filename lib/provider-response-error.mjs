import {antigravityOpinionDiagnostics, antigravityEmptyError} from './antigravity-diagnostics.mjs';

/** Some clients return a service notice as an ordinary end_turn. Recognize only standalone notices,
 * never an answer discussing quota/payment or quoting an error as part of a review. */
export function providerResponseError(provider, text) {
  if (provider !== 'cursor') return null;
  const value = String(text || '').trim();
  if (/^(?:Error:\s*)?Add a payment method to continue[.!]?$/i.test(value))
    return 'O Cursor/Grok não respondeu: o cliente pediu um método de pagamento (Add a payment method to continue).';
  if (/^(?:Error:\s*)?(?:You(?:'|’)ve hit your usage limit|Usage limit (?:reached|exceeded)|Insufficient credits|Quota exceeded)[.!]?$/i.test(value))
    return `O Cursor/Grok não respondeu por limite de utilização: ${value}`;
  return null;
}

export function opinionResultError(job) {
  if(job.provider==='antigravity'&&['completed','failed'].includes(job.status)&&!job.text?.trim()) {
    if(job.status==='failed'&&job.error&&!/^O (?:revisor|Antigravity) terminou sem uma resposta/.test(job.error))return null;
    return antigravityEmptyError(antigravityOpinionDiagnostics(job));
  }
  if (job.status !== 'completed') return null;
  if (!job.text?.trim()) return 'O revisor terminou sem uma resposta. Não foi recebido um parecer; podes escolher outro modelo ou tentar novamente.';
  return providerResponseError(job.provider, job.text);
}
