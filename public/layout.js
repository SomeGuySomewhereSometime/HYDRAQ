// Panel sizes, visibility and explanations. Per-browser preferences only: losing them
// restores the defaults and never affects conversations or requests.
export const PANEL_LIMITS = {
  sidebar: { min: 200, max: 440, initial: 264 },
  inspector: { min: 260, max: 600, initial: 340 },
};
export const MIN_CONVERSATION = 460;
export const THEMES = ['classic', 'atelier', 'linho', 'mono'];
export const APPEARANCES = [
  { theme: 'classic', swatch: 'grafite', name: 'Grafite', description: 'Escuro neutro e sóbrio, com a cor de cada cliente.', meta: '#0e0f12' },
  { theme: 'atelier', swatch: 'atelier', name: 'Atelier', description: 'Ilhas de vidro sobre obsidiana, com barra de clientes.', meta: '#08090d' },
  { theme: 'linho', swatch: 'linho', name: 'Linho', description: 'Papel quente, verde profundo e espaço para pensar.', meta: '#f6f4ed' },
  { theme: 'mono', swatch: 'mono', name: 'Mono', description: 'Preto e branco, com a cor de cada cliente.', meta: '#171717' },
];
export function appearanceOf(theme) {
  return APPEARANCES.find(entry => entry.theme === theme) || APPEARANCES[0];
}
/** Width of the reading column (messages and composer) inside the conversation panel. */
export const COLUMNS = [
  { value: 'full', name: 'Toda', description: 'Ocupa toda a largura da conversa.' },
  { value: 'medium', name: 'Média', description: 'Coluna central, um pouco mais estreita.' },
  { value: 'narrow', name: 'Estreita', description: 'Coluna central estreita, só para ler e escrever.' },
];
/** Each client has one hue; every theme defines its own tone for each hue (--hue-<id>). */
export const CLIENTS = [
  { id: 'codex', name: 'Codex' },
  { id: 'antigravity', name: 'Antigravity' },
  { id: 'claude', name: 'Claude Code' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'opencode', name: 'OpenCode' },
];
export const HUES = [
  { id: 'esmeralda', name: 'Esmeralda' },
  { id: 'lima', name: 'Lima' },
  { id: 'ambar', name: 'Âmbar' },
  { id: 'laranja', name: 'Laranja' },
  { id: 'rubi', name: 'Rubi' },
  { id: 'rosa', name: 'Rosa' },
  { id: 'violeta', name: 'Violeta' },
  { id: 'azul', name: 'Azul' },
  { id: 'ciano', name: 'Ciano' },
];
export const DEFAULT_COLORS = { codex: 'esmeralda', antigravity: 'ciano', claude: 'laranja', cursor: 'violeta', opencode: 'rosa' };
const STORAGE_KEY = 'hydraq.layout';
const THEME_KEY = 'hydraq.theme';
export const TEXT_SIZE = { min: 13, max: 22, initial: 15 };
const validTextSize = value => Number.isInteger(value) && value >= TEXT_SIZE.min && value <= TEXT_SIZE.max;

export function defaultLayout() {
  return { sidebar: { width: PANEL_LIMITS.sidebar.initial, open: true }, inspector: { width: PANEL_LIMITS.inspector.initial, open: true }, prose: 'comfortable', column: 'full', textSize: TEXT_SIZE.initial, theme: 'atelier', colors: { ...DEFAULT_COLORS } };
}

/** Accepts only known fields, so a stale or edited preference cannot break the page. */
export function readLayout(raw, themeRaw = null) {
  const layout = defaultLayout();
  let value;
  try { value = JSON.parse(raw || 'null'); } catch { value = null; }
  if (value && typeof value === 'object') {
    for (const panel of Object.keys(PANEL_LIMITS)) {
      const saved = value[panel];
      if (!saved || typeof saved !== 'object') continue;
      if (Number.isFinite(saved.width)) layout[panel].width = clampWidth(panel, saved.width);
      if (typeof saved.open === 'boolean') layout[panel].open = saved.open;
    }
    if (['comfortable', 'full'].includes(value.prose)) layout.prose = value.prose;
    if (COLUMNS.some(entry => entry.value === value.column)) layout.column = value.column;
    if (validTextSize(value.textSize)) layout.textSize = value.textSize;
    if (THEMES.includes(value.theme)) layout.theme = value.theme;
    if (value.colors && typeof value.colors === 'object') {
      for (const { id } of CLIENTS) if (HUES.some(hue => hue.id === value.colors[id])) layout.colors[id] = value.colors[id];
    }
  }
  if (THEMES.includes(themeRaw)) layout.theme = themeRaw;
  return layout;
}

/** Keeps the panel inside its limits and leaves room for the conversation when the window allows it. */
export function clampWidth(panel, width, { viewport = Infinity, other = 0 } = {}) {
  const { min, max } = PANEL_LIMITS[panel];
  const room = viewport - other - MIN_CONVERSATION;
  const cap = Math.min(max, Math.max(min, room));
  return Math.round(Math.max(min, Math.min(cap, width)));
}

export class Layout {
  constructor({ body = document.body, root = document.documentElement, storage = globalThis.localStorage, mobileQuery = '(max-width: 800px)' } = {}) {
    Object.assign(this, { body, root, storage });
    this.mobile = window.matchMedia(mobileQuery);
    let raw = null, themeRaw = null;
    try { raw = storage?.getItem(STORAGE_KEY); themeRaw = storage?.getItem(THEME_KEY); } catch { /* Private mode: defaults. */ }
    this.state = readLayout(raw, themeRaw);
    this.drawers = { sidebar: false, inspector: false };
    this.listeners = new Set();
    this.apply();
    this.mobile.addEventListener?.('change', () => { this.closeDrawers(); this.apply(); });
    window.addEventListener('resize', () => this.apply());
  }
  onChange(listener) { this.listeners.add(listener); }
  save() { try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state)); this.storage?.setItem(THEME_KEY, this.state.theme); } catch { /* Preference only. */ } }
  other(panel) {
    const name = panel === 'sidebar' ? 'inspector' : 'sidebar';
    return this.state[name].open ? this.state[name].width : 0;
  }
  apply() {
    for (const panel of Object.keys(PANEL_LIMITS)) {
      const entry = this.state[panel];
      // Window shrinks shrink the panel on screen; the saved preference stays for wider windows.
      const shown = clampWidth(panel, entry.width, { viewport: window.innerWidth, other: this.other(panel) });
      this.root.style.setProperty(`--${panel}-w`, `${shown}px`);
      const open = this.mobile.matches ? this.drawers[panel] : entry.open;
      this.body.dataset[panel] = open ? 'open' : 'closed';
      const resizer = document.getElementById(`${panel}-resizer`);
      if (resizer) {
        resizer.setAttribute('aria-valuemin', String(PANEL_LIMITS[panel].min));
        resizer.setAttribute('aria-valuemax', String(PANEL_LIMITS[panel].max));
        resizer.setAttribute('aria-valuenow', String(shown));
        resizer.hidden = this.mobile.matches || !entry.open;
      }
      const toggle = document.getElementById(`${panel}-toggle`);
      toggle?.setAttribute('aria-expanded', String(open));
    }
    document.getElementById('sidebar-scrim')?.classList.toggle('hidden', !(this.mobile.matches && this.drawers.sidebar));
    document.getElementById('inspector-scrim')?.classList.toggle('hidden', !(this.mobile.matches && this.drawers.inspector));
    this.body.dataset.prose = this.state.prose;
    this.body.dataset.column = this.state.column;
    this.body.style.setProperty('--conversation-font-size', `${this.state.textSize}px`);
    this.body.dataset.theme = this.state.theme;
    // Custom properties through the CSSOM: the CSP forbids inline style attributes, not this.
    for (const { id } of CLIENTS) this.body.style.setProperty(`--c-${id}`, `var(--hue-${this.state.colors[id]})`);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', this.appearance().meta);
    for (const listener of this.listeners) listener(this.state);
  }
  toggle(panel, open) {
    if (this.mobile.matches) {
      const next = open ?? !this.drawers[panel];
      this.drawers = { sidebar: false, inspector: false };
      this.drawers[panel] = next;
    } else {
      this.state[panel].open = open ?? !this.state[panel].open;
      this.save();
    }
    this.apply();
  }
  closeDrawers() { if (this.drawers.sidebar || this.drawers.inspector) { this.drawers = { sidebar: false, inspector: false }; this.apply(); } }
  resize(panel, width) {
    this.state[panel].width = clampWidth(panel, width, { viewport: window.innerWidth, other: this.other(panel) });
    this.save(); this.apply();
  }
  reset() { this.state = { ...defaultLayout(), prose: this.state.prose, column: this.state.column, textSize: this.state.textSize, theme: this.state.theme, colors: this.state.colors }; this.save(); this.closeDrawers(); this.apply(); }
  setTextSize(value) { if (!validTextSize(value)) return; this.state.textSize = value; this.save(); this.apply(); }
  resetText() { this.state.textSize = TEXT_SIZE.initial; this.save(); this.apply(); }
  setProse(value) { this.state.prose = value; this.save(); this.apply(); }
  setColumn(value) { if (!COLUMNS.some(entry => entry.value === value)) return; this.state.column = value; this.save(); this.apply(); }
  setTheme(value) {
    if (!THEMES.includes(value)) return;
    this.state.theme = value;
    this.save(); this.apply();
  }
  setColor(client, hue) {
    if (!CLIENTS.some(entry => entry.id === client) || !HUES.some(entry => entry.id === hue)) return;
    this.state.colors = { ...this.state.colors, [client]: hue };
    this.save(); this.apply();
  }
  resetColors() { this.state.colors = { ...DEFAULT_COLORS }; this.save(); this.apply(); }
  appearance() { return appearanceOf(this.state.theme); }

  bindResizer(element) {
    const panel = element.dataset.panel;
    // Sidebar grows to the right, the inspector to the left.
    const direction = panel === 'sidebar' ? 1 : -1;
    element.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const start = event.clientX, initial = this.state[panel].width;
      element.setPointerCapture(event.pointerId);
      this.body.classList.add('is-resizing');
      const move = moveEvent => {
        const width = clampWidth(panel, initial + (moveEvent.clientX - start) * direction, { viewport: window.innerWidth, other: this.other(panel) });
        this.state[panel].width = width;
        this.root.style.setProperty(`--${panel}-w`, `${width}px`);
        element.setAttribute('aria-valuenow', String(width));
      };
      const end = () => {
        element.removeEventListener('pointermove', move);
        element.removeEventListener('pointerup', end);
        element.removeEventListener('pointercancel', end);
        this.body.classList.remove('is-resizing');
        this.save(); this.apply();
      };
      element.addEventListener('pointermove', move);
      element.addEventListener('pointerup', end);
      element.addEventListener('pointercancel', end);
    });
    element.addEventListener('dblclick', () => this.resize(panel, PANEL_LIMITS[panel].initial));
    element.addEventListener('keydown', event => {
      const step = event.shiftKey ? 48 : 16, width = this.state[panel].width;
      const keys = { ArrowLeft: width - step * direction, ArrowRight: width + step * direction, Home: PANEL_LIMITS[panel].min, End: PANEL_LIMITS[panel].max };
      if (event.key in keys) { event.preventDefault(); this.resize(panel, keys[event.key]); }
      else if (event.key === 'Enter') { event.preventDefault(); this.toggle(panel, false); document.getElementById(`${panel}-toggle`)?.focus(); }
    });
  }
}

/** One shared tooltip: hover with a short delay, keyboard focus and touch on non-interactive chips. */
export class Tooltips {
  constructor(tip = document.getElementById('tooltip')) {
    this.tip = tip; this.target = null; this.timer = null;
    const find = node => node?.closest?.('[data-tip]');
    document.addEventListener('pointerover', event => {
      if (event.pointerType !== 'mouse') return;
      const target = find(event.target);
      if (target === this.target) return;
      if (!target) { this.hide(); return; }
      this.schedule(target, 450);
    });
    document.addEventListener('pointerout', event => { if (!event.relatedTarget) this.hide(); });
    document.addEventListener('pointerdown', event => {
      const target = find(event.target);
      // Touch reveals the explanation of chips and labels; controls keep their normal action.
      if (event.pointerType === 'touch' && target && !target.matches('button,select,input,textarea,a')) { this.show(target); return; }
      this.hide();
    });
    document.addEventListener('focusin', event => {
      const target = find(event.target);
      if (target && target.matches(':focus-visible')) this.schedule(target, 150); else this.hide();
    });
    document.addEventListener('focusout', () => this.hide());
    document.addEventListener('keydown', event => { if (event.key === 'Escape') this.hide(); });
    document.addEventListener('scroll', () => this.hide(), true);
  }
  schedule(target, delay) { clearTimeout(this.timer); this.timer = setTimeout(() => this.show(target), delay); }
  show(target) {
    clearTimeout(this.timer);
    const text = target.dataset.tip;
    if (!text || !target.isConnected) { this.hide(); return; }
    this.release();
    this.target = target;
    this.tip.textContent = text;
    this.tip.hidden = false;
    target.setAttribute('aria-describedby', 'tooltip');
    const box = target.getBoundingClientRect(), tip = this.tip.getBoundingClientRect(), margin = 8;
    let top = box.top - tip.height - margin;
    let placement = 'top';
    if (top < margin) { top = box.bottom + margin; placement = 'bottom'; }
    const left = Math.min(Math.max(margin, box.left + box.width / 2 - tip.width / 2), window.innerWidth - tip.width - margin);
    this.tip.dataset.placement = placement;
    this.tip.style.left = `${Math.round(left)}px`;
    this.tip.style.top = `${Math.round(Math.min(top, window.innerHeight - tip.height - margin))}px`;
  }
  release() { if (this.target?.getAttribute('aria-describedby') === 'tooltip') this.target.removeAttribute('aria-describedby'); }
  hide() { clearTimeout(this.timer); this.release(); this.target = null; this.tip.hidden = true; }
}

/** Appearance chooser: one radio list, shown as a popover from the top bar and inline in settings. */
export class AppearanceMenu {
  constructor({ layout, trigger, inline, onChange = () => {} }) {
    Object.assign(this, { layout, trigger, inline, onChange });
    this.popover = document.createElement('div');
    this.popover.className = 'appearance-menu';
    this.popover.id = 'appearance-menu';
    this.popover.hidden = true;
    this.popover.setAttribute('role', 'menu');
    this.popover.setAttribute('aria-label', 'Aparência');
    document.body.append(this.popover);
    trigger?.setAttribute('aria-haspopup', 'menu');
    trigger?.setAttribute('aria-controls', 'appearance-menu');
    trigger?.setAttribute('aria-expanded', 'false');
    trigger?.addEventListener('click', event => { event.stopPropagation(); this.popover.hidden ? this.open() : this.close(); });
    document.addEventListener('pointerdown', event => { if (!this.popover.hidden && !this.popover.contains(event.target) && !trigger?.contains(event.target)) this.close(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !this.popover.hidden) { this.close(); trigger?.focus(); } });
    window.addEventListener('resize', () => this.close());
    this.popover.addEventListener('keydown', event => {
      const items = [...this.popover.querySelectorAll('[role="menuitemradio"]')];
      const index = items.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      } else if (event.key === 'Tab') this.close();
    });
    layout.onChange(() => this.render());
    this.render();
  }
  item(entry, role) {
    const selected = this.layout.appearance() === entry;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'appearance-option';
    button.setAttribute('role', role);
    button.setAttribute('aria-checked', String(selected));
    const swatch = document.createElement('span');
    swatch.className = 'appearance-swatch';
    swatch.dataset.swatch = entry.swatch;
    swatch.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'appearance-text';
    const name = document.createElement('strong');
    name.textContent = entry.name;
    const description = document.createElement('small');
    description.textContent = entry.description;
    text.append(name, description);
    const check = document.createElement('span');
    check.className = 'appearance-check';
    check.setAttribute('aria-hidden', 'true');
    button.append(swatch, text, check);
    button.addEventListener('click', () => {
      this.layout.setTheme(entry.theme);
      this.onChange(entry);
      if (role === 'menuitemradio') { this.close(); this.trigger?.focus(); }
    });
    return button;
  }
  fill(container, role) {
    container.replaceChildren(...APPEARANCES.map(entry => this.item(entry, role)));
  }
  render() {
    const current = this.layout.appearance();
    if (this.trigger) {
      const label = this.trigger.querySelector('#theme-label');
      if (label) label.textContent = current.name;
      const swatch = this.trigger.querySelector('.appearance-swatch');
      if (swatch) swatch.dataset.swatch = current.swatch;
      this.trigger.dataset.tip = `Aparência: ${current.name}. Clica para escolher a aparência.`;
    }
    this.fill(this.popover, 'menuitemradio');
    if (this.inline) this.fill(this.inline, 'radio');
  }
  open() {
    this.render();
    this.popover.hidden = false;
    this.trigger?.setAttribute('aria-expanded', 'true');
    const box = this.trigger.getBoundingClientRect(), menu = this.popover.getBoundingClientRect(), margin = 8;
    const left = Math.min(Math.max(margin, box.right - menu.width), window.innerWidth - menu.width - margin);
    this.popover.style.left = `${Math.round(left)}px`;
    this.popover.style.top = `${Math.round(Math.min(box.bottom + 6, window.innerHeight - menu.height - margin))}px`;
    (this.popover.querySelector('[aria-checked="true"]') || this.popover.querySelector('[role="menuitemradio"]'))?.focus();
  }
  close() { if (this.popover.hidden) return; this.popover.hidden = true; this.trigger?.setAttribute('aria-expanded', 'false'); }
}

/** Client colours: one radio group of hue swatches per client, shown in the settings. */
export class ClientColors {
  constructor({ layout, container }) {
    Object.assign(this, { layout, container });
    layout.onChange(() => this.sync());
    this.render();
  }
  render() {
    this.container.replaceChildren(...CLIENTS.map(client => {
      const row = document.createElement('div');
      row.className = 'client-color-row';
      row.dataset.client = client.id;
      const label = document.createElement('span');
      label.className = 'client-color-name';
      label.id = `client-color-${client.id}`;
      label.textContent = client.name;
      const group = document.createElement('div');
      group.className = 'client-color-swatches';
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-labelledby', label.id);
      for (const hue of HUES) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'hue-swatch';
        button.dataset.hue = hue.id;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-label', hue.name);
        button.dataset.tip = `${client.name} · ${hue.name}`;
        button.addEventListener('click', () => this.layout.setColor(client.id, hue.id));
        group.append(button);
      }
      // Radio-group keys: arrows move and choose, Home/End jump to the ends.
      group.addEventListener('keydown', event => {
        const buttons = [...group.querySelectorAll('.hue-swatch')];
        const index = buttons.indexOf(document.activeElement);
        const next = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: buttons.length - 1 }[event.key];
        if (next === undefined || index < 0) return;
        event.preventDefault();
        const target = buttons[(next + buttons.length) % buttons.length];
        this.layout.setColor(client.id, target.dataset.hue);
        target.focus();
      });
      row.append(label, group);
      return row;
    }));
    this.sync();
  }
  sync() {
    for (const row of this.container.querySelectorAll('.client-color-row')) {
      const chosen = this.layout.state.colors[row.dataset.client];
      for (const button of row.querySelectorAll('.hue-swatch')) {
        const on = button.dataset.hue === chosen;
        button.setAttribute('aria-checked', String(on));
        button.tabIndex = on ? 0 : -1;
      }
    }
  }
}
