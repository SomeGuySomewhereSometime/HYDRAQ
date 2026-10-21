import { readFileSync } from 'node:fs';

// Linux process identity includes the boot: neither a reused PID nor a reboot
// makes a stale private lease belong to a different live process.
export function processIdentity(pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('PID inválido.');
  const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = value.slice(value.lastIndexOf(')') + 1).trim().split(/\s+/);
  return { pid, start: fields[19], boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), state: fields[0] };
}
export function sameProcess(pid, identity) {
  try {
    const actual = processIdentity(pid);
    if (['Z', 'X'].includes(actual.state)) return false;
    // Legacy records without an identity remain conservative while PID is live.
    return !identity || (identity.start === actual.start && identity.boot === actual.boot);
  } catch (e) {
    if (['ENOENT', 'ESRCH'].includes(e.code)) return false;
    return true; // An unreadable identity is not permission to steal a lock.
  }
}
