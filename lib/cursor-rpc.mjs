import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** Original agent ACP over NDJSON. Calls are never retried, including after a write error. */
export class CursorRpc extends EventEmitter {
  #secret;
  constructor({ executable, args = [], cwd, env, secret }) {
    super();
    this.#secret = secret;
    this.nextId = 1; this.pending = new Map(); this.incoming = new Set();
    this.child = spawn(executable, [...args, '--sandbox', 'enabled', 'acp'], {
      cwd, env: { ...env, CURSOR_API_KEY: secret }, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    this.buffer = ''; this.stderr = ''; this.decoder = new StringDecoder('utf8');
    this.closed = new Promise(resolve => this.resolveClosed = resolve);
    this.child.stdin.on('error', () => {});
    this.child.stdout.on('data', data => {
      this.buffer += this.decoder.write(data);
      if (this.buffer.length > 16_000_000) return this.fail('Evento do Cursor demasiado grande.');
      let newline;
      while (!this.ended && (newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        this.line(line);
      }
    });
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-16_000); });
    this.child.once('error', () => this.fail('Não foi possível executar o Cursor CLI. Verifica HYDRAQ_CURSOR_BIN.'));
    this.child.once('close', (code, signal) => {
      clearTimeout(this.killTimer);
      if (!this.ended) {
        const tail = this.buffer + this.decoder.end(); this.buffer = '';
        if (tail.trim()) this.line(tail);
        this.fail(`O Cursor terminou (${signal || code}) sem confirmar o resultado. O pedido não foi reenviado.`);
      }
      this.resolveClosed();
    });
  }
  redact(value) {
    const text = String(value ?? '');
    return this.#secret ? text.split(this.#secret).join('[CHAVE OCULTA]') : text;
  }
  safe(value) { return JSON.parse(this.redact(JSON.stringify(value, (_key, entry) => typeof entry === 'string' ? this.redact(entry) : entry))); }
  streamText(buffer, final = false) {
    const text = this.redact(buffer);
    let held = 0;
    // A credential split between ACP chunks must never become visible in a later snapshot.
    if (this.#secret) for (let n = 1; n < this.#secret.length && n <= text.length; n++)
      if (text.endsWith(this.#secret.slice(0, n))) held = n;
    return { visible: text.slice(0, text.length - held) + (final && held ? held >= 4 ? '[CHAVE OCULTA]' : text.slice(text.length - held) : ''), tail: final ? '' : text.slice(text.length - held) };
  }
  line(raw) {
    if (!raw.trim() || this.ended) return;
    try {
      const message = this.safe(JSON.parse(raw));
      if (message.jsonrpc !== '2.0') throw new Error('Envelope ACP inválido.');
      if (message.method) {
        if (message.id !== undefined) {
          const key = JSON.stringify(message.id);
          if (this.incoming.has(key)) throw new Error('Pedido ACP duplicado.');
          this.incoming.add(key); this.emit('request', message);
        } else this.emit('notification', message);
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        if (!message.error && !('result' in message)) throw new Error('Resposta ACP sem resultado.');
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(this.redact(message.error.message || 'O Cursor recusou o pedido.'));
          error.rpcCode = message.error.code; error.nativeResponse = true;
          pending.reject(error);
        } else if ('result' in message) pending.resolve(message.result);
      } else throw new Error('Mensagem ACP inválida.');
    } catch (error) { this.fail(error.message); }
  }
  write(message) {
    return new Promise((resolve, reject) => {
      if (this.ended || this.child.stdin.destroyed) return reject(new Error('O processo Cursor deixou de estar disponível.'));
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n', error => {
        if (!error) return resolve();
        const failure = new Error('Não foi possível confirmar a escrita para o Cursor.');
        reject(failure); this.fail(failure.message);
      });
    });
  }
  call(method, params = {}, timeout = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id); reject(new Error(`O Cursor não confirmou ${method}. Nada foi reenviado.`));
      }, timeout) : null;
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params }).catch(error => {
        const pending = this.pending.get(id); if (!pending) return;
        clearTimeout(timer); this.pending.delete(id); reject(error); this.fail(error.message);
      });
    });
  }
  notify(method, params) { return this.write({ method, params }); }
  reply(id, result, error) {
    const key = JSON.stringify(id);
    if (!this.incoming.delete(key)) return Promise.reject(new Error('Este pedido ACP já foi resolvido ou expirou.'));
    return this.write({ id, ...(error ? { error } : { result }) });
  }
  initialize() {
    return this.call('initialize', { protocolVersion: 1, clientInfo: { name: 'hydraq', version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { parameterizedModelPicker: true } } });
  }
  fail(reason) {
    if (this.ended) return;
    this.ended = true;
    const error = new Error(this.redact(reason));
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.incoming.clear();
    this.emit('lost', error);
    this.kill();
    this.killTimer = setTimeout(() => this.kill('SIGKILL'), 1500);
    this.killTimer.unref();
  }
  kill(signal = 'SIGTERM') { if (this.child.pid) try { process.kill(-this.child.pid, signal); } catch {} }
  async close() {
    this.fail('O processo Cursor foi encerrado.');
    await this.closed; clearTimeout(this.killTimer); this.#secret = null;
  }
}
