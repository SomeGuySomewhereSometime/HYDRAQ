// Shared routing rules. Stable slots belong to a record; historical rounds keep their own roster.
import { t as uiText } from './i18n.js';
export const DUAL_KEYS = ['a', 'b', 'c', 'd'];
export const memberKeys = record => DUAL_KEYS.filter(key => Object.hasOwn(record.members || {}, key));
export function targetKeys(record, target = record.target) {
  const active = memberKeys(record);
  if (target === 'both' && active.length !== 2) throw Error('Recarrega a página para usar o Multi com mais de dois participantes. Nada foi enviado.');
  const keys = target === 'all' || target === 'both' ? active : Array.isArray(target) ? target : [target];
  if (!keys.length || new Set(keys).size !== keys.length || keys.some(key => !active.includes(key))) throw Error('Destinatário inválido.');
  return active.filter(key => keys.includes(key));
}
export const allLabel = n => ({2:uiText('os dois'),3:uiText('os três'),4:uiText('os quatro')}[n] || uiText('todos'));
