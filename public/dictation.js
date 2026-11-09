import { t as uiText } from './i18n.js';
const MAX_MS = 5 * 60_000, MAX_BYTES = 25_000_000;
const node = (tag, className, text) => { const el = document.createElement(tag); el.className = className; if (text) el.textContent = text; return el; };

export class Dictation {
  constructor({ composer, input, getKey, getToken, changed, toast }) {
    Object.assign(this, { input, getKey, getToken, changed, toast });
    this.phase = 'idle'; this.generation = 0;
    this.button = node('button', 'dictate');
    this.button.id = 'dictate'; this.button.type = 'button';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) svg.setAttribute(key,value);
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d','M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-3 6v1a6 6 0 0 0 12 0v-1M12 18v4m-4 0h8');
    svg.append(path); this.button.append(svg);
    this.button.setAttribute('aria-pressed', 'false');
    const send = composer.querySelector('#send');
    send.parentElement.prepend(this.button);
    this.panel = node('div', 'dictation-panel'); this.panel.hidden = true;
    this.status = node('span', 'dictation-status'); this.status.setAttribute('role', 'status');
    this.cancelButton = node('button', 'pill-toggle', uiText('Cancelar')); this.cancelButton.type = 'button';
    this.panel.append(this.status, this.cancelButton); input.after(this.panel);
    this.button.addEventListener('click', () => this.phase === 'recording' ? this.stop() : this.start());
    this.cancelButton.addEventListener('click', () => this.cancel());
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && this.active) { event.preventDefault(); this.cancel(); } });
    window.addEventListener('pagehide', () => this.cancel());
    this.render();
  }
  get active() { return this.phase !== 'idle'; }
  render() {
    const supported = Boolean(navigator.mediaDevices?.getUserMedia && globalThis.MediaRecorder);
    this.button.disabled = !supported || !['idle', 'recording'].includes(this.phase);
    const label = this.phase === 'recording' ? 'Terminar ditado' : this.phase === 'transcribing' ? 'A transcrever…' : uiText('Ditar mensagem');
    this.button.dataset.phase = this.phase;
    this.button.title = this.phase === 'idle' ? uiText('Ditar mensagem · áudio enviado à Groq') : label;
    this.button.setAttribute('aria-pressed', String(this.phase === 'recording'));
    this.button.setAttribute('aria-label', supported ? label : uiText('Ditado indisponível neste navegador'));
    this.panel.hidden = !this.active;
    this.status.textContent = this.phase === 'recording' ? uiText`A gravar · ${Math.floor((Date.now() - this.startedAt) / 1000)} s · Termina para transcrever (máximo 5 min)` : this.phase === 'transcribing' ? uiText('A transcrever na Groq · o texto ficará na caixa para rever e enviar.') : 'A preparar o microfone…';
  }
  sync() { if (this.active && this.key !== this.getKey()) this.cancel(); }
  update() { this.render(); this.changed(); }
  async start() {
    if (this.active) return;
    const generation = ++this.generation;
    this.key = this.getKey(); this.phase = 'preparing'; this.controller = new AbortController(); this.update();
    try {
      const response = await fetch('/api/dictation', { headers: { 'x-hydraq-token': this.getToken() }, signal: this.controller.signal });
      if (generation !== this.generation) return;
      if (response.status === 404 || response.status === 405) throw Error(uiText('Reinicia o servidor HYDRAQ e recarrega a página para ativar o ditado.'));
      const config = await response.json();
      if (!response.ok) throw Error(config.error || uiText('Não foi possível preparar o ditado.'));
      if (!config.available) throw Error('Configura GROQ_API_KEY no ambiente do servidor HYDRAQ e reinicia-o para usar o ditado.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw Error(uiText('Este navegador não suporta um formato de gravação compatível.'));
      const recorder = this.recorder = new MediaRecorder(stream, { mimeType });
      const chunks = []; let bytes = 0;
      recorder.addEventListener('dataavailable', event => {
        if (generation !== this.generation || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > MAX_BYTES) { this.cancel(); this.toast(uiText('A gravação excedeu 25 MB. Grava uma mensagem mais curta.')); return; }
        chunks.push(event.data);
      });
      recorder.addEventListener('error', () => { if (generation === this.generation) { this.cancel(); this.toast(uiText('Falha na gravação do microfone. Tenta novamente.')); } });
      recorder.addEventListener('stop', () => {
        if (generation === this.generation) { this.releaseMicrophone(); this.transcribe(new Blob(chunks, { type: mimeType }), generation); }
      });
      recorder.start(1000); this.startedAt = Date.now(); this.phase = 'recording';
      this.timer = setTimeout(() => this.stop(), MAX_MS);
      this.ticker = setInterval(() => this.render(), 1000); this.update();
    } catch (error) { if (generation === this.generation) { this.cancel(); this.toast(error.name === 'NotAllowedError' ? uiText('Permite o acesso ao microfone no navegador para ditar.') : error.name === 'NotFoundError' ? uiText('Não foi encontrado um microfone.') : error.message); } }
  }
  releaseMicrophone() {
    clearTimeout(this.timer); clearInterval(this.ticker);
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
  }
  stop() { if (this.phase !== 'recording') return; this.phase = 'transcribing'; this.recorder.stop(); this.releaseMicrophone(); this.update(); }
  cancel() {
    ++this.generation; this.controller?.abort();
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.releaseMicrophone(); this.phase = 'idle'; this.update();
  }
  async transcribe(blob, generation) {
    this.phase = 'transcribing'; this.update();
    const controller = this.controller;
    const timeout = setTimeout(() => controller.abort(), 70_000);
    try {
      const response = await fetch('/api/dictation', { method: 'POST', headers: { 'x-hydraq-token': this.getToken(), 'Content-Type': blob.type }, body: blob, signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || uiText('Não foi possível transcrever a gravação.'));
      if (generation !== this.generation || this.key !== this.getKey()) return;
      const text = this.input.value, addition = (text && !/\s$/.test(text) ? ' ' : '') + result.text;
      if (this.input.maxLength >= 0 && (text + addition).length > this.input.maxLength) throw Error(uiText('O texto transcrito não cabe na mensagem. Envia ou encurta o rascunho antes de voltar a ditar.'));
      this.input.value = text + addition;
      this.input.dispatchEvent(new Event('input', { bubbles: true })); this.input.focus();
      this.toast(uiText('Ditado acrescentado. Revê o texto e carrega em Enviar.'));
    } catch (error) { if (generation === this.generation) this.toast(error.name === 'AbortError' ? uiText('A transcrição demorou demasiado. Tenta novamente.') : error.message); }
    finally { clearTimeout(timeout); if (generation === this.generation) { this.phase = 'idle'; this.update(); } }
  }
}
