// Interface strings only. Conversation content and native client output never pass through this catalogue.
import { english } from './i18n-en.js';

export const LANGUAGE_KEY = 'hydraq.language';
export function readLanguage(storage) {
  try { return (storage ?? globalThis.localStorage)?.getItem(LANGUAGE_KEY) === 'pt' ? 'pt' : 'en'; }
  catch { return 'en'; }
}
// Shared helpers are also used by the server. Localisation is a browser preference;
// server-side facts and native histories retain their original wording.
let language = typeof window === 'undefined' ? 'pt' : readLanguage();
export const locale = () => language === 'pt' ? 'pt-PT' : 'en-GB';
export function t(source, ...values) {
  if (Array.isArray(source)) {
    const key = source.reduce((text, part, i) => text + (i ? '{' + (i - 1) + '}' : '') + part, '');
    const translated = language === 'en' && Object.hasOwn(english, key) ? english[key] : null;
    if (translated) return translated.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)]));
    return source.reduce((text, part, i) => text + (i ? String(values[i - 1]) : '') + t(part), '');
  }
  return language === 'en' && Object.hasOwn(english, source) ? english[source] : source;
}
export function setupLanguage(document, storage) {
  language = readLanguage(storage);
  if (!storage) { try { storage = globalThis.localStorage; } catch { /* Display still works when storage is blocked. */ } }
  document.documentElement.lang = locale();
  translateStatic(document.documentElement);
  const select = document.querySelector('#interface-language');
  if (select) {
    select.value = language;
    select.addEventListener('change', () => {
      try {
        storage.setItem(LANGUAGE_KEY, select.value);
        globalThis.dispatchEvent(new Event('hydraq-language-change'));
        globalThis.location.reload();
      } catch {
        select.value = language;
        document.querySelector('#language-status').textContent = t('Não foi possível guardar o idioma neste navegador.');
      }
    });
  }
}

export function translateStatic(root) {
  // Runs once, before application state or conversation content is rendered.
  const visit = node => {
    if (node.nodeType === 3) {
      const trimmed = node.data.trim();
      if (trimmed) node.data = node.data.replace(trimmed, t(trimmed));
      return;
    }
    if (node.nodeType !== 1 || ['SCRIPT', 'STYLE', 'SVG'].includes(node.tagName)) return;
    for (const name of ['title', 'placeholder', 'aria-label', 'data-tip']) {
      if (node.hasAttribute(name)) node.setAttribute(name, t(node.getAttribute(name)));
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
}
