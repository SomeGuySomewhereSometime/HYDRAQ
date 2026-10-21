import { readFileSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';

// Lives inside the scope with the native CLI. No task deadline: loss of the
// exact HYDRAQ owner process, including PID reuse, closes the entire scope.
const [owner, ownerStart, unit, executable, ...args] = process.argv.slice(2);
if (!/^[1-9]\d*$/.test(owner) || !/^\d+$/.test(ownerStart) || !/^hydraq-col-(principal|worker|reviewer)-[a-f0-9-]{36}\.scope$/.test(unit) || !executable) throw Error('Supervisão inválida.');
function ownerAlive() {
  try {
    const stat = readFileSync(`/proc/${owner}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return fields[19] === ownerStart && !['Z', 'X'].includes(fields[0]);
  } catch { return false; }
}
if (!ownerAlive()) process.exit(125);
const child = spawn(executable, args, { stdio: 'inherit' });
let stopping = false, childEnded = false, exitCode = 0;
function stopScope() {
  if (stopping) return;
  stopping = true;
  execFile('/usr/bin/systemctl', ['--user', 'stop', unit], { timeout: 7000 }, () => { stopping = false; });
}
const timer = setInterval(() => {
  if (childEnded || !ownerAlive()) stopScope();
}, 500);
// Keep the guard until the scope is stopped, including commands left behind by
// a CLI that exits first. systemd's stop kills the entire scope, then this guard.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) process.exit(exitCode);
  stopScope();
});
child.on('error', () => { childEnded = true; exitCode = 126; stopScope(); });
child.on('exit', (code, signal) => {
  childEnded = true; exitCode = code ?? (signal ? 128 : 1); stopScope();
});
