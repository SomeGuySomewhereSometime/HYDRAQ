// Paths are canonical on the server. Browser checks are hints; the server is authoritative.
const parent = (a, b) => a === b || b.startsWith(a.endsWith('/') ? a : a + '/');
export function workConflict(a, b) {
  return Boolean(a.global || b.global ||
    (a.projectId && a.projectId === b.projectId) ||
    (a.cwd && b.cwd && (parent(a.cwd, b.cwd) || parent(b.cwd, a.cwd))) ||
    (a.resources || []).some(r => (b.resources || []).includes(r)));
}
