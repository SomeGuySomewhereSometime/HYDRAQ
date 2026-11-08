import { faiscaArtwork } from './mascot-art.js';

export function createMascotCharacter() {
  const element = document.createElement('span');
  element.className = 'mascot-character';
  element.setAttribute('aria-hidden', 'true');
  element.dataset.status = 'offline';
  element.innerHTML = faiscaArtwork;

  const indicator = document.createElement('span');
  indicator.className = 'mascot-status';
  element.append(indicator);

  const updateVisibility = () => element.toggleAttribute('data-paused', document.hidden);
  document.addEventListener('visibilitychange', updateVisibility);
  updateVisibility();

  return {
    element,
    setStatus(status) { element.dataset.status = status; },
    destroy() {
      document.removeEventListener('visibilitychange', updateVisibility);
      element.remove();
    },
  };
}
