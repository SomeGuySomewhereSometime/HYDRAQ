// Keep the old launcher usable if an older running server has not yet exposed the new asset.
const { createMascotCharacter } = await import('./mascot-character.js').catch(() => ({}));

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const STATUS_LABELS = {
  offline: 'Desligada',
  tracking: 'A acompanhar trabalho',
  connecting: 'A ligar…',
  listening: 'A ouvir',
  responding: 'A responder',
  muted: 'Microfone silenciado',
  reconnecting: 'A reconectar…',
  error: 'Com erro',
};

const CLIENT_LABELS = { codex: 'Codex', claude: 'Claude Code', antigravity: 'Gemini', cursor: 'Cursor', opencode: 'OpenCode' };

export function mascotColorProvider({ projectId, conversations = [], sourceGroupId = null, selectedProvider = 'codex', voiceStatus = 'offline' }) {
  const active = conversations.filter(c => projectId && c.organization?.projectId === projectId
    && ['starting', 'running', 'waiting'].includes(c.status) && CLIENT_LABELS[c.provider]);
  // Prefer the conversation being watched; otherwise show the most recently started task.
  const watched = active.find(c => sourceGroupId && (c.group || c.id) === sourceGroupId);
  const latest = [...active].sort((a, b) => String(b.turns?.at(-1)?.startedAt || b.updatedAt || '').localeCompare(String(a.turns?.at(-1)?.startedAt || a.updatedAt || '')))[0];
  if (watched || latest) return (watched || latest).provider;
  if (voiceStatus === 'responding') return 'antigravity'; // Gemini Live uses the same color as Gemini.
  return CLIENT_LABELS[selectedProvider] ? selectedProvider : 'codex';
}

const KIND_LABELS = {
  'user-statement': 'Declaração do utilizador',
  proposal: 'Proposta',
  decision: 'Decisão',
  'client-result': 'Resultado de cliente',
  preference: 'Preferência',
  pending: 'Assunto pendente',
};

const DELEGATION_STATUS_LABELS = {
  'creating-conversation': 'A preparar pedido…',
  waiting: 'Aguarda autorização',
  interrupted: 'Interrompido',
  limited: 'Limite atingido',
  sending: 'A enviar pedido…',
  running: 'Pedido enviado · em execução',
  completed: 'Concluído',
  failed: 'Falhou',
  uncertain: 'Resultado incerto',
};

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = (ms / 1000).toFixed(1).replace('.', ',');
  return `${seconds} s`;
}

function float32Rms(float32Array) {
  if (!float32Array?.length) return 0;
  let sumSq = 0;
  for (let i = 0; i < float32Array.length; i++) {
    const s = float32Array[i] || 0;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / float32Array.length);
}

function pcm16ToBase64(float32Array, inputSampleRate) {
  const targetRate = 16000;
  const ratio = inputSampleRate / targetRate;
  const outLength = Math.max(1, Math.floor(float32Array.length / ratio));
  const pcm16 = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const sample = Math.max(-1, Math.min(1, float32Array[Math.floor(i * ratio)] || 0));
    pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToFloat32(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pcm16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;
  return float32;
}

// Only delegated requests and their replies join the normal transcript.
// The companion's informal messages never enter this collection.
export function companionRequest(owner, message) {
  const origin = owner?.organization?.companion;
  const turn = owner?.turns?.find(t => message.requestId && t.requestId === message.requestId || message.turnId && t.id === message.turnId);
  const requestId = message.requestId || turn?.requestId;
  if (origin?.requestId === requestId) return origin;
  // Existing delegations predate explicit provenance metadata.
  if (requestId?.startsWith('companion-')) return { name: 'Hydra', requestId };
  return null;
}

export function companionTranscriptOwners(conversations, conversation, group) {
  if (!conversation) return group;
  const groupId = conversation.group || conversation.id;
  const projectId = conversation.organization?.projectId;
  const seen = new Set(group.map(c => c.id));
  const delegated = conversations.filter(c => !seen.has(c.id)
    && projectId && c.organization?.projectId === projectId
    && c.organization?.companion?.sourceGroupId === groupId);
  return [...group, ...delegated.map(c => {
    const turns = c.turns?.filter(t => t.requestId === c.organization.companion.requestId) || [];
    return { ...c, messages: c.messages.filter(m => companionRequest(c, m)), turns,
      items: c.items?.filter(i => turns.some(t => t.id === i.turnId)) || [], handoffState: null };
  })];
}

export class CompanionUI {
  constructor({ api, getState, getProject, getToken, getSourceGroup = () => null, getSelectedProvider = () => 'codex', chooseConversation, choose, toast, markdown }) {
    Object.assign(this, { api, getState, getProject, getToken, getSourceGroup, getSelectedProvider, toast, markdown });
    this.drafts = new Map();
    this.refreshSequence = 0;
    this.expanded = false;
    this.optionsOpen = false;
    this.chooseConversation = chooseConversation || choose || null;
    this.open = false;
    this.subview = 'chat'; // 'chat' | 'memory' | 'identity'
    this.projectId = null;
    this.data = null;
    this.loading = false;
    this.liveStatus = 'offline';
    this.interactionStatus = 'IDLE';
    this.muted = false;
    this.pttActive = false;
    this.liveInputDraft = '';
    this.liveOutputDraft = '';
    this.liveError = null;
    this.ws = null;
    this.audioCtx = null;
    this.micStream = null;
    this.micSource = null;
    this.micProcessor = null;
    this.playbackNodes = new Set();
    this.nextPlayTime = 0;

    this.#mount();
    window.addEventListener('pagehide', () => this.disconnectLive());
  }

  #mount() {
    this.root = el('div', 'companion-root');
    this.launcher = el('button', 'companion-launcher');
    this.launcher.id = 'companion-launcher';
    this.launcher.type = 'button';
    this.launcher.setAttribute('aria-expanded', 'false');
    this.launcher.setAttribute('aria-controls', 'companion-panel');

    this.orb = el('span', 'companion-orb');
    this.launcherLabel = el('span', 'companion-launcher-label', 'Mascote');
    this.launcherState = el('small', 'companion-launcher-state', 'Desligada');
    this.badge = el('span', 'companion-badge hidden', '0');
    this.character = null;
    this.launcher.append(this.orb, this.launcherLabel, this.launcherState, this.badge);
    this.launcher.addEventListener('click', () => {
      if (this.suppressLauncherClick) { this.suppressLauncherClick = false; return; }
      this.togglePanel();
    });

    this.panel = el('section', 'companion-panel hidden');
    this.panel.id = 'companion-panel';
    this.panel.setAttribute('aria-label', 'Mascote do projeto · Assistente de voz Live');

    this.root.append(this.panel, this.launcher);
    document.body.append(this.root);
    this.#enableMascotDragging();
    let enabled = true;
    try { enabled = localStorage.getItem('hydraq.mascot.animation') !== 'off'; } catch { /* Use the default. */ }
    this.#setMascotAnimation(enabled, false);
  }

  #setMascotAnimation(enabled, persist = true) {
    this.mascotAnimation = enabled;
    if (persist) {
      try { localStorage.setItem('hydraq.mascot.animation', enabled ? 'on' : 'off'); } catch { /* Keep the choice for this page. */ }
    }
    if (!enabled) { this.character?.destroy(); this.character = null; }
    else if (!this.character) {
      this.character = createMascotCharacter?.() || null;
      if (this.character) {
        this.launcher.prepend(this.character.element);
        this.character.setExpanded(this.open);
      }
    }
    this.root.classList.toggle('has-mascot', Boolean(this.character));
    this.launcher.classList.toggle('has-mascot', Boolean(this.character));
    this.launcher.title = this.character ? 'Clica para abrir a mascote · arrasta para a mover' : 'Abrir o assistente';
    this.renderLauncher();
  }

  #animationButton() {
    const button = this.#btn(this.mascotAnimation ? 'Desligar animação' : 'Ligar animação', () => {
      this.#setMascotAnimation(!this.mascotAnimation);
      this.renderPanel();
    }, 'pill-toggle');
    button.setAttribute('aria-pressed', String(this.mascotAnimation));
    button.title = 'Liga ou desliga a personagem animada neste navegador; a voz é controlada separadamente.';
    return button;
  }

  #placeMascot(x, y, remember = false) {
    const bounds = this.root.getBoundingClientRect();
    const launcher = this.launcher.getBoundingClientRect();
    const clamp = (value, max) => Math.min(Math.max(8, value), Math.max(8, max - 8));
    const left = clamp(bounds.left + x - launcher.left, window.innerWidth - bounds.width);
    const top = clamp(bounds.top + y - launcher.top, window.innerHeight - bounds.height);
    Object.assign(this.root.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
    if (remember) {
      const placed = this.launcher.getBoundingClientRect();
      try { localStorage.setItem('hydraq.mascot.position', JSON.stringify({ x: (placed.left + placed.width / 2) / window.innerWidth, y: (placed.top + placed.height / 2) / window.innerHeight })); }
      catch { /* The current position still works without storage. */ }
    }
  }

  #enableMascotDragging() {
    let drag = null;
    this.launcher.addEventListener('pointerdown', event => {
      if (!this.character || !event.isPrimary || event.button !== 0) return;
      const rect = this.launcher.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
      this.launcher.setPointerCapture(event.pointerId);
    });
    this.launcher.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 8) return;
      drag.moved = true;
      this.root.classList.add('dragging');
      this.#placeMascot(drag.left + dx, drag.top + dy);
      event.preventDefault();
    });
    const finish = event => {
      if (!drag || event.pointerId !== drag.id) return;
      if (drag.moved) {
        const rect = this.launcher.getBoundingClientRect();
        this.#placeMascot(rect.left, rect.top, true);
        this.suppressLauncherClick = true;
        setTimeout(() => { this.suppressLauncherClick = false; }, 0);
      }
      drag = null;
      this.root.classList.remove('dragging');
    };
    this.launcher.addEventListener('pointerup', finish);
    this.launcher.addEventListener('pointercancel', finish);
    window.addEventListener('resize', () => {
      if (!this.root.style.left) return;
      const rect = this.launcher.getBoundingClientRect();
      this.#placeMascot(rect.left, rect.top);
    });
    try {
      const saved = JSON.parse(localStorage.getItem('hydraq.mascot.position'));
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && saved.x >= 0 && saved.x <= 1 && saved.y >= 0 && saved.y <= 1) {
        requestAnimationFrame(() => {
          const rect = this.launcher.getBoundingClientRect();
          this.#placeMascot(saved.x * window.innerWidth - rect.width / 2, saved.y * window.innerHeight - rect.height / 2);
        });
      }
    } catch { /* Invalid saved positions fall back to the bottom-right corner. */ }
  }

  effectiveStatus() {
    if (this.liveError && this.liveStatus === 'error') return 'error';
    if (this.ws && this.liveStatus !== 'offline') {
      if (this.muted && this.liveStatus === 'listening') return 'muted';
      return this.liveStatus;
    }
    const projectId = this.getProject()?.id;
    const running = (projectId && this.getState()?.conversations?.some(c => c.organization?.projectId === projectId && ['starting', 'running', 'waiting'].includes(c.status))) || this.data?.liveState?.runningTasks?.length || 0;
    return running > 0 ? 'tracking' : 'offline';
  }

  sync() {
    const sourceGroupId = this.getSourceGroup();
    if (this.ws?.readyState === WebSocket.OPEN && sourceGroupId !== this.sourceGroupId) {
      this.ws.send(JSON.stringify({ type: 'conversation_context', sourceGroupId }));
    }
    this.sourceGroupId = sourceGroupId;
    const project = this.getProject();
    const nextProjectId = project?.id || null;
    if (nextProjectId !== this.projectId) {
      if (this.ws) this.disconnectLive();
      this.projectId = nextProjectId;
      this.data = null;
      this.liveError = null;
      if (this.open && this.projectId) {
        this.refresh().catch(() => {});
      }
    } else if (this.projectId && this.open && !this.loading && !this.data) {
      this.refresh().catch(() => {});
    }
    this.renderLauncher();
    // Delegation progress also arrives on the app's state stream while voice is off.
    if (this.data?.actions?.length) {
      const conversations = this.getState()?.conversations || [];
      this.data.actions = this.data.actions.map(action => {
        const owner = conversations.find(c => c.id === action.targetConversationId && c.organization?.projectId === this.projectId);
        const turn = owner?.turns?.find(t => t.requestId === action.requestId);
        if (!turn) return action;
        const replies = owner.messages.filter(m => m.role === 'assistant' && (m.requestId === turn.requestId || m.turnId === turn.id));
        const durationMs = turn.completedAt ? Date.parse(turn.completedAt) - Date.parse(turn.startedAt) : action.durationMs;
        return { ...action, status: turn.status, completedAt: turn.completedAt, durationMs,
          ...(turn.status === 'completed' && replies.length ? { claimedConclusion: replies.map(m => m.text).join('\n\n') } : {}),
          ...(turn.error ? { error: turn.error } : {}),
        };
      });
    }
    if (this.open) this.renderPanel();
  }

  async togglePanel(force) {
    const oldPosition = this.launcher.getBoundingClientRect();
    this.open = force !== undefined ? Boolean(force) : !this.open;
    this.root.classList.toggle('align-left', this.open && oldPosition.left < window.innerWidth / 2);
    this.launcher.setAttribute('aria-expanded', String(this.open));
    this.panel.classList.toggle('hidden', !this.open);
    this.character?.setExpanded(this.open);
    this.renderLauncher();
    if (this.root.style.left) this.#placeMascot(oldPosition.left, oldPosition.top);
    if (this.open && this.projectId) {
      await this.refresh();
    } else {
      this.renderPanel();
    }
  }

  async refresh(conversationId = null) {
    if (!this.projectId) {
      this.renderLauncher();
      this.renderPanel();
      return;
    }
    this.loading = true;
    const projectId = this.projectId;
    const sequence = ++this.refreshSequence;
    try {
      const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : '';
      const data = await this.api(`/api/projects/${projectId}/companion${query}`);
      if (projectId !== this.projectId || sequence !== this.refreshSequence) return;
      if (!conversationId && this.data?.activeConversation?.id === data.activeConversation?.id) {
        const merged = new Map((this.data.messages || []).map(m => [m.id, m]));
        for (const m of data.messages || []) merged.set(m.id, m);
        data.messages = [...merged.values()].sort((a, b) => a.at.localeCompare(b.at));
        data.nextBlockCursor = this.data.nextBlockCursor;
      }
      this.data = data;
    } catch (error) {
      this.toast(error.message);
    } finally {
      if (projectId !== this.projectId || sequence !== this.refreshSequence) return;
      this.loading = false;
      this.renderLauncher();
      if (this.open) this.renderPanel();
    }
  }

  async loadOlderMessages() {
    if (!this.projectId || !this.data?.nextBlockCursor || !this.data?.activeConversation?.id) return;
    try {
      const cid = this.data.activeConversation.id;
      const projectId = this.projectId;
      const viewport = this.panel.querySelector('#companion-messages');
      const oldHeight = viewport?.scrollHeight || 0;
      const oldTop = viewport?.scrollTop || 0;
      const older = await this.api(`/api/projects/${this.projectId}/companion?conversationId=${encodeURIComponent(cid)}&beforeBlock=${this.data.nextBlockCursor}`);
      if (projectId !== this.projectId || cid !== this.data?.activeConversation?.id) return;
      const existingIds = new Set((this.data.messages || []).map(m => m.id));
      const merged = [...(older.messages || []).filter(m => !existingIds.has(m.id)), ...(this.data.messages || [])];
      this.data.messages = merged;
      this.data.nextBlockCursor = older.nextBlockCursor;
      this.renderPanel();
      const nextViewport = this.panel.querySelector('#companion-messages');
      if (nextViewport) nextViewport.scrollTop = oldTop + nextViewport.scrollHeight - oldHeight;
    } catch (error) {
      this.toast(error.message);
    }
  }

  renderLauncher() {
    const project = this.getProject();
    const colorProvider = mascotColorProvider({ projectId: project?.id, conversations: this.getState()?.conversations || [], sourceGroupId: this.getSourceGroup(), selectedProvider: this.getSelectedProvider(), voiceStatus: this.liveStatus });
    this.character?.setProvider?.(colorProvider);
    if (!project) {
      this.root.dataset.status = 'offline';
      this.launcherLabel.textContent = 'Mascote';
      this.launcherState.textContent = 'Escolhe um projeto';
      this.badge.classList.add('hidden');
      this.character?.setStatus('offline');
      this.launcher.setAttribute('aria-label', `${this.open ? 'Fechar' : 'Abrir'} mascote Hydra · escolhe um projeto · cor ${CLIENT_LABELS[colorProvider]}`);
      return;
    }
    const status = this.effectiveStatus();
    this.root.dataset.status = status;
    const name = this.data?.profile?.name || 'Hydra';
    this.launcherLabel.textContent = `${name} · ${project.name}`;
    this.launcherState.textContent = STATUS_LABELS[status] || status;
    this.character?.setStatus(status);
    this.launcher.setAttribute('aria-label', `${this.open ? 'Fechar' : 'Abrir'} mascote ${name} · ${STATUS_LABELS[status] || status} · cor ${CLIENT_LABELS[colorProvider]}`);
    const pendingCount = this.data?.pendingNotifications?.length || 0;
    this.badge.textContent = String(pendingCount);
    this.badge.classList.toggle('hidden', pendingCount === 0);
  }

  renderPanel({ scrollBottom = false } = {}) {
    const prevInputEl = this.panel?.querySelector?.('#companion-text-input');
    if (prevInputEl && this.renderedDraftKey) this.drafts.set(this.renderedDraftKey, prevInputEl.value);
    const draftKey = `${this.projectId}:${this.data?.activeConversation?.id || ''}`;
    const prevDraftText = this.drafts.get(draftKey) || '';
    const selectionStart = prevInputEl?.selectionStart;
    const selectionEnd = prevInputEl?.selectionEnd;
    this.renderedDraftKey = draftKey;
    const hadInputFocus = document.activeElement === prevInputEl;
    const prevMsgEl = this.panel?.querySelector?.('#companion-messages');
    const prevScrollTop = prevMsgEl ? prevMsgEl.scrollTop : null;
    const wasAtBottom = prevMsgEl
      ? (prevMsgEl.scrollHeight - prevMsgEl.scrollTop - prevMsgEl.clientHeight <= 24)
      : true;

    this.panel.classList.toggle('expanded', this.expanded);
    this.panel.replaceChildren();
    const project = this.getProject();
    if (!project) {
      const empty = el('div', 'companion-empty');
      empty.append(
        el('strong', '', 'Associa ou escolhe um projeto'),
        el('p', '', 'Cada projeto do HYDRAQ tem a sua própria mascote com identidade, memória e histórico isolados.'),
        this.#animationButton(),
        this.#btn('Fechar', () => this.togglePanel(false), 'pill-toggle')
      );
      this.panel.append(empty);
      return;
    }

    const profile = this.data?.profile || { name: 'Hydra', voice: 'Puck', style: '' };
    const settings = this.data?.settings || {
      model: 'gemini-3.8-live',
      thinkingLevel: 'low',
      voiceMode: 'hands-free',
      pauseMicWhileSpeaking: false,
      saveHistory: true,
      useMemory: true,
      updateMemory: true,
      temporarySession: false,
    };
    const status = this.effectiveStatus();

    // Header
    const head = el('header', 'companion-head');
    const titleWrap = el('div', 'companion-title-wrap');
    titleWrap.append(
      el('strong', 'companion-name', `${profile.name} · ${project.name}`),
      el('span', `companion-status-pill status-${status}`, STATUS_LABELS[status] || status)
    );
    const nav = el('div', 'companion-nav');
    nav.append(
      this.#btn('Conversa', () => { this.subview = 'chat'; this.renderPanel(); }, `pill-toggle${this.subview === 'chat' ? ' active' : ''}`),
      this.#btn('Memória', () => { this.subview = 'memory'; this.renderPanel(); }, `pill-toggle${this.subview === 'memory' ? ' active' : ''}`),
      this.#btn('Identidade', () => { this.subview = 'identity'; this.renderPanel(); }, `pill-toggle${this.subview === 'identity' ? ' active' : ''}`),
      this.#btn('✕', () => this.togglePanel(false), 'icon-button companion-close')
    );
    const close = nav.lastChild;
    close.setAttribute('aria-label', 'Fechar painel da mascote');
    titleWrap.append(close);
    const expand = this.#btn(this.expanded ? 'Reduzir' : 'Ampliar', () => { this.expanded = !this.expanded; this.renderPanel(); }, 'pill-toggle');
    expand.setAttribute('aria-pressed', String(this.expanded));
    nav.append(expand);
    nav.append(this.#animationButton());
    head.append(titleWrap, nav);
    this.panel.append(head);

    if (this.liveError) {
      const errBanner = el('div', 'notice companion-error', this.liveError);
      this.panel.append(errBanner);
    }

    if (this.subview === 'identity') {
      this.#renderIdentityView(profile, settings);
      return;
    }
    if (this.subview === 'memory') {
      this.#renderMemoryView(settings);
      return;
    }

    this.#renderChatView(project, profile, settings, status);

    const nextInputEl = this.panel?.querySelector?.('#companion-text-input');
    if (nextInputEl) {
      nextInputEl.value = prevDraftText;
      if (hadInputFocus) { nextInputEl.focus({ preventScroll: true }); if (selectionStart !== undefined) nextInputEl.setSelectionRange(selectionStart, selectionEnd); }
    }
    const nextMsgEl = this.panel?.querySelector?.('#companion-messages');
    if (nextMsgEl) {
      if (scrollBottom || wasAtBottom || prevScrollTop === null) {
        nextMsgEl.scrollTop = nextMsgEl.scrollHeight;
      } else {
        nextMsgEl.scrollTop = prevScrollTop;
      }
      const latest = this.panel.querySelector('.companion-latest');
      if (latest) latest.hidden = nextMsgEl.scrollHeight - nextMsgEl.scrollTop - nextMsgEl.clientHeight < 40;
    }
  }

  #renderChatView(project, profile, settings, status) {
    const isConnected = Boolean(this.ws && ['connecting', 'listening', 'responding', 'muted', 'reconnecting'].includes(status));
    const voiceBar = el('div', 'companion-voice-bar');
    const connect = this.#btn(isConnected ? 'Desligar voz' : 'Ligar voz Live', () => isConnected ? this.disconnectLive() : this.connectLive(), 'pill-toggle companion-connect-btn');
    connect.id = 'companion-connect';
    voiceBar.append(connect);
    if (isConnected) {
      if (settings.voiceMode === 'push-to-talk') {
        const talk = this.#btn(this.pttActive ? 'A falar… larga para enviar' : 'Manter premido para falar', () => {}, 'pill-toggle companion-ptt');
        talk.id = 'companion-ptt';
        talk.setAttribute('aria-pressed', String(this.pttActive));
        talk.addEventListener('pointerdown', e => {
          e.preventDefault();
          this.startPushToTalk();
          const finish = () => { this.stopPushToTalk(); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); };
          window.addEventListener('pointerup', finish, { once: true });
          window.addEventListener('pointercancel', finish, { once: true });
        });
        voiceBar.append(talk);
      } else {
        const mute = this.#btn(this.muted ? 'Ativar microfone' : 'Silenciar', () => this.toggleMute(), 'pill-toggle');
        mute.id = 'companion-mute'; voiceBar.append(mute);
      }
      const interrupt = this.#btn('Interromper', () => this.interruptSpeech(), 'pill-toggle');
      interrupt.id = 'companion-interrupt'; voiceBar.append(interrupt);
    }
    const hint = el('span', 'companion-voice-hint', isConnected ? STATUS_LABELS[status] || status : 'Histórico disponível sem ligar a voz');
    voiceBar.append(hint);
    this.panel.append(voiceBar);

    const options = el('details', 'companion-options');
    options.open = this.optionsOpen;
    options.append(el('summary', '', 'Opções de voz e memória'));
    options.addEventListener('toggle', () => { if (options.isConnected) this.optionsOpen = options.open; });
    const controls = el('div', 'companion-options-body');
    const select = (id, label, values, current, change) => {
      const wrap = el('label', 'companion-control', label);
      const control = el('select', 'pill-select'); control.id = id; control.setAttribute('aria-label', label);
      for (const [value, text] of values) { const option = el('option', '', text); option.value = value; control.append(option); }
      control.value = current;
      control.addEventListener('change', () => change(control.value));
      wrap.append(control); controls.append(wrap);
    };
    select('companion-model-select', 'Modelo de voz', [['gemini-3.8-live', '3.8 Live · Rápido'], ['gemini-3.8-live-extended-thinking', '3.8 Extended Thinking']], settings.model, async model => {
      if (await this.#updateSettings({ model }) && isConnected) { this.disconnectLive(); await this.connectLive(); }
    });
    select('companion-voice-mode', 'Microfone', [['hands-free', 'Mãos-livres'], ['push-to-talk', 'Carregar para falar']], settings.voiceMode, voiceMode => this.#updateSettings({ voiceMode }));
    for (const [key, label] of [['pauseMicWhileSpeaking', 'Pausar mic ao falar'], ['saveHistory', 'Guardar histórico'], ['useMemory', 'Usar memória'], ['updateMemory', 'Atualizar memória'], ['temporarySession', 'Sessão temporária']]) {
      const wrap = el('label', 'companion-toggle-chip'); const input = el('input'); input.type = 'checkbox'; input.checked = Boolean(settings[key]); input.dataset.setting = key;
      input.addEventListener('change', () => this.#updateSettings({ [key]: input.checked })); wrap.append(input, el('span', '', label)); controls.append(wrap);
    }
    options.append(controls); this.panel.append(options);

    const convBar = el('div', 'companion-conv-bar');
    const convSelect = el('select', 'pill-select companion-conv-select'); convSelect.setAttribute('aria-label', 'Conversa da mascote');
    for (const c of this.data?.conversations || []) { const opt = el('option', '', `${c.title} · ${c.messageCount || 0} mensagens`); opt.value = c.id; convSelect.append(opt); }
    convSelect.value = this.data?.activeConversation?.id || '';
    convSelect.addEventListener('change', async () => {
      await this.api(`/api/projects/${this.projectId}/companion/conversations`, { action: 'select', conversationId: convSelect.value });
      this.liveInputDraft = ''; this.liveOutputDraft = ''; await this.refresh(convSelect.value);
    });
    convBar.append(convSelect, this.#btn('＋ Nova', async () => {
      const created = await this.api(`/api/projects/${this.projectId}/companion/conversations`, { action: 'create' });
      this.liveInputDraft = ''; this.liveOutputDraft = ''; await this.refresh(created.id);
    }, 'pill-toggle'));
    this.panel.append(convBar);

    const msgList = el('div', 'companion-messages'); msgList.id = 'companion-messages';
    msgList.setAttribute('role', 'region'); msgList.setAttribute('aria-label', 'Mensagens e tarefas da mascote'); msgList.tabIndex = 0;
    if (this.data?.nextBlockCursor) msgList.append(this.#btn('Carregar mensagens anteriores', () => this.loadOlderMessages(), 'text-button companion-load-older'));
    const entries = [
      ...(this.data?.messages || []).map(message => ({ at: message.at, message })),
      ...(this.data?.actions || []).filter(action => !action.companionConversationId || action.companionConversationId === this.data?.activeConversation?.id).map(action => ({ at: action.createdAt, action })),
    ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    if (!entries.length && !this.liveInputDraft && !this.liveOutputDraft) msgList.append(el('p', 'companion-empty-chat', `Fala ou escreve para ${profile.name}. Os pedidos delegados e as respostas aparecem também na conversa normal.`));
    let previousDay = '';
    for (const entry of entries) {
      const date = new Date(entry.at);
      const day = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pt-PT', { day: 'numeric', month: 'long' });
      if (day && day !== previousDay) { msgList.append(el('div', 'companion-day', day)); previousDay = day; }
      if (entry.action) { msgList.append(this.#delegationCard(entry.action, profile)); continue; }
      const m = entry.message;
      const item = el('article', `companion-msg role-${m.role}${m.interrupted ? ' interrupted' : ''}`); item.dataset.messageId = m.id;
      const meta = el('header', 'companion-msg-meta');
      const time = Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
      meta.append(el('strong', '', m.role === 'user' ? 'Tu' : profile.name), el('small', '', `${time}${m.interrupted ? ' · interrompida' : ''}`));
      item.append(meta);
      if (this.markdown && m.role === 'assistant') { const body = this.markdown(m.text || '', `companion-${m.id}`); body.classList.add('companion-msg-text'); item.append(body); }
      else item.append(el('p', 'companion-msg-text', m.text));
      if (!settings.temporarySession && m.text) {
        const details = el('details', 'companion-message-options'); details.append(el('summary', '', 'Mais opções'), this.#btn('Guardar decisão no projeto', () => this.#publishDecision(m), 'text-button')); item.append(details);
      }
      msgList.append(item);
    }
    for (const [text, role, label] of [[this.liveInputDraft, 'user', 'Tu · em direto'], [this.liveOutputDraft, 'assistant', `${profile.name} · a falar…`]]) {
      if (text) { const item = el('article', `companion-msg role-${role} draft`); item.setAttribute('aria-live', 'polite'); item.append(el('strong', '', label), el('p', 'companion-msg-text', text)); msgList.append(item); }
    }
    this.panel.append(msgList);
    const latest = this.#btn('↓ Ir para as mais recentes', () => { msgList.scrollTop = msgList.scrollHeight; latest.hidden = true; }, 'companion-latest text-button');
    latest.hidden = true;
    msgList.addEventListener('scroll', () => { latest.hidden = msgList.scrollHeight - msgList.scrollTop - msgList.clientHeight < 40; });
    this.panel.append(latest);

    const form = el('form', 'companion-composer');
    const input = el('textarea', 'companion-text-input'); input.id = 'companion-text-input'; input.rows = 2; input.maxLength = 4000;
    input.setAttribute('aria-label', isConnected ? 'Mensagem para a mascote' : 'Pedido a delegar ao Codex');
    input.placeholder = isConnected ? `Mensagem para ${profile.name}…` : 'Pedido só de leitura para o Codex…';
    const submit = el('button', 'pill-toggle', isConnected ? 'Enviar' : 'Delegar ao Codex'); submit.type = 'submit';
    form.append(input, submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', async e => {
      e.preventDefault(); const text = input.value.trim(); if (!text || submit.disabled) return;
      if (isConnected) { input.value = ''; this.sendTextLive(text); return; }
      submit.disabled = true;
      const submittedDraftKey = this.renderedDraftKey;
      try {
        await this.api(`/api/projects/${this.projectId}/companion/tool`, { conversationId: this.data?.activeConversation?.id, sourceGroupId: this.getSourceGroup(), call: { name: 'delegar_exploracao', args: { provider: 'codex', prompt: text } } });
        this.drafts.set(submittedDraftKey, '');
        if (this.renderedDraftKey === submittedDraftKey) {
          const currentInput = this.panel.querySelector('#companion-text-input');
          if (currentInput?.value === text) currentInput.value = '';
          await this.refresh();
        }
        this.toast('Pedido da mascote enviado ao Codex.');
      } catch (error) { this.toast(error.message); } finally { submit.disabled = false; }
    });
    this.panel.append(form);
    this.panel.append(el('p', 'companion-privacy-note', 'Só as delegações e as respostas dos modelos entram na conversa normal.'));
  }

  #delegationCard(action, profile) {
    const card = el('article', `companion-delegation-card status-${action.status || 'unknown'}`); card.dataset.actionId = action.id;
    const label = DELEGATION_STATUS_LABELS[action.status] || action.status;
    const duration = Number.isFinite(action.durationMs) ? formatDurationMs(action.durationMs) : '';
    card.append(el('strong', 'companion-delegation-head', `${profile.name} → ${action.provider} · ${label}${duration ? ` · ${duration}` : ''}`), el('p', 'companion-delegation-prompt', action.prompt));
    if (action.claimedConclusion) {
      const details = el('details', 'companion-result'); details.append(el('summary', '', 'Resposta do modelo'));
      if (this.markdown) details.append(this.markdown(action.claimedConclusion, `companion-action-${action.id}`)); else details.append(el('p', '', action.claimedConclusion));
      card.append(details);
    }
    if (action.error) card.append(el('p', 'companion-delegation-error', action.error));
    if (action.targetConversationId && this.chooseConversation) card.append(this.#btn('Abrir pedido e resposta na conversa', () => this.chooseConversation(action.targetConversationId), 'text-button'));
    return card;
  }

  #renderMemoryView(settings) {
    const wrap = el('div', 'companion-subview');
    const memory = this.data?.memory || { summary: { text: '' }, items: [] };

    wrap.append(
      el('p', 'companion-subview-note', 'Desligar a memória nos controlos apenas impede o seu uso ou atualização; não apaga recordações. Apagar aqui enquanto uma sessão Live está ativa recria a sessão sem o item removido.')
    );

    // Summary editor
    const sumLabel = el('label', 'companion-field-label', `Resumo acumulado (cobre até mensagem ${memory.summary?.coveredUntilMessageId || 'n/a'})`);
    const sumInput = el('textarea', 'companion-textarea');
    sumInput.rows = 3;
    sumInput.maxLength = 2500;
    sumInput.value = memory.summary?.text || '';
    const saveSumBtn = this.#btn('Guardar resumo', async () => {
      await this.api(`/api/projects/${this.projectId}/companion/memory`, {
        action: 'update-summary',
        text: sumInput.value,
      });
      this.toast('Resumo da mascote atualizado.');
      await this.refresh();
    }, 'pill-toggle');
    wrap.append(sumLabel, sumInput, saveSumBtn);

    // Add memory item
    const addForm = el('form', 'companion-add-memory');
    const kindSelect = el('select', 'pill-select');
    for (const [k, label] of Object.entries(KIND_LABELS)) {
      const o = el('option', '', label);
      o.value = k;
      kindSelect.append(o);
    }
    const textInput = el('input', 'companion-text-input');
    textInput.placeholder = 'Nova recordação factual…';
    textInput.maxLength = 600;
    const addBtn = el('button', 'pill-toggle', '＋ Recordação');
    addBtn.type = 'submit';
    addForm.append(kindSelect, textInput, addBtn);
    addForm.addEventListener('submit', async e => {
      e.preventDefault();
      if (!textInput.value.trim()) return;
      await this.api(`/api/projects/${this.projectId}/companion/memory`, {
        action: 'add',
        kind: kindSelect.value,
        text: textInput.value.trim(),
        conversationId: this.data?.activeConversation?.id || null,
      });
      textInput.value = '';
      await this.refresh();
    });
    wrap.append(addForm);

    // Items list
    const list = el('div', 'companion-memory-list');
    for (const item of [...(memory.items || [])].reverse()) {
      const row = el('div', 'companion-memory-item');
      row.append(
        el('small', '', `${KIND_LABELS[item.kind] || item.kind} · ${(item.createdAt || '').slice(0, 16).replace('T', ' ')}`),
        el('p', '', item.text)
      );
      const rowActions = el('div', 'companion-memory-actions');
      rowActions.append(
        this.#btn('Corrigir', async () => {
          const edited = prompt('Corrigir recordação:', item.text);
          if (edited && edited.trim() && edited.trim() !== item.text) {
            await this.api(`/api/projects/${this.projectId}/companion/memory`, {
              action: 'update',
              itemId: item.id,
              text: edited.trim(),
            });
            await this.refresh();
          }
        }, 'text-button'),
        this.#btn('Apagar', async () => {
          await this.api(`/api/projects/${this.projectId}/companion/memory`, {
            action: 'delete-item',
            itemId: item.id,
          });
          await this.refresh();
        }, 'text-button')
      );
      row.append(rowActions);
      list.append(row);
    }
    if (!memory.items?.length) list.append(el('p', '', 'Ainda não há recordações guardadas neste projeto.'));
    wrap.append(list);

    // Danger zone: delete active conversation or clear all companion memory
    const clearBar = el('div', 'companion-clear-bar');
    if (this.data?.activeConversation?.id) {
      clearBar.append(this.#btn('Apagar esta conversa', async () => {
        await this.api(`/api/projects/${this.projectId}/companion/conversations`, {
          action: 'delete',
          conversationId: this.data.activeConversation.id,
        });
        this.toast('Conversa da mascote apagada.');
        await this.refresh();
      }, 'text-button'));
    }
    clearBar.append(this.#btn('Apagar toda a memória da mascote', async () => {
      await this.api(`/api/projects/${this.projectId}/companion/memory`, { action: 'clear-all' });
      this.toast('Memória da mascote deste projeto apagada.');
      await this.refresh();
    }, 'text-button'));
    wrap.append(clearBar);
    this.panel.append(wrap);
  }

  #renderIdentityView(profile, settings) {
    const form = el('form', 'companion-subview companion-identity-form');
    const nameInput = el('input', 'companion-text-input');
    nameInput.value = profile.name || 'Hydra';
    nameInput.maxLength = 60;

    const voiceSelect = el('select', 'pill-select');
    for (const v of this.data?.catalog?.voices || ['Puck', 'Aoede', 'Charon', 'Fenrir', 'Kore']) {
      const o = el('option', '', v);
      o.value = v;
      voiceSelect.append(o);
    }
    voiceSelect.value = profile.voice || 'Puck';

    const styleInput = el('textarea', 'companion-textarea');
    styleInput.rows = 2;
    styleInput.maxLength = 300;
    styleInput.value = profile.style || '';

    const modelSelect = el('select', 'pill-select');
    for (const [m, label] of [
      ['gemini-3.8-live', 'gemini-3.8-live (Recomendado · Rápido)'],
      ['gemini-3.8-live-extended-thinking', 'gemini-3.8-live-extended-thinking (Raciocínio alargado)'],
    ]) {
      const o = el('option', '', label);
      o.value = m;
      modelSelect.append(o);
    }
    modelSelect.value = settings.model || 'gemini-3.8-live';

    const thinkingSelect = el('select', 'pill-select');
    for (const [lvl, label] of [['low', 'Leve (low)'], ['medium', 'Médio (medium)'], ['high', 'Alto (high)']]) {
      const o = el('option', '', label);
      o.value = lvl;
      thinkingSelect.append(o);
    }
    thinkingSelect.value = settings.thinkingLevel || 'low';

    const addField = (label, control) => {
      const l = el('label', 'companion-field-label', label);
      l.append(control);
      form.append(l);
    };
    addField('Nome da mascote neste projeto', nameInput);
    addField('Voz (Gemini Live)', voiceSelect);
    addField('Estilo de comunicação', styleInput);
    addField('Modelo Gemini Live', modelSelect);
    addField('Nível de raciocínio (apenas Extended Thinking)', thinkingSelect);

    const saveBtn = el('button', 'pill-toggle', 'Guardar identidade');
    saveBtn.type = 'submit';
    form.append(saveBtn);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      await this.api(`/api/projects/${this.projectId}/companion/profile`, {
        name: nameInput.value.trim(),
        voice: voiceSelect.value,
        style: styleInput.value.trim(),
      });
      await this.#updateSettings({
        model: modelSelect.value,
        thinkingLevel: thinkingSelect.value,
      });
      this.toast('Identidade da mascote guardada.');
      this.subview = 'chat';
      await this.refresh();
    });
    this.panel.append(form);
  }

  async #updateSettings(patch) {
    if (!this.projectId) return;
    try {
      const settings = await this.api(`/api/projects/${this.projectId}/companion/settings`, patch);
      if (this.data) this.data.settings = settings;
      this.renderLauncher();
      if (this.open) this.renderPanel();
      return true;
    } catch (error) {
      this.toast(error.message);
      return false;
    }
  }

  async #publishDecision(message) {
    if (!this.projectId || !this.data?.activeConversation?.id) return;
    try {
      await this.api(`/api/projects/${this.projectId}/companion/publish-decision`, {
        companionConversationId: this.data.activeConversation.id,
        messageId: message.id,
        decisionText: message.text.slice(0, 600),
      });
      this.toast('Decisão publicada na memória oficial do projeto com referência à conversa da mascote.');
    } catch (error) {
      this.toast(error.message);
    }
  }

  async connectLive() {
    if (!this.projectId || this.ws) return;
    this.liveError = null;
    this.liveStatus = 'connecting';
    this.muted = false;
    this.pttActive = false;
    this.renderLauncher();
    this.renderPanel();

    try {
      await this.#setupAudioEngine();
    } catch (error) {
      this.liveStatus = 'error';
      this.liveError = error.name === 'NotAllowedError'
        ? 'Permite o acesso ao microfone no navegador para falar com a mascote.'
        : (error.message || 'Não foi possível preparar o áudio.');
      this.renderLauncher();
      this.renderPanel();
      return;
    }

    const cid = this.data?.activeConversation?.id || '';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.sourceGroupId = this.getSourceGroup();
    const wsUrl = `${proto}//${location.host}/api/companion/live?projectId=${encodeURIComponent(this.projectId)}&conversationId=${encodeURIComponent(cid)}&sourceGroupId=${encodeURIComponent(this.sourceGroupId || '')}&token=${encodeURIComponent(this.getToken())}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.addEventListener('message', event => {
      if (this.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      this.#onWsMessage(msg);
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.#cleanupAudioEngine();
      this.ws = null;
      if (this.liveStatus !== 'error') this.liveStatus = 'offline';
      this.renderLauncher();
      if (this.open) this.renderPanel();
    });

    ws.addEventListener('error', () => {
      if (this.ws !== ws) return;
      this.liveStatus = 'error';
      this.liveError ||= 'Não foi possível estabelecer a ligação Live.';
      this.renderLauncher();
      if (this.open) this.renderPanel();
    });
  }

  #onWsMessage(msg) {
    if (msg.type === 'setup_complete' || msg.type === 'state') {
      if (msg.session) {
        this.liveStatus = msg.session.status || 'listening';
        this.interactionStatus = msg.session.interactionStatus || 'IDLE';
        this.muted = Boolean(msg.session.muted);
      }
      this.renderLauncher();
      if (this.open) this.renderPanel();
      return;
    }

    if (msg.type === 'interim_input_transcription' || msg.type === 'input_transcription') {
      this.liveInputDraft = msg.text || '';
      if (this.open) this.renderPanel();
      return;
    }

    if (msg.type === 'output_transcription') {
      this.liveOutputDraft = msg.text || '';
      if (this.open) this.renderPanel();
      return;
    }

    if (msg.type === 'message_saved' && msg.message) {
      if (msg.message.role === 'user') this.liveInputDraft = '';
      if (msg.message.role === 'assistant') this.liveOutputDraft = '';
      if (this.data) {
        const messages = new Map((this.data.messages || []).map(m => [m.id, m]));
        messages.set(msg.message.id, msg.message);
        this.data.messages = [...messages.values()];
      }
      if (this.open) this.renderPanel();
      return;
    }

    if (msg.type === 'audio' && msg.data) {
      this.#enqueueAudioPlayback(msg.data);
      return;
    }

    if (msg.type === 'interrupted') {
      this.clearPlaybackQueue();
      this.liveOutputDraft = '';
      if (msg.session) this.liveStatus = msg.session.status;
      this.renderLauncher();
      if (this.open) this.renderPanel();
      return;
    }

    if (msg.type === 'action_updated' && msg.action) {
      if (this.data) {
        const current = Array.isArray(this.data.actions) ? [...this.data.actions] : [];
        const idx = current.findIndex(a => a.id === msg.action.id);
        if (idx >= 0) current[idx] = msg.action;
        else current.unshift(msg.action);
        this.data.actions = current;
      }
      if (this.open) this.renderPanel();
      return;
    }

    if (msg.type === 'tool_call') {
      if (msg.name === 'delegar_exploracao') {
        this.toast('A mascote está a delegar uma exploração só de leitura…');
      }
      return;
    }

    if (msg.type === 'tool_error') {
      this.toast(msg.error || 'Erro ao executar ferramenta da mascote.');
      this.refresh().catch(() => {});
      return;
    }

    if (msg.type === 'warning') {
      this.toast(msg.message || 'Aviso na sessão da mascote.');
      if (this.open) this.renderPanel();
      return;
    }

    if (msg.type === 'tool_result' || msg.type === 'project_event') {
      this.refresh().catch(() => {});
      return;
    }

    if (msg.type === 'context_recreated') {
      this.clearPlaybackQueue();
      this.liveInputDraft = '';
      this.liveOutputDraft = '';
      if (msg.conversationId) {
        this.refresh(msg.conversationId).catch(() => {});
      }
      this.toast(msg.message || 'Sessão Live recriada com o contexto atualizado.');
      return;
    }

    if (msg.type === 'error') {
      this.clearPlaybackQueue();
      this.liveStatus = 'error';
      this.liveError = msg.message || 'Erro na sessão Live.';
      this.renderLauncher();
      if (this.open) this.renderPanel();
    }
  }

  async #setupAudioEngine() {
    this.#cleanupAudioEngine();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    this.audioCtx = new AudioCtx();
    this.nextPlayTime = this.audioCtx.currentTime;
    this.micTailFrames = 0;
    if (!navigator.mediaDevices?.getUserMedia) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.micStream = stream;
    this.micSource = this.audioCtx.createMediaStreamSource(stream);
    const processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.micProcessor = processor;
    processor.onaudioprocess = event => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.muted) return;
      const voiceMode = this.data?.settings?.voiceMode || 'hands-free';
      if (voiceMode === 'push-to-talk' && !this.pttActive) return;

      if (this.data?.settings?.pauseMicWhileSpeaking && this.playbackNodes.size > 0) {
        if (this.micTailFrames > 0) {
          this.micTailFrames = 0;
          this.ws.send(JSON.stringify({ type: 'audio_stream_end' }));
        }
        return;
      }

      const input = event.inputBuffer.getChannelData(0);
      if (voiceMode === 'hands-free') {
        const rms = float32Rms(input);
        const SPEECH_RMS_THRESHOLD = 0.006;
        if (rms >= SPEECH_RMS_THRESHOLD) {
          this.micTailFrames = 6; // ~512 ms tail at 4096 samples / 48 kHz
        } else if (this.micTailFrames > 0) {
          this.micTailFrames -= 1;
          if (this.micTailFrames === 0) {
            this.ws.send(JSON.stringify({ type: 'audio_stream_end' }));
            return;
          }
        } else {
          return;
        }
      }

      const base64 = pcm16ToBase64(input, this.audioCtx.sampleRate);
      this.ws.send(JSON.stringify({ type: 'audio', data: base64, mimeType: 'audio/pcm;rate=16000' }));
    };
    this.micSource.connect(processor);
    processor.connect(this.audioCtx.destination);
  }

  #enqueueAudioPlayback(base64) {
    if (!this.audioCtx) return;
    try {
      const float32 = base64ToFloat32(base64);
      const buffer = this.audioCtx.createBuffer(1, float32.length, 24000);
      buffer.getChannelData(0).set(float32);
      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioCtx.destination);
      const startAt = Math.max(this.audioCtx.currentTime, this.nextPlayTime);
      source.start(startAt);
      this.nextPlayTime = startAt + buffer.duration;
      this.playbackNodes.add(source);
      source.onended = () => this.playbackNodes.delete(source);
    } catch { /* ignore playback decode errors */ }
  }

  clearPlaybackQueue() {
    for (const node of this.playbackNodes) {
      try { node.stop(); node.disconnect(); } catch {}
    }
    this.playbackNodes.clear();
    if (this.audioCtx) this.nextPlayTime = this.audioCtx.currentTime;
  }

  #cleanupAudioEngine() {
    this.clearPlaybackQueue();
    if (this.micProcessor) {
      try { this.micProcessor.disconnect(); } catch {}
      this.micProcessor = null;
    }
    if (this.micSource) {
      try { this.micSource.disconnect(); } catch {}
      this.micSource = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach(t => t.stop());
      this.micStream = null;
    }
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch {}
      this.audioCtx = null;
    }
  }

  startPushToTalk() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.pttActive) return;
    this.pttActive = true;
    this.clearPlaybackQueue();
    this.ws.send(JSON.stringify({ type: 'activity_start' }));
    if (this.open) this.renderPanel();
  }

  stopPushToTalk() {
    if (!this.pttActive) return;
    this.pttActive = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'activity_end' }));
    }
    if (this.open) this.renderPanel();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'mute', muted: this.muted }));
    }
    this.renderLauncher();
    if (this.open) this.renderPanel();
  }

  interruptSpeech() {
    this.clearPlaybackQueue();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'interrupt' }));
    }
  }

  sendTextLive(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'text', text }));
  }

  disconnectLive() {
    this.pttActive = false;
    this.liveInputDraft = '';
    this.liveOutputDraft = '';
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
        ws.close();
      } catch {}
    }
    this.#cleanupAudioEngine();
    this.liveStatus = 'offline';
    this.renderLauncher();
    if (this.open) this.renderPanel();
  }

  #btn(text, onClick, cls = '') {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
}
