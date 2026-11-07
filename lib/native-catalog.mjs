import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Only catalog/control commands belong here. Never send user messages or prompts.
export function nativeCatalogQuery(owner, args, { control = false, usage = false, timeoutMs = 30_000 } = {}) {
  const child = spawn(owner.executable, [...owner.prefixArgs, ...args], {
    cwd: owner.defaultCwd, env: owner.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  const processes = owner.metadataProcesses ||= new Set();
  processes.add(child);
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');
  child.stderr.resume(); // Diagnostics can contain account data; never forward them to the UI.
  return new Promise((resolve, reject) => {
    let done = false, exited = false, output = '', info, force;
    const kill = signal => { try { if (child.pid) process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') child.kill(signal); } };
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); child.stdin.end();
      if (!exited) { kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 500); force.unref(); }
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(Error('O cliente não confirmou a consulta a tempo.')), timeoutMs);
    child.once('error', () => finish(Error('Não foi possível iniciar a consulta no cliente original.')));
    child.once('close', code => {
      exited = true; processes.delete(child); clearTimeout(force);
      if (!done) {
        if (!control && code === 0) finish(null, output);
        else finish(Error('O cliente terminou sem confirmar a consulta.'));
      }
    });
    child.stdout.on('data', data => {
      output += data;
      if (output.length > 4_000_000) finish(Error('A resposta do catálogo excedeu o limite de leitura.'));
    });
    if (!control) { child.stdin.end(); return; }
    createInterface({ input: child.stdout }).on('line', line => {
      if (done) return;
      let event; try { event = JSON.parse(line); } catch { return; }
      const response = event.type === 'control_response' && event.response;
      if (!response || !['hydraq-catalog', 'hydraq-usage'].includes(response.request_id)) return;
      if (response.subtype !== 'success') return finish(Error('Esta versão do cliente não disponibiliza a consulta solicitada.'));
      if (response.request_id === 'hydraq-catalog') {
        info = response.response;
        if (!usage) return finish(null, info);
        child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'hydraq-usage', request: { subtype: 'get_usage' } }) + '\n');
      } else finish(null, { account: info?.account, usage: response.response });
    });
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'hydraq-catalog', request: { subtype: 'initialize' } }) + '\n');
  });
}

export async function stopCatalogQueries(owner) {
  await Promise.all([...(owner.metadataProcesses || [])].map(child => new Promise(resolve => {
    const force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 600); force.unref();
    child.once('close', () => { clearTimeout(force); resolve(); });
    try { process.kill(-child.pid, 'SIGTERM'); } catch { clearTimeout(force); resolve(); }
  })));
}
