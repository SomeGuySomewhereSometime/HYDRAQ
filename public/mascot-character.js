import { createVectorHydra } from './mascot-vector.js';

/** A persistent articulated character. The parent button owns keyboard activation. */
export function createMascotCharacter({ onOpen } = {}) {
  const element = document.createElement('span');
  element.className = 'mascot-character';
  element.setAttribute('aria-hidden', 'true');
  Object.assign(element.dataset, { status: 'offline', expanded: 'false', provider: 'codex', renderer: 'vector' });
  const stage = document.createElement('span'); stage.className = 'mascot-stage';
  const vector = createVectorHydra(); stage.append(vector.element);
  const sparkle = document.createElement('span'); sparkle.className = 'mascot-sparkle';
  const heart = document.createElement('span'); heart.className = 'mascot-heart'; heart.textContent = '♥';
  const indicator = document.createElement('span'); indicator.className = 'mascot-status';
  const colorProbe = document.createElement('span'); colorProbe.className = 'mascot-color-probe';
  element.append(stage, sparkle, heart, indicator, colorProbe);
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const statuses = new Set(['offline','tracking','connecting','listening','responding','muted','reconnecting','error']);
  const providers = new Set(['codex','claude','antigravity','cursor','opencode']);
  let renderer = null, disposed = false, frame = 0, visible = true, hovered = false, grabbed = false;
  let wanderTime = 0, previous = null, elapsed = 0, lookX = 0, lookY = 0, targetX = 0, targetY = 0;
  let color = '', dirty = true;
  const readColor = () => { color = getComputedStyle(colorProbe).color; dirty = true; };
  const observer = new MutationObserver(readColor);
  observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'data-theme'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  const intersection = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    visible = entries[0]?.isIntersecting !== false;
    if (visible) resume(); else stop();
  }) : null;
  intersection?.observe(element);
  const boundsObserver = new ResizeObserver(() => { dirty = true; }); boundsObserver.observe(element);
  function stop() { cancelAnimationFrame(frame); frame = 0; previous = null; }
  function resume() { if (!disposed && !frame && visible && !document.hidden) frame = requestAnimationFrame(animate); }
  function animate(timestamp) {
    frame = 0;
    if (disposed || !visible || document.hidden) return;
    if (!element.isConnected) { frame = requestAnimationFrame(animate); return; }
    const dt = previous === null ? 0 : Math.min(.05, (timestamp - previous) / 1000); previous = timestamp;
    if (!motion.matches && !grabbed) elapsed += dt;
    const smoothing = 1 - Math.exp(-dt * 9);
    lookX += (targetX - lookX) * smoothing; lookY += (targetY - lookY) * smoothing;
    // Walk only in short bouts, separated by breathing, looking and blinking.
    // Foot articulation is driven by the Walk clip, not a CSS jump of the image.
    const canWander = !hovered && !grabbed && element.dataset.expanded !== 'true' && element.dataset.status === 'offline' && !motion.matches;
    if (canWander) wanderTime += dt;
    const phase = wanderTime % 22;
    let walking = false, travel = -7;
    if (phase >= 5 && phase < 8) { walking = true; travel = -7 + (phase - 5) / 3 * 14; }
    else if (phase >= 8 && phase < 15) travel = 7;
    else if (phase >= 15 && phase < 18) { walking = true; travel = 7 - (phase - 15) / 3 * 14; }
    if (!canWander) walking = false;
    // Pausing to interact holds the travel position; never teleport on hover.
    if (walking) element.dataset.motion = 'walk'; else element.dataset.motion = 'idle';
    const context = { status: element.dataset.status, hovered, grabbed, lookX, lookY, walking, direction: phase < 11 ? 1 : -1, travel: motion.matches ? 0 : travel, reducedMotion: motion.matches, color };
    if (!color) readColor();
    if (!motion.matches || dirty) {
      if (renderer) { renderer.resize(element.clientWidth, element.clientHeight); renderer.update(elapsed, context); }
      else vector.update(elapsed, context);
      dirty = false;
    }
    if (!motion.matches) frame = requestAnimationFrame(animate);
  }
  const pointer = event => {
    if (!visible || motion.matches || event.pointerType === 'touch') return;
    const rect = element.getBoundingClientRect();
    targetX = Math.max(-1, Math.min(1, (event.clientX - rect.left - rect.width / 2) / Math.max(rect.width * 2, 1)));
    targetY = Math.max(-1, Math.min(1, (event.clientY - rect.top - rect.height / 2) / Math.max(rect.height * 2, 1)));
  };
  const enter = () => { hovered = true; dirty = true; resume(); };
  const leave = () => { hovered = false; dirty = true; resume(); };
  const down = () => { grabbed = true; element.dataset.grabbed = 'true'; };
  const up = () => { grabbed = false; element.dataset.grabbed = 'false'; dirty = true; resume(); };
  const click = event => { if (typeof onOpen === 'function') { event.stopPropagation(); onOpen(event); } };
  const visibility = () => { if (document.hidden) stop(); else resume(); };
  const reduced = () => { dirty = true; resume(); };
  document.addEventListener('pointermove', pointer, { passive: true });
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pointerup', up, { passive: true });
  window.addEventListener('pointercancel', up, { passive: true });
  element.addEventListener('pointerenter', enter); element.addEventListener('pointerleave', leave);
  element.addEventListener('pointerdown', down); element.addEventListener('click', click);
  motion.addEventListener('change', reduced);
  queueMicrotask(async () => {
    readColor(); resume();
    try {
      const { createThreeHydra } = await import('./mascot-three.js');
      const loaded = await createThreeHydra();
      if (disposed) { loaded.destroy(); return; }
      renderer = loaded; stage.append(loaded.element); vector.element.hidden = true;
      vector.element.style.display = 'none';
      loaded.element.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        if (disposed) return;
        renderer?.destroy(); renderer = null;
        vector.element.hidden = false; vector.element.style.display = '';
        element.dataset.renderer = 'vector'; dirty = true; resume();
      }, { once: true });
      element.dataset.renderer = 'webgl'; dirty = true; resume();
    } catch {
      // A fully articulated SVG remains available on devices without WebGL2.
      element.dataset.renderer = 'vector'; dirty = true; resume();
    }
  });
  return {
    element,
    setStatus(value) { const next = statuses.has(value) ? value : 'offline'; if (element.dataset.status !== next) { element.dataset.status = next; dirty = true; resume(); } },
    setExpanded(value) { element.dataset.expanded = String(Boolean(value)); dirty = true; resume(); },
    setProvider(value) { element.dataset.provider = providers.has(value) ? value : 'codex'; if (element.isConnected) readColor(); resume(); },
    destroy() {
      disposed = true; stop(); observer.disconnect(); intersection?.disconnect(); boundsObserver.disconnect(); renderer?.destroy();
      document.removeEventListener('pointermove', pointer); document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      element.removeEventListener('pointerenter', enter); element.removeEventListener('pointerleave', leave); element.removeEventListener('pointerdown', down); element.removeEventListener('click', click);
      motion.removeEventListener('change', reduced); element.remove();
    },
  };
}
