// Paths are canonical on the server. Browser checks are hints; the server is authoritative.
const parent = (a, b) => a === b || b.startsWith(a.endsWith('/') ? a : a + '/');
export function workConflict(a, b) {
  return Boolean(a.global || b.global ||
    (a.projectId && a.projectId === b.projectId) ||
    (a.cwd && b.cwd && (parent(a.cwd, b.cwd) || parent(b.cwd, a.cwd))) ||
    (a.resources || []).some(r => (b.resources || []).includes(r)));
}

/** Human-readable explanation shared by HTTP refusals and composer hints. */
export function workReason(lock) {
  if (!lock) return '';
  const location = lock.label ? ` · ${lock.label}` : '';
  return (lock.reason || 'Recurso reservado') + location;
}
export function workReserved(lock) {
  return Object.assign(new Error(workReason(lock) + '. Aguarda a libertação da reserva e volta a enviar; nada foi reenviado automaticamente.'), {
    status: 409, code: 'WORK_RESERVED',
    conflict: { kind: lock.kind, reason: lock.reason, label: lock.label, resources: lock.resources || [] }
  });
}
