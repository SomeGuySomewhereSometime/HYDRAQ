// A reviewer decision is scoped to this job, never inferred from prose or source history.
export function reviewReturnMode(config) {
  if (config?.returnMode !== undefined) return config.returnMode;
  return typeof config?.returnToPrincipal === 'boolean' ? (config.returnToPrincipal ? 'always' : 'manual') : null;
}

export function reviewDecisionInstructions(token) {
  return `\nDecisão de envio deste parecer (HYDRAQ, pedido atual): decide se vale a pena pedir uma nova avaliação ao principal. Recomenda enviar quando encontraste um erro, regressão, risco relevante, requisito em falta ou melhoria concreta que justifique essa avaliação. Não recomendes enviar por mera concordância, repetição ou preferências cosméticas sem impacto. Se alteraste ficheiros, recomenda enviar para o principal conhecer essas alterações. Não envies nada por ferramentas; o HYDRAQ trata do envio.\nEscreve primeiro o teu parecer normal. No fim, fora de blocos de código e sem texto depois, acrescenta exatamente um bloco JSON com este token. Usa sendToPrincipal=true para recomendar envio ou false para manter separado, e reason com uma justificação curta, não vazia (até 1000 caracteres). O exemplo mostra a estrutura; escolhe a tua própria decisão:\n<hydraq_review_decision request="${token}">\n{"sendToPrincipal":true,"reason":"Justificação concreta da tua decisão"}\n</hydraq_review_decision>`;
}

export function parseReviewDecision(answer, token) {
  const text = String(answer || '');
  const pending = reason => ({text, recommendation: {status: 'pending', reason}});
  if (!/^[a-f0-9-]{36}$/.test(token || '')) return pending('A identificação da decisão não é válida. Escolhe manualmente se queres enviar.');
  const pattern = new RegExp(`<hydraq_review_decision request="${token}">([\\s\\S]*?)<\\/hydraq_review_decision>`, 'g');
  const blocks = [...text.matchAll(pattern)];
  if (blocks.length !== 1) return pending('O revisor não devolveu uma única decisão estruturada deste pedido. O parecer ficou separado para seleção manual.');
  const block = blocks[0];
  if (text.slice(block.index + block[0].length).trim()) return pending('A decisão não terminou a resposta no formato esperado. O envio requer seleção manual.');
  let value;
  try { value = JSON.parse(block[1]); } catch { return pending('A decisão do revisor contém JSON inválido. O parecer não foi enviado automaticamente.'); }
  // Count fields without treating escaped quotes/JSON mentioned inside the reason as keys.
  // JSON.parse alone would silently accept repeated keys and choose the last decision.
  const tokens = block[1].match(/"(?:\\.|[^"\\])*"|[{}:,]/g) || [];
  const fieldCount = tokens.filter((_, index) => tokens[index + 1] === ':').length;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 || fieldCount !== 2 || typeof value.sendToPrincipal !== 'boolean' ||
      typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 1000) {
    return pending('A decisão deve indicar um booleano e uma justificação curta. O parecer ficou separado.');
  }
  const opinion = text.slice(0, block.index).trimEnd();
  if (!opinion.trim()) return pending('O revisor devolveu uma decisão sem parecer. O envio requer verificação manual.');
  return {text: opinion, recommendation: {status: 'decided', sendToPrincipal: value.sendToPrincipal, reason: value.reason.trim()}};
}
