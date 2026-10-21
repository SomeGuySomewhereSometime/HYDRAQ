export function redact(text){
  return String(text||'')
    .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,'[chave privada ocultada]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,'[segredo ocultado]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[credenciais ocultadas]@')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi,'$1[ocultado]')
    .replace(/\b([A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH_KEY)[A-Z_]*\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,'$1[ocultado]');
}
export const cited=text=>JSON.stringify(redact(text)).replaceAll('<','\\u003c').replaceAll('>','\\u003e');
