// Audio is forwarded once to Groq and kept only in memory. Credentials never reach the page.
export const MAX_AUDIO_BYTES = 25_000_000;
export const MAX_RECORDING_MS = 5 * 60_000;
export const DICTATION_MODEL = 'whisper-large-v3';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function inspectAudio(bytes, contentType = '') {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (!bytes.length) throw fail('A gravação está vazia.');
  if (bytes.length > MAX_AUDIO_BYTES) throw fail('A gravação deve ter até 25 MB.', 413);
  const signatures = {
    'audio/webm': () => bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
    'audio/ogg': () => bytes.subarray(0, 4).toString() === 'OggS',
    'audio/mp4': () => bytes.subarray(4, 8).toString() === 'ftyp',
    'audio/wav': () => bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE',
  };
  if (!signatures[mime] || !signatures[mime]()) throw fail('Formato de gravação inválido. Usa WebM, Ogg, MP4 ou WAV.', 415);
  return mime;
}

export class GroqDictation {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 60_000 } = {}) {
    Object.assign(this, { env, fetchImpl, timeoutMs });
    this.busy = false;
  }

  status() {
    return { available: Boolean(this.env.GROQ_API_KEY?.trim()), model: DICTATION_MODEL, maxBytes: MAX_AUDIO_BYTES, maxDurationMs: MAX_RECORDING_MS };
  }

  async transcribe(bytes, contentType, { signal } = {}) {
    const mime = inspectAudio(bytes, contentType);
    const key = this.env.GROQ_API_KEY?.trim();
    if (!key) throw fail('Configura GROQ_API_KEY no ambiente do servidor HYDRAQ e reinicia-o para usar o ditado.', 503);
    if (this.busy) throw fail('Já há uma transcrição em curso. Aguarda e tenta novamente.', 409);
    this.busy = true;
    try {
      const form = new FormData();
      const extension = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav' }[mime];
      form.append('file', new Blob([bytes], { type: mime }), `ditado.${extension}`);
      form.append('model', DICTATION_MODEL);
      form.append('language', 'pt');
      form.append('response_format', 'json');
      form.append('temperature', '0');
      const signals = [AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])];
      const response = await this.fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.any(signals),
      });
      // Do not return upstream error bodies: they can contain credentials or request details.
      if (response.status === 429) throw fail('Limite de transcrição da Groq atingido. Aguarda antes de voltar a ditar.', 429);
      if ([401, 403].includes(response.status)) throw fail('A chave Groq não foi aceite ou não tem acesso ao Whisper V3.', 503);
      if (!response.ok) throw fail('A Groq não conseguiu transcrever a gravação. Tenta novamente.', 502);
      const result = await response.json();
      if (typeof result.text !== 'string' || !result.text.trim()) throw fail('Não foi detetada fala. Tenta gravar novamente.', 422);
      if (result.text.length > 100_000) throw fail('A transcrição excede o tamanho máximo da mensagem.', 413);
      return { text: result.text.trim(), model: DICTATION_MODEL };
    } catch (error) {
      if (error.status) throw error;
      if (signal?.aborted) throw fail('Transcrição cancelada.', 499);
      if (['TimeoutError', 'AbortError'].includes(error.name)) throw fail('A transcrição demorou demasiado. Tenta novamente.', 504);
      throw fail('Não foi possível contactar a Groq. Verifica a ligação à internet.', 502);
    } finally { this.busy = false; }
  }
}
