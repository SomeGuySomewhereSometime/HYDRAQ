import { t as uiText } from './i18n.js';
export const quotaWindowOrder = (a, b) => (a.windowDurationMins || Infinity) - (b.windowDurationMins || Infinity);

/** Associate only the native groups we recognize; never borrow another subscription's quota. */
export function selectedQuotas(provider, model, windows = [], metadata = {}, { strict = false } = {}) {
  const identity = `${model || ''} ${metadata.name || ''} ${metadata.metadata?.resolvedModel || ''}`.toLowerCase();
  if (provider === 'codex') {
    const specific = windows.filter(w => w.group?.toLowerCase() === model?.toLowerCase() || w.id?.startsWith(`${model}:`));
    const common = windows.filter(w => w.id?.startsWith('codex:') || w.group?.toLowerCase() === 'codex');
    const selected = [...new Set([...common, ...specific])];
    return { windows: (selected.length || strict ? selected : windows).slice().sort(quotaWindowOrder), scope: specific.length ? uiText('Quota da conta e do modelo') : selected.length || new Set(windows.map(w => w.group)).size <= 1 ? uiText('Quota partilhada do Codex') : uiText('Grupos de limites comunicados pelo Codex') };
  }
  if (provider === 'claude') {
    const family = /opus/.test(identity) ? 'opus' : /sonnet/.test(identity) ? 'sonnet' : null;
    return { windows: windows.filter(w => ['five_hour', 'seven_day'].includes(w.id) || (family && w.id === `seven_day_${family}`)).sort(quotaWindowOrder), scope: uiText('Quota da subscrição Claude') };
  }
  if (provider === 'antigravity') {
    const argon = w => /argon/i.test(`${w.id} ${w.group}`);
    const gemini = w => !argon(w) && /gemini/i.test(`${w.id} ${w.group}`);
    const thirdParty = w => /^3p-/.test(w.id || '') || /claude.*gpt|gpt.*claude/i.test(w.group || '');
    if (/gemini.*argon/.test(identity) && (strict || windows.some(argon))) return { windows: windows.filter(argon).sort(quotaWindowOrder), scope: uiText('Quota própria do Argon') };
    if (/gemini/.test(identity)) return { windows: windows.filter(gemini).sort(quotaWindowOrder), scope: uiText('Grupo Gemini · Antigravity') };
    if (/claude|gpt/.test(identity)) return { windows: windows.filter(thirdParty).sort(quotaWindowOrder), scope: uiText('Grupo Claude e GPT · Antigravity') };
    return { windows: [], scope: uiText('Grupo de quota por identificar'), unmapped: windows.length > 0 };
  }
  return { windows: [], scope: uiText('O cliente não disponibiliza estes limites') };
}
