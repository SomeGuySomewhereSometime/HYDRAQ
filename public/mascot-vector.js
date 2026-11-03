import { createHydraArtwork } from './mascot-art.js';

const TAU = Math.PI * 2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = value => value * value * (3 - 2 * value);
const fract = value => value - Math.floor(value);
const noise = value => fract(Math.sin(value * 12.9898 + 78.233) * 43758.5453);
const point = p => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;

// Geometric two-bone solve. The foot is the constraint; the knee bends outwards.
function kneeAt(hip, foot, lengthA, lengthB, bend) {
  const dx = foot.x - hip.x, dy = foot.y - hip.y;
  const distance = clamp(Math.hypot(dx, dy), .001, lengthA + lengthB - .01);
  const along = clamp((lengthA * lengthA - lengthB * lengthB + distance * distance) / (2 * distance), -lengthA, lengthA);
  const height = Math.sqrt(Math.max(0, lengthA * lengthA - along * along));
  const angle = Math.atan2(dy, dx);
  return {
    x: hip.x + Math.cos(angle) * along - Math.sin(angle) * height * bend,
    y: hip.y + Math.sin(angle) * along + Math.cos(angle) * height * bend,
  };
}

function blinkOpen(time, head) {
  // Repeatable irregular timing: no timers, no chance of all three blinking together.
  const block = Math.floor(time / 7.1);
  const blinkAt = block * 7.1 + .7 + noise(block * 4.3 + head * 9.7) * 5.4;
  const age = time - blinkAt;
  const first = age >= 0 && age < .19 ? Math.sin(age / .19 * Math.PI) : 0;
  const repeatAge = age - .29;
  const second = noise(block + head * 19) > .72 && repeatAge >= 0 && repeatAge < .15
    ? Math.sin(repeatAge / .15 * Math.PI) : 0;
  return Math.max(.055, 1 - Math.max(first, second) ** .65);
}

/** A small articulated fallback. The caller owns the clock, lifecycle and events. */
export function createVectorHydra() {
  const element = createHydraArtwork();
  element.classList.add('mascot-vector');
  const find = selector => element.querySelector(selector);
  const rig = {
    creature: find('[data-rig="creature"]'),
    body: find('[data-rig="body"]'),
    tail: find('[data-rig="tail"]'),
    shadow: find('[data-rig="shadow"]'),
    heads: [0, 1, 2].map(index => ({
      head: find(`[data-head="${index}"]`),
      neck: find(`[data-neck="${index}"]`),
      belly: find(`[data-neck-belly="${index}"]`),
      jaw: find(`[data-jaw="${index}"]`),
      mouth: find(`[data-mouth="${index}"]`),
      eyes: [0, 1].map(side => find(`[data-eye="${index}-${side}"]`)),
      pupils: [0, 1].map(side => find(`[data-pupil="${index}-${side}"]`)),
      brows: [0, 1].map(side => find(`[data-brow="${index}-${side}"]`)),
    })),
    legs: [0, 1, 2, 3].map(index => ({
      upper: find(`[data-leg-upper="${index}"]`),
      lower: find(`[data-leg-lower="${index}"]`),
      foot: find(`[data-leg-foot="${index}"]`),
    })),
  };
  const hips = [{ x: 107, y: 155 }, { x: 149, y: 155 }, { x: 115, y: 161 }, { x: 146, y: 161 }];
  const feet = [{ x: 104, y: 184 }, { x: 153, y: 184 }, { x: 113, y: 186 }, { x: 149, y: 186 }];
  const phases = [0, .52, .72, .24];
  const footStates = feet.map(foot => ({ x: foot.x, y: foot.y, planted: foot.x, previousPhase: null, swinging: false, startX: foot.x, targetX: foot.x }));
  let lastTime = null, lastTravel = 0, previousWalking = false;
  let gazeX = 0, gazeY = 0;

  function update(timeSeconds, { status = 'offline', hovered = false, lookX = 0, lookY = 0, walking = false, travel = 0, reducedMotion = false } = {}) {
    const rawTime = Number.isFinite(timeSeconds) ? Math.max(0, timeSeconds) : 0;
    const time = reducedMotion ? 0 : rawTime;
    const moving = !reducedMotion && Boolean(walking);
    const offset = reducedMotion ? 0 : clamp(Number.isFinite(travel) ? travel : 0, -30, 30);
    const elapsed = lastTime === null ? 0 : rawTime - lastTime;
    const reset = lastTime === null || elapsed < 0 || elapsed > .3 || previousWalking !== moving;
    const dt = clamp(elapsed || 1 / 60, 1 / 240, .1);
    const velocity = !reset && moving ? clamp((offset - lastTravel) / dt, -45, 45) : 0;
    const ease = reducedMotion ? 1 : 1 - Math.exp(-dt * 8);
    gazeX = mix(gazeX, reducedMotion ? 0 : clamp(Number(lookX) || 0, -1, 1), ease);
    gazeY = mix(gazeY, reducedMotion ? 0 : clamp(Number(lookY) || 0, -1, 1), ease);
    const breath = Math.sin(time * 1.7);
    const stridePeriod = 1.05;
    const stance = .66;
    const pelvis = moving ? Math.cos(time / stridePeriod * TAU * 2) * .5 : 0;
    const lift = breath * .38 + pelvis;

    rig.creature.setAttribute('transform', `translate(${offset.toFixed(2)} 0)`);
    rig.body.setAttribute('transform', `translate(130 151) scale(${(1 + breath * .006).toFixed(4)} ${(1 + breath * .012).toFixed(4)}) translate(-130 -151)`);
    rig.tail.setAttribute('transform', `rotate(${(reducedMotion ? 0 : Math.sin(time * 1.4 + .4) * (hovered ? 8 : 4)).toFixed(2)} 157 155)`);
    rig.shadow.setAttribute('cx', (133 + offset).toFixed(2));
    rig.shadow.setAttribute('opacity', moving ? '.15' : '.18');

    rig.legs.forEach((leg, index) => {
      const base = feet[index], state = footStates[index];
      const phase = fract(time / stridePeriod + phases[index]);
      const swinging = moving && phase >= stance;
      if (reset) {
        state.x = base.x;
        state.y = base.y;
        state.planted = base.x + offset;
        state.startX = state.planted;
        state.targetX = state.planted;
        state.swinging = swinging;
        state.previousPhase = null;
      }
      let rotation = 0;
      if (moving) {
        if (swinging) {
          if (!state.swinging || state.previousPhase === null) {
            state.startX = state.planted;
            // Predict the next support position instead of dragging a planted foot.
            state.targetX = base.x + offset + velocity * stridePeriod * (1 - stance) * .75;
          }
          const progress = clamp((phase - stance) / (1 - stance), 0, 1);
          state.x = mix(state.startX, state.targetX, smooth(progress)) - offset;
          state.y = base.y - Math.sin(progress * Math.PI) * 7.5;
          rotation = Math.sin(progress * TAU) * (index % 2 ? -7 : 7);
        } else {
          if (state.swinging) state.planted = state.targetX;
          state.x = state.planted - offset;
          state.y = base.y;
        }
        state.swinging = swinging;
        state.previousPhase = phase;
      } else {
        // Settle to a comfortable stance. Only joints and toes move during breathing.
        state.x = mix(state.x, base.x, Math.min(1, dt * 9));
        state.y = mix(state.y, base.y, Math.min(1, dt * 12));
        state.planted = state.x + offset;
      }
      const foot = { x: state.x, y: state.y };
      const hip = { x: hips[index].x, y: hips[index].y + lift };
      const knee = kneeAt(hip, foot, index < 2 ? 17 : 16, 18, index % 2 ? -1 : 1);
      leg.upper.setAttribute('d', `M${point(hip)} Q${((hip.x + knee.x) / 2).toFixed(2)} ${((hip.y + knee.y) / 2 - 1).toFixed(2)} ${point(knee)}`);
      leg.lower.setAttribute('d', `M${point(knee)} Q${((knee.x + foot.x) / 2).toFixed(2)} ${((knee.y + foot.y) / 2).toFixed(2)} ${point(foot)}`);
      leg.foot.setAttribute('transform', `translate(${point(foot)}) rotate(${rotation.toFixed(2)})`);
    });

    const headHomes = [{ x: 80, y: 94, angle: -8 }, { x: 130, y: 66, angle: 0 }, { x: 178, y: 97, angle: 8 }];
    const neckRoots = [{ x: 114, y: 136 }, { x: 130, y: 137 }, { x: 145, y: 136 }];
    rig.heads.forEach((head, index) => {
      const home = headHomes[index];
      const wave = reducedMotion ? 0 : Math.sin(time * (.73 + index * .13) + index * 2.15);
      const counter = reducedMotion ? 0 : Math.cos(time * 1.03 + index * 1.8);
      const listening = !reducedMotion && status === 'listening' ? (index === 1 ? -3 : 1.5) : 0;
      const curious = !reducedMotion && hovered ? (index === 1 ? -3 : index === 0 ? -1.5 : -2) : 0;
      const x = home.x + gazeX * (index === 1 ? 3.2 : 4.5) + wave * 1.35;
      const y = home.y + lift + counter * .8 + listening + curious + gazeY * 1.1;
      const angle = home.angle + wave * 2.7 + gazeX * 5.5 + (!reducedMotion && hovered ? (index === 0 ? -3 : index === 2 ? 3 : 0) : 0);
      const radians = angle / 180 * Math.PI;
      const end = { x: x - Math.sin(radians) * 17, y: y + Math.cos(radians) * 17 };
      const root = { x: neckRoots[index].x, y: neckRoots[index].y + lift };
      const curve = `M${point(root)} C${(root.x + (index - 1) * 3 + wave).toFixed(2)} ${(root.y - 14).toFixed(2)} ${(end.x + Math.sin(radians) * 10).toFixed(2)} ${(end.y + 12).toFixed(2)} ${point(end)}`;
      head.neck.setAttribute('d', curve);
      head.belly.setAttribute('d', curve);
      head.belly.setAttribute('transform', 'translate(1 0)');
      head.head.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${angle.toFixed(2)})`);
      const blink = reducedMotion ? 1 : blinkOpen(time, index);
      const relaxed = index === 2 && !hovered && ['offline', 'muted'].includes(status) ? .77 : 1;
      head.eyes.forEach(eye => eye.setAttribute('transform', `scale(1 ${(blink * relaxed).toFixed(3)})`));
      head.pupils.forEach(pupil => pupil.setAttribute('transform', `translate(${(gazeX * 2.1).toFixed(2)} ${(gazeY * 1.45).toFixed(2)})`));
      head.brows.forEach((brow, side) => brow.setAttribute('transform', `translate(0 ${(hovered ? -1 : 0) + (status === 'error' ? (side ? -1 : 1) : 0)})`));
      const speaking = status === 'responding' && index === 1 && !reducedMotion;
      const opening = speaking ? .35 + .58 * Math.abs(Math.sin(time * 10.5) * Math.cos(time * 3.2)) : .08;
      head.jaw.setAttribute('transform', `scale(1 ${opening.toFixed(3)})`);
      head.mouth.setAttribute('opacity', speaking ? '.25' : '1');
    });
    lastTime = rawTime;
    lastTravel = offset;
    previousWalking = moving;
  }

  update(0, { reducedMotion: true });
  return { element, update };
}
