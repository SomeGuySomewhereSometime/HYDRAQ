import { withoutCursorCredentials } from './cursor-auth.mjs';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** One original Codex process. No model requests are retried automatically. */
export class CodexClient extends EventEmitter {
  constructor({ executable = process.env.HYDRAQ_CODEX_BIN || 'codex', args, env = process.env } = {}) {
    super();
    this.executable = executable;
    this.args = args || [
      'app-server', '--listen', 'stdio://',
      '-c', 'model_provider="openai"',
      '-c', 'forced_login_method="chatgpt"',
      '-c', 'features.multi_agent=false',
      '-c', 'features.multi_agent_v2=false',
      '-c', 'features.reasoning_effort_override=true',
      '-c', 'service_tier="default"',
    ];
    this.env = withoutCursorCredentials(env);
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'AZURE_OPENAI_API_KEY']) delete this.env[key];
    this.pending = new Map();
    this.nextId = 1;
    this.process = null;
    this.ready = false;
  }

  async start() {
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.#start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async #start() {
    const child = spawn(this.executable, this.args, { env: this.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.process = child;
    this.closed = new Promise(resolve => child.once('close', resolve));
    child.stdin.on('error', () => {});
    child.stderr.on('data', data => this.emit('diagnostic', String(data)));
    createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        this.emit(message.id !== undefined ? 'request' : 'notification', message);
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || 'Erro do Codex.'));
        else pending.resolve(message.result);
      }
    });
    const lost = error => {
      if (this.process !== child) return;
      this.ready = false;
      this.process = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.emit('disconnected', error);
    };
    child.once('error', error => lost(new Error(`Não foi possível executar o Codex: ${error.message}`)));
    child.once('exit', (code, signal) => lost(new Error(`O Codex terminou (${signal || code}). A tarefa não será reenviada automaticamente.`)));
    try {
      this.info = await this.call('initialize', {
        clientInfo: { name: 'hydraq', title: 'HYDRAQ', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      }, 30_000);
      this.notify('initialized');
      this.ready = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  call(method, params = {}, timeout = 60_000) {
    if (!this.process || this.process.killed) return Promise.reject(new Error('O Codex não está ligado.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Sem confirmação de ${method}. O pedido não será repetido automaticamente.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.#write({ id, method, params }, error => {
        if (!error || !this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method, params) { this.#write({ method, ...(params ? { params } : {}) }); }
  respond(id, result) { this.#write({ id, result }); }
  reject(id, message) { this.#write({ id, error: { code: -32601, message } }); }

  #write(message, callback) {
    if (!this.process || this.process.killed) { callback?.(new Error('Ligação ao Codex encerrada.')); return; }
    this.process.stdin.write(`${JSON.stringify(message)}\n`, callback);
  }

  async stop() {
    this.ready = false;
    const child = this.process;
    if (!child) return;
    const kill = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    if (child.pid) kill('SIGTERM');
    const force = setTimeout(() => { if (child.pid) kill('SIGKILL'); }, 2000);
    await this.closed; clearTimeout(force);
  }
}
