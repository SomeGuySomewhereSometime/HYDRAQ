(function (root) {
	'use strict';

	const MAX_DT = 0.05;
	const MAX_ENEMIES = 16;
	const MAX_SHOTS = 70;
	const MAX_ORBS = 36;
	const MAX_PARTICLES = 110;
	const WAVES = 6;

	const CATALOG = [
		{
			id: 'laser',
			name: 'Laser de pulso',
			detail: 'Feixe rápido que atravessa um segundo alvo.',
			allow: (s) => (s.player.weapons.laser || 0) < 3,
			label: (s) => `Laser de pulso (nível ${(s.player.weapons.laser || 0) + 1})`,
			apply: (s) => { s.player.weapons.laser = (s.player.weapons.laser || 0) + 1; }
		},
		{
			id: 'spread',
			name: 'Rajada em leque',
			detail: 'Dispara vários projéteis de uma vez.',
			allow: (s) => (s.player.weapons.spread || 0) < 3,
			label: (s) => `Rajada em leque (nível ${(s.player.weapons.spread || 0) + 1})`,
			apply: (s) => { s.player.weapons.spread = (s.player.weapons.spread || 0) + 1; }
		},
		{
			id: 'missile',
			name: 'Mísseis teleguiados',
			detail: 'Um míssil persegue o inimigo mais próximo e explode.',
			allow: (s) => (s.player.weapons.missile || 0) < 3,
			label: (s) => `Mísseis teleguiados (nível ${(s.player.weapons.missile || 0) + 1})`,
			apply: (s) => { s.player.weapons.missile = (s.player.weapons.missile || 0) + 1; }
		},
		{
			id: 'drone',
			name: 'Drone de escolta',
			detail: 'Um drone orbita a nave e dispara sozinho.',
			allow: (s) => (s.player.weapons.drone || 0) < 3,
			label: (s) => `Drone de escolta (nível ${(s.player.weapons.drone || 0) + 1})`,
			apply: (s) => { s.player.weapons.drone = (s.player.weapons.drone || 0) + 1; }
		},
		{
			id: 'damage',
			name: 'Núcleo sobrecarregado',
			detail: 'Todo o armamento causa mais 25% de dano.',
			allow: (s) => s.player.damage < 3.8,
			label: () => 'Núcleo sobrecarregado',
			apply: (s) => { s.player.damage *= 1.25; }
		},
		{
			id: 'rate',
			name: 'Calibragem de cadência',
			detail: 'As armas disparam 20% mais depressa.',
			allow: (s) => s.player.rate < 2.8,
			label: () => 'Calibragem de cadência',
			apply: (s) => { s.player.rate *= 1.2; }
		},
		{
			id: 'shield',
			name: 'Escudo iónico',
			detail: 'Ganha 30 de escudo. O escudo absorve dano antes do casco.',
			allow: (s) => s.player.maxShield < 150,
			label: () => 'Escudo iónico',
			apply: (s) => { s.player.maxShield += 30; s.player.shield += 30; }
		},
		{
			id: 'hull',
			name: 'Casco reforçado',
			detail: '+25 de vida máxima e repara 25 de imediato.',
			allow: (s) => s.player.maxHp < 250,
			label: () => 'Casco reforçado',
			apply: (s) => { s.player.maxHp += 25; s.player.hp = Math.min(s.player.maxHp, s.player.hp + 25); }
		},
		{
			id: 'thrust',
			name: 'Impulsores',
			detail: 'A nave move-se 18% mais depressa.',
			allow: (s) => s.player.speed < 520,
			label: () => 'Impulsores',
			apply: (s) => { s.player.speed *= 1.18; }
		}
	];

	function clamp(value, min, max) {
		return Math.max(min, Math.min(max, value));
	}

	function hypot2(dx, dy) {
		return dx * dx + dy * dy;
	}

	function overlaps(a, b) {
		return hypot2(a.x - b.x, a.y - b.y) <= (a.r + b.r) * (a.r + b.r);
	}

	function shuffle(list, random) {
		const copy = list.slice();
		for (let i = copy.length - 1; i > 0; i -= 1) {
			const j = Math.floor(random() * (i + 1));
			const swap = copy[i];
			copy[i] = copy[j];
			copy[j] = swap;
		}
		return copy;
	}

	function difficulty(wave) {
		return 1 + (wave - 1) * 0.22;
	}

	function wavePlan(wave) {
		const count = 5 + wave * 2;
		const plan = [];
		for (let i = 0; i < count; i += 1) {
			if (wave >= 4 && i % 5 === 4) plan.push('brute');
			else if (wave >= 2 && i % 3 === 2) plan.push('gunner');
			else plan.push('scout');
		}
		if (wave % 3 === 0) plan.push('boss');
		return plan;
	}

	function xpNeed(level) {
		return 36 + (level - 1) * 28;
	}

	function makeStars(random) {
		const stars = [];
		for (let layer = 0; layer < 3; layer += 1) {
			for (let i = 0; i < 28; i += 1) {
				stars.push({
					x: random(),
					y: random(),
					layer,
					size: layer === 2 ? 1.8 : 1
				});
			}
		}
		return stars;
	}

	function fresh(random, w, h) {
		return {
			mode: 'menu',
			pauseReason: null,
			w,
			h,
			time: 0,
			score: 0,
			wave: 1,
			wavesTotal: WAVES,
			queue: [],
			gap: null,
			pendingLevels: 0,
			choices: [],
			taken: [],
			nextId: 1,
			player: {
				x: w / 2,
				y: h * 0.8,
				r: 15,
				hp: 100,
				maxHp: 100,
				shield: 0,
				maxShield: 0,
				speed: 280,
				xp: 0,
				level: 1,
				xpNext: xpNeed(1),
				damage: 1,
				rate: 1,
				weapons: { pulse: 1 },
				cd: {},
				hurt: 0
			},
			drones: [],
			enemies: [],
			shots: [],
			orbs: [],
			particles: [],
			stars: makeStars(random),
			random
		};
	}

	function createStarfall(options) {
		const random = options && options.random ? options.random : Math.random;
		const width = options && options.width ? options.width : 960;
		const height = options && options.height ? options.height : 540;
		const game = { state: fresh(random, width, height), input: null };

		function clearInput() {
			if (!game.input) return;
			game.input.up = false;
			game.input.down = false;
			game.input.left = false;
			game.input.right = false;
			if (game.input.keys) game.input.keys.clear();
		}

		game.bindInput = function bindInput(input) {
			game.input = input;
		};

		game.restart = function restart() {
			const { w, h, random: rng } = game.state;
			game.state = fresh(rng, w, h);
			clearInput();
		};

		game.start = function start() {
			const state = game.state;
			if (state.mode === 'victory' || state.mode === 'defeat') game.restart();
			if (game.state.mode !== 'menu') return;
			game.state.player.x = game.state.w / 2;
			game.state.player.y = game.state.h * 0.78;
			beginWave(game.state);
			game.state.mode = 'playing';
		};

		game.pause = function pause(reason) {
			if (game.state.mode !== 'playing') return;
			game.state.mode = 'paused';
			game.state.pauseReason = reason || 'manual';
		};

		game.resume = function resume() {
			if (game.state.mode !== 'paused') return;
			game.state.mode = 'playing';
			game.state.pauseReason = null;
		};

		game.choose = function choose(index) {
			return chooseUpgrade(game.state, index);
		};

		game.update = function update(dt, input) {
			step(game.state, dt, input || {});
		};

		game.releaseInput = function release() {
			releaseInput(game.input);
		};

		return game;
	}

	function beginWave(state) {
		state.queue = wavePlan(state.wave);
		state.gap = null;
	}

	const FALLBACK = [
		{
			id: 'repair',
			name: 'Reparação de campo',
			detail: 'Recupera até 20 de vida, sem ultrapassar o máximo.',
			label: () => 'Reparação de campo',
			apply: (s) => { s.player.hp = Math.min(s.player.maxHp, s.player.hp + 20); }
		},
		{
			id: 'recharge',
			name: 'Recarga de escudo',
			detail: 'Enche o escudo até ao máximo actual, sem o aumentar.',
			label: () => 'Recarga de escudo',
			apply: (s) => { s.player.shield = s.player.maxShield; }
		},
		{
			id: 'steady',
			name: 'Manobra estável',
			detail: 'Não altera limites nem armas. A escolha pendente fica resolvida.',
			label: () => 'Manobra estável',
			apply: () => {}
		}
	];

	function releaseInput(input) {
		if (!input) return;
		if (input.keys) input.keys.clear();
		input.up = false;
		input.down = false;
		input.left = false;
		input.right = false;
	}

	function rollChoices(state) {
		const pool = shuffle(CATALOG.filter((item) => item.allow(state)), state.random);
		const picked = [];
		pool.forEach((item) => {
			if (picked.length >= 3) return;
			if (picked.some((choice) => choice.id === item.id)) return;
			picked.push(item);
		});
		FALLBACK.forEach((item) => {
			if (picked.length >= 3) return;
			picked.push(item);
		});
		state.choices = picked;
		state.mode = 'levelup';
	}

	function addXp(state, amount) {
		state.player.xp += amount;
		while (state.player.xp >= state.player.xpNext) {
			state.player.xp -= state.player.xpNext;
			state.player.level += 1;
			state.player.xpNext = xpNeed(state.player.level);
			state.pendingLevels += 1;
		}
		if (state.pendingLevels > 0 && state.mode === 'playing') rollChoices(state);
	}

	function chooseUpgrade(state, index) {
		if (state.mode !== 'levelup') return false;
		const choice = state.choices[index];
		if (!choice) return false;
		choice.apply(state);
		state.taken.push(choice.id);
		state.pendingLevels -= 1;
		state.choices = [];
		if (state.pendingLevels > 0) rollChoices(state);
		else state.mode = 'playing';
		return true;
	}

	function burst(state, x, y, color, count) {
		for (let i = 0; i < count; i += 1) {
			if (state.particles.length >= MAX_PARTICLES) state.particles.shift();
			const angle = state.random() * Math.PI * 2;
			const speed = 30 + state.random() * 140;
			state.particles.push({
				x,
				y,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed,
				life: 0.35 + state.random() * 0.35,
				age: 0,
				color,
				size: 1.5 + state.random() * 2.2
			});
		}
	}

	function dropOrb(state, enemy) {
		if (state.orbs.length >= MAX_ORBS) {
			addXp(state, enemy.xp);
			return;
		}
		state.orbs.push({ x: enemy.x, y: enemy.y, r: 8, value: enemy.xp, vx: 0, vy: 28 });
	}

	function killEnemy(state, enemy) {
		if (enemy.dead) return;
		enemy.dead = true;
		state.score += enemy.score;
		dropOrb(state, enemy);
		burst(state, enemy.x, enemy.y, enemy.color, enemy.kind === 'boss' ? 28 : 12);
	}

	function hurtPlayer(state, amount) {
		const player = state.player;
		if (player.hurt > 0 || state.mode !== 'playing') return false;
		player.hurt = 0.45;
		let left = amount;
		const absorbed = Math.min(player.shield, left);
		player.shield -= absorbed;
		left -= absorbed;
		player.hp -= left;
		burst(state, player.x, player.y, '#ff6b8a', 8);
		if (player.hp <= 0) {
			player.hp = 0;
			state.mode = 'defeat';
		}
		return true;
	}

	function shotCount(state, owner) {
		let count = 0;
		state.shots.forEach((shot) => { if (shot.owner === owner) count += 1; });
		return count;
	}

	function pushShot(state, shot) {
		const ownerCap = shot.owner === 'player' ? MAX_SHOTS : 48;
		if (shotCount(state, shot.owner) >= ownerCap) return;
		state.shots.push(shot);
	}

	function scaledDamage(state, base, level) {
		return base * (1 + 0.55 * (level - 1)) * state.player.damage;
	}

	function fireCone(state, kind, level, count, speed, damage, x, y) {
		const arc = 0.62 + Math.max(0, count - 3) * 0.08;
		for (let i = 0; i < count; i += 1) {
			const t = count === 1 ? 0.5 : i / (count - 1);
			const angle = -Math.PI / 2 + (t - 0.5) * arc;
			pushShot(state, {
				x,
				y,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed,
				r: kind === 'laser' ? 5 : 4,
				damage,
				life: kind === 'laser' ? 0.55 : 1.15,
				owner: 'player',
				kind,
				pierce: kind === 'laser' ? 1 : 0,
				hit: [],
				level
			});
		}
	}

	function fireWeapons(state, dt) {
		const player = state.player;
		const ready = (id, cooldown) => {
			player.cd[id] = (player.cd[id] || 0) - dt;
			if (player.cd[id] > 0) return false;
			player.cd[id] = cooldown / player.rate;
			return true;
		};
		if (ready('pulse', 0.24)) {
			fireCone(state, 'pulse', 1, 1, 680, scaledDamage(state, 11, 1), player.x, player.y - 12);
		}
		const laser = player.weapons.laser || 0;
		if (laser && ready('laser', 0.16)) {
			fireCone(state, 'laser', laser, 1, 960, scaledDamage(state, 8, laser), player.x, player.y - 16);
		}
		const spread = player.weapons.spread || 0;
		if (spread && ready('spread', 0.42)) {
			fireCone(state, 'spread', spread, 2 + spread, 560, scaledDamage(state, 7, spread), player.x, player.y - 8);
		}
		const missile = player.weapons.missile || 0;
		if (missile && ready('missile', 0.85)) {
			for (let i = 0; i < missile; i += 1) {
				const side = i % 2 === 0 ? -1 : 1;
				pushShot(state, {
					x: player.x + side * 10,
					y: player.y,
					vx: side * 40,
					vy: -260,
					r: 6,
					damage: scaledDamage(state, 26, missile),
					life: 3.2,
					owner: 'player',
					kind: 'missile',
					pierce: 0,
					hit: [],
					level: missile
				});
			}
		}
		const droneLevel = player.weapons.drone || 0;
		while (state.drones.length < droneLevel) {
			state.drones.push({ angle: state.drones.length * 2.1, cd: 0 });
		}
		if (state.drones.length > droneLevel) state.drones.length = droneLevel;
		state.drones.forEach((drone) => {
			drone.angle += dt * 2.2;
			drone.cd -= dt;
			const x = player.x + Math.cos(drone.angle) * 46;
			const y = player.y + Math.sin(drone.angle) * 36;
			drone.x = x;
			drone.y = y;
			if (drone.cd > 0) return;
			drone.cd = 0.48 / player.rate;
			const target = nearestEnemy(state, { x, y });
			const angle = target ? Math.atan2(target.y - y, target.x - x) : -Math.PI / 2;
			const speed = 520;
			pushShot(state, {
				x,
				y,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed,
				r: 3.5,
				damage: scaledDamage(state, 6, droneLevel),
				life: 1.1,
				owner: 'player',
				kind: 'drone',
				pierce: 0,
				hit: [],
				level: droneLevel
			});
		});
	}

	function nearestEnemy(state, from) {
		let best = null;
		let bestDist = Infinity;
		state.enemies.forEach((enemy) => {
			if (enemy.dead) return;
			const dist = hypot2(enemy.x - from.x, enemy.y - from.y);
			if (dist < bestDist) {
				best = enemy;
				bestDist = dist;
			}
		});
		return best;
	}

	function spawnEnemy(state, kind) {
		if (state.enemies.length >= MAX_ENEMIES && kind !== 'boss') return false;
		const scale = difficulty(state.wave);
		const x = 36 + state.random() * (state.w - 72);
		const specs = {
			scout: { hp: 14, r: 13, speed: 92, xp: 8, score: 100, color: '#5ef2ff', cd: 0 },
			gunner: { hp: 26, r: 16, speed: 58, xp: 14, score: 160, color: '#ff4fd8', cd: 1.1 },
			brute: { hp: 58, r: 22, speed: 38, xp: 22, score: 260, color: '#ffc857', cd: 1.35 },
			boss: { hp: 220, r: 40, speed: 28, xp: 80, score: 1200, color: '#c9a6ff', cd: 0.8 }
		};
		const spec = specs[kind];
		state.enemies.push({
			id: state.nextId,
			kind,
			x,
			y: kind === 'boss' ? -20 : -28 - state.random() * 40,
			r: spec.r,
			hp: spec.hp * scale,
			maxHp: spec.hp * scale,
			speed: spec.speed * (kind === 'boss' ? 1 : 0.92 + scale * 0.12),
			xp: spec.xp,
			score: spec.score,
			color: spec.color,
			cd: spec.cd,
			phase: state.random() * Math.PI * 2,
			dead: false
		});
		state.nextId += 1;
		return true;
	}

	function fireEnemy(state, enemy) {
		const player = state.player;
		const aim = Math.atan2(player.y - enemy.y, player.x - enemy.x);
		const make = (angle, speed, damage, r) => pushShot(state, {
			x: enemy.x,
			y: enemy.y + enemy.r * 0.4,
			vx: Math.cos(angle) * speed,
			vy: Math.sin(angle) * speed,
			r,
			damage,
			life: 3.4,
			owner: 'enemy',
			kind: 'enemy',
			pierce: 0,
			hit: []
		});
		if (enemy.kind === 'boss') {
			[-0.28, 0, 0.28].forEach((offset) => make(aim + offset, 250, 12, 5));
		} else if (enemy.kind === 'brute') {
			make(aim, 210, 16, 6);
		} else if (enemy.kind === 'gunner') {
			make(aim, 280, 9, 4);
		}
	}

	function movePlayer(state, dt, input) {
		const player = state.player;
		let x = 0;
		let y = 0;
		if (input.left) x -= 1;
		if (input.right) x += 1;
		if (input.up) y -= 1;
		if (input.down) y += 1;
		const length = Math.hypot(x, y) || 1;
		if (x || y) {
			player.x += (x / length) * player.speed * dt;
			player.y += (y / length) * player.speed * dt;
		}
		player.x = clamp(player.x, player.r + 8, state.w - player.r - 8);
		player.y = clamp(player.y, player.r + hudLayout(state).height, state.h - player.r - 12);
		if (player.hurt > 0) player.hurt -= dt;
		if (player.shield < player.maxShield) {
			player.shield = Math.min(player.maxShield, player.shield + 8 * dt);
		}
	}

	function moveWorld(state, dt) {
		state.enemies.forEach((enemy) => {
			if (enemy.kind === 'boss') {
				enemy.y = Math.min(enemy.y + enemy.speed * dt, 92);
				enemy.x += Math.sin(state.time * 0.8 + enemy.phase) * 70 * dt;
				enemy.x = clamp(enemy.x, enemy.r + 10, state.w - enemy.r - 10);
			} else if (enemy.kind === 'scout') {
				enemy.y += enemy.speed * dt;
				enemy.x += Math.sin(state.time * 2.4 + enemy.phase) * 90 * dt;
				enemy.x = clamp(enemy.x, enemy.r, state.w - enemy.r);
			} else {
				enemy.y += enemy.speed * dt;
			}
			if (enemy.kind !== 'scout') {
				enemy.cd -= dt;
				if (enemy.cd <= 0 && enemy.y > 10) {
					enemy.cd = enemy.kind === 'boss' ? 0.72 : enemy.kind === 'brute' ? 1.45 : 1.2;
					fireEnemy(state, enemy);
				}
			}
		});
		state.enemies = state.enemies.filter((enemy) => enemy.kind === 'boss' || enemy.y < state.h + 50);
		state.shots.forEach((shot) => {
			if (shot.kind === 'missile') {
				const target = nearestEnemy(state, shot);
				if (target) {
					const dx = target.x - shot.x;
					const dy = target.y - shot.y;
					const len = Math.hypot(dx, dy) || 1;
					const turn = Math.min(1, dt * 3.4);
					shot.vx += ((dx / len) * 340 - shot.vx) * turn;
					shot.vy += ((dy / len) * 340 - shot.vy) * turn;
				}
			}
			shot.x += shot.vx * dt;
			shot.y += shot.vy * dt;
			shot.life -= dt;
		});
		state.shots = state.shots.filter((shot) => shot.life > 0 && shot.x > -40 && shot.x < state.w + 40 && shot.y > -80 && shot.y < state.h + 40);
		state.orbs.forEach((orb) => {
			const dx = state.player.x - orb.x;
			const dy = state.player.y - orb.y;
			const dist = Math.hypot(dx, dy) || 1;
			if (dist < 110) {
				orb.vx += (dx / dist) * 720 * dt;
				orb.vy += (dy / dist) * 720 * dt;
			}
			orb.x += orb.vx * dt;
			orb.y += orb.vy * dt;
			orb.vx *= 0.98;
			orb.vy *= 0.98;
		});
		if (state.queue.length && state.enemies.length < MAX_ENEMIES) {
			state.spawnTimer = (state.spawnTimer || 0) - dt;
			if (state.spawnTimer <= 0) {
				const kind = state.queue[0];
				if (spawnEnemy(state, kind)) state.queue.shift();
				state.spawnTimer = kind === 'boss' ? 0.9 : Math.max(0.32, 0.62 - state.wave * 0.04);
			}
		}
	}

	function resolve(state) {
		const removeShots = new Set();
		state.shots.forEach((shot, index) => {
			if (shot.owner === 'player') {
				state.enemies.forEach((enemy) => {
					if (enemy.dead || removeShots.has(index) || shot.hit.includes(enemy.id)) return;
					if (!overlaps(shot, enemy)) return;
					shot.hit.push(enemy.id);
					enemy.hp -= shot.damage;
					if (shot.kind === 'missile') {
						state.enemies.forEach((other) => {
							if (other === enemy || other.dead) return;
							if (hypot2(other.x - enemy.x, other.y - enemy.y) <= 54 * 54) other.hp -= shot.damage * 0.45;
						});
					}
					burst(state, enemy.x, enemy.y, shot.kind === 'missile' ? '#ffb15a' : '#e8fbff', 4);
					if (enemy.hp <= 0) killEnemy(state, enemy);
					shot.pierce -= 1;
					if (shot.pierce < 0) removeShots.add(index);
				});
				state.enemies.forEach((enemy) => { if (!enemy.dead && enemy.hp <= 0) killEnemy(state, enemy); });
			} else if (overlaps(shot, state.player)) {
				hurtPlayer(state, shot.damage);
				removeShots.add(index);
			}
		});
		state.shots = state.shots.filter((_, index) => !removeShots.has(index));
		state.enemies.forEach((enemy) => {
			if (!enemy.dead && overlaps(enemy, state.player)) {
				const applied = hurtPlayer(state, enemy.kind === 'boss' ? 22 : 14);
				if (applied && enemy.kind !== 'boss') killEnemy(state, enemy);
			}
		});
		state.enemies = state.enemies.filter((enemy) => !enemy.dead);
		const kept = [];
		state.orbs.forEach((orb) => {
			if (overlaps(orb, state.player)) addXp(state, orb.value);
			else kept.push(orb);
		});
		state.orbs = kept;
	}

	function advanceWaves(state, dt) {
		if (state.mode !== 'playing') return;
		const clear = state.queue.length === 0 && state.enemies.length === 0;
		if (!clear) return;
		if (state.gap === null) {
			state.score += 200 * state.wave;
			if (state.wave >= state.wavesTotal) {
				state.mode = 'victory';
				state.gap = 0;
				return;
			}
			state.gap = 1.6;
		}
		state.gap -= dt;
		if (state.gap <= 0) {
			state.wave += 1;
			beginWave(state);
		}
	}

	function step(state, dt, input) {
		if (state.mode !== 'playing') return;
		const tick = clamp(Number.isFinite(dt) ? dt : 0, 0, MAX_DT);
		state.time += tick;
		movePlayer(state, tick, input);
		if (state.mode !== 'playing') return;
		fireWeapons(state, tick);
		moveWorld(state, tick);
		resolve(state);
		advanceWaves(state, tick);
		state.particles.forEach((particle) => {
			particle.age += tick;
			particle.x += particle.vx * tick;
			particle.y += particle.vy * tick;
		});
		state.particles = state.particles.filter((particle) => particle.age < particle.life);
		if (state.particles.length > MAX_PARTICLES) state.particles.splice(0, state.particles.length - MAX_PARTICLES);
	}

	function roundRect(ctx, x, y, w, h, radius) {
		ctx.beginPath();
		ctx.moveTo(x + radius, y);
		ctx.arcTo(x + w, y, x + w, y + h, radius);
		ctx.arcTo(x + w, y + h, x, y + h, radius);
		ctx.arcTo(x, y + h, x, y, radius);
		ctx.arcTo(x, y, x + w, y, radius);
		ctx.closePath();
	}

	function draw(ctx, state) {
		const { w, h } = state;
		ctx.clearRect(0, 0, w, h);
		const sky = ctx.createLinearGradient(0, 0, 0, h);
		sky.addColorStop(0, '#12081f');
		sky.addColorStop(0.45, '#0a1024');
		sky.addColorStop(1, '#061018');
		ctx.fillStyle = sky;
		ctx.fillRect(0, 0, w, h);
		state.stars.forEach((star) => {
			const speed = 8 + star.layer * 18;
			const x = ((star.x * w) + state.time * speed * (star.layer + 1) * 8) % w;
			const y = ((star.y * h) + state.time * speed) % h;
			ctx.globalAlpha = 0.35 + star.layer * 0.22;
			ctx.fillStyle = star.layer === 1 ? '#9fd0ff' : '#fff6d8';
			ctx.fillRect(x, y, star.size, star.size);
		});
		ctx.globalAlpha = 1;
		state.particles.forEach((particle) => {
			ctx.globalAlpha = 1 - particle.age / particle.life;
			ctx.fillStyle = particle.color;
			ctx.fillRect(particle.x, particle.y, particle.size, particle.size);
		});
		ctx.globalAlpha = 1;
		state.orbs.forEach((orb) => {
			ctx.save();
			ctx.translate(orb.x, orb.y);
			ctx.rotate(state.time * 2);
			ctx.fillStyle = '#ffe56a';
			ctx.strokeStyle = '#fff4b0';
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.moveTo(0, -7);
			ctx.lineTo(6, 0);
			ctx.lineTo(0, 7);
			ctx.lineTo(-6, 0);
			ctx.closePath();
			ctx.fill();
			ctx.stroke();
			ctx.restore();
		});
		state.shots.forEach((shot) => {
			ctx.save();
			ctx.translate(shot.x, shot.y);
			if (shot.kind === 'laser') {
				ctx.strokeStyle = '#e8ffff';
				ctx.lineWidth = 3;
				ctx.beginPath();
				ctx.moveTo(0, 12);
				ctx.lineTo(0, -16);
				ctx.stroke();
			} else if (shot.kind === 'missile') {
				ctx.fillStyle = '#ffb15a';
				ctx.beginPath();
				ctx.moveTo(0, -8);
				ctx.lineTo(4, 6);
				ctx.lineTo(-4, 6);
				ctx.closePath();
				ctx.fill();
			} else if (shot.kind === 'enemy') {
				ctx.fillStyle = '#ff5d7a';
				ctx.beginPath();
				ctx.arc(0, 0, shot.r, 0, Math.PI * 2);
				ctx.fill();
			} else {
				ctx.fillStyle = shot.kind === 'spread' ? '#7dffb3' : shot.kind === 'drone' ? '#d9b0ff' : '#8af7ff';
				ctx.beginPath();
				ctx.arc(0, 0, shot.r, 0, Math.PI * 2);
				ctx.fill();
			}
			ctx.restore();
		});
		state.enemies.forEach((enemy) => drawEnemy(ctx, enemy));
		state.drones.forEach((drone) => {
			ctx.save();
			ctx.translate(drone.x, drone.y);
			ctx.fillStyle = '#d9b0ff';
			ctx.strokeStyle = '#f4e6ff';
			ctx.beginPath();
			ctx.moveTo(0, -7);
			ctx.lineTo(6, 5);
			ctx.lineTo(-6, 5);
			ctx.closePath();
			ctx.fill();
			ctx.stroke();
			ctx.restore();
		});
		drawPlayer(ctx, state);
		drawHud(ctx, state);
	}

	function drawPlayer(ctx, state) {
		const player = state.player;
		if (player.shield > 0) {
			ctx.strokeStyle = `rgba(120, 220, 255, ${0.35 + 0.25 * (player.shield / player.maxShield)})`;
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.arc(player.x, player.y, player.r + 8, 0, Math.PI * 2);
			ctx.stroke();
		}
		ctx.save();
		ctx.translate(player.x, player.y);
		ctx.globalAlpha = player.hurt > 0 && Math.sin(state.time * 40) > 0 ? 0.55 : 1;
		ctx.fillStyle = '#d9fbff';
		ctx.strokeStyle = '#5ef2ff';
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(0, -16);
		ctx.lineTo(12, 12);
		ctx.lineTo(0, 6);
		ctx.lineTo(-12, 12);
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = '#49f0c2';
		ctx.fillRect(-3, 8, 6, 6 + Math.sin(state.time * 30) * 2);
		ctx.restore();
	}

	function drawEnemy(ctx, enemy) {
		ctx.save();
		ctx.translate(enemy.x, enemy.y);
		ctx.fillStyle = enemy.color;
		ctx.strokeStyle = '#fff';
		ctx.lineWidth = 1.4;
		ctx.beginPath();
		if (enemy.kind === 'scout') {
			ctx.moveTo(0, -enemy.r);
			ctx.lineTo(enemy.r, 0);
			ctx.lineTo(0, enemy.r);
			ctx.lineTo(-enemy.r, 0);
		} else if (enemy.kind === 'gunner') {
			for (let i = 0; i < 6; i += 1) {
				const angle = -Math.PI / 2 + i * Math.PI / 3;
				ctx.lineTo(Math.cos(angle) * enemy.r, Math.sin(angle) * enemy.r);
			}
		} else if (enemy.kind === 'brute') {
			ctx.rect(-enemy.r, -enemy.r * 0.75, enemy.r * 2, enemy.r * 1.5);
		} else {
			for (let i = 0; i < 8; i += 1) {
				const angle = i * Math.PI / 4;
				const radius = i % 2 === 0 ? enemy.r : enemy.r * 0.72;
				ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
			}
		}
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
		const ratio = clamp(enemy.hp / enemy.maxHp, 0, 1);
		ctx.fillStyle = 'rgba(0,0,0,0.45)';
		ctx.fillRect(-enemy.r, enemy.r + 4, enemy.r * 2, 3);
		ctx.fillStyle = '#fff';
		ctx.fillRect(-enemy.r, enemy.r + 4, enemy.r * 2 * ratio, 3);
		ctx.restore();
	}

	function weaponLine(state) {
		const names = ['Canhão'];
		const weapons = state.player.weapons;
		if (weapons.laser) names.push(`Laser ${weapons.laser}`);
		if (weapons.spread) names.push(`Rajada ${weapons.spread}`);
		if (weapons.missile) names.push(`Mísseis ${weapons.missile}`);
		if (weapons.drone) names.push(`Drones ${weapons.drone}`);
		return names.join(' · ');
	}

	function drawBar(ctx, x, y, width, height, ratio, color) {
		ctx.fillStyle = '#243044';
		roundRect(ctx, x, y, width, height, 4);
		ctx.fill();
		ctx.fillStyle = color;
		roundRect(ctx, x, y, width * clamp(ratio, 0, 1), height, 4);
		ctx.fill();
	}

	function textWidth(text, font) {
		return text.length * font * 0.7;
	}

	function weaponBits(state, style) {
		const weapons = state.player.weapons;
		const bits = style === 'tiny'
			? ['C1', weapons.laser ? `L${weapons.laser}` : '', weapons.spread ? `R${weapons.spread}` : '', weapons.missile ? `M${weapons.missile}` : '', weapons.drone ? `D${weapons.drone}` : '']
			: ['Canhão', weapons.laser ? `Las ${weapons.laser}` : '', weapons.spread ? `Raj ${weapons.spread}` : '', weapons.missile ? `Mís ${weapons.missile}` : '', weapons.drone ? `Dro ${weapons.drone}` : ''];
		return bits.filter(Boolean);
	}

	function fitLines(bits, font, maxWidth, measure) {
		const lines = [];
		let current = '';
		bits.forEach((bit) => {
			const next = current ? `${current} · ${bit}` : bit;
			if (current && measure(next, font) > maxWidth) {
				lines.push(current);
				current = bit;
			} else current = next;
		});
		if (current) lines.push(current);
		return lines;
	}

	function boxesOverlap(a, b) {
		return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
	}

	function hudLayout(state, measure) {
		const measureText = measure || textWidth;
		const pad = 12;
		const maxText = Math.max(48, state.w - pad * 2);
		const wave = `Onda ${Math.min(state.wave, state.wavesTotal)}/${state.wavesTotal}`;
		const status = `Nv ${state.player.level}  ${wave}  ${state.score}`;
		let font = state.w < 420 ? 12 : 13;
		while (font > 10 && measureText(status, font) > maxText) font -= 1;
		const candidates = [
			[weaponLine(state)],
			fitLines(weaponBits(state, 'short'), font, maxText, measureText),
			fitLines(weaponBits(state, 'tiny'), font, maxText, measureText)
		];
		const lines = candidates.find((set) => set.every((line) => measureText(line, font) <= maxText)) || candidates[2];
		const texts = [];
		let baseline = 16;
		texts.push({ text: status, x: pad, y: baseline - font, w: measureText(status, font), h: font, baseline });
		lines.forEach((text) => {
			baseline += font + 4;
			texts.push({ text, x: pad, y: baseline - font, w: measureText(text, font), h: font, baseline });
		});
		const textBottom = baseline + 3;
		const barY = textBottom + 8;
		const labelH = font;
		const vidaW = measureText('Vida', font);
		const xpLabelW = measureText('XP', font);
		const gap = 8;
		const barsTop = barY + labelH + 4;
		const barW = Math.max(24, Math.floor((state.w - pad * 2 - gap) / 2));
		const bars = [
			{ id: 'hp', x: pad, y: barsTop, w: barW, h: 8 },
			{ id: 'shield', x: pad, y: barsTop + 12, w: barW, h: 6 },
			{ id: 'xp', x: pad + barW + gap, y: barsTop, w: barW, h: 8 }
		];
		const labels = [
			{ text: 'Vida', x: pad, y: barY, w: vidaW, h: labelH, baseline: barY + labelH },
			{ text: 'XP', x: pad + barW + gap, y: barY, w: xpLabelW, h: labelH, baseline: barY + labelH }
		];
		const height = barsTop + 22;
		const allText = texts.concat(labels);
		const inside = allText.every((box) => box.x >= 0 && box.x + box.w <= state.w) && bars.every((box) => box.x + box.w <= state.w);
		const separated = allText.every((box) => bars.every((bar) => !boxesOverlap(box, bar)));
		const fits = inside && separated && lines.length > 0;
		return { font, lines, texts, labels, bars, barY, height, fits, maxText, gap: barY - textBottom };
	}

	function drawHud(ctx, state) {
		const player = state.player;
		const layout = hudLayout(state, (text, font) => {
			ctx.font = `${font}px Segoe UI, sans-serif`;
			return ctx.measureText(text).width;
		});
		ctx.fillStyle = 'rgba(4, 8, 18, 0.78)';
		ctx.fillRect(0, 0, state.w, layout.height);
		ctx.fillStyle = '#d5deea';
		ctx.font = `${layout.font}px Segoe UI, sans-serif`;
		layout.texts.concat(layout.labels).forEach((row) => ctx.fillText(row.text, row.x, row.baseline));
		const byId = Object.fromEntries(layout.bars.map((bar) => [bar.id, bar]));
		drawBar(ctx, byId.hp.x, byId.hp.y, byId.hp.w, byId.hp.h, player.hp / player.maxHp, '#ff5d7a');
		drawBar(ctx, byId.shield.x, byId.shield.y, byId.shield.w, byId.shield.h, player.maxShield ? player.shield / player.maxShield : 0, '#7ad7ff');
		drawBar(ctx, byId.xp.x, byId.xp.y, byId.xp.w, byId.xp.h, player.xp / player.xpNext, '#ffe56a');
	}

	function mount(canvas) {
		const ctx = canvas.getContext('2d');
		const game = createStarfall();
		const input = { up: false, down: false, left: false, right: false, keys: new Set() };
		game.bindInput(input);
		const menu = document.getElementById('menu');
		const levelup = document.getElementById('levelup');
		const paused = document.getElementById('paused');
		const result = document.getElementById('result');
		const choices = document.getElementById('choices');
		const pauseText = document.getElementById('pause-text');
		const stick = document.getElementById('stick');
		const knob = document.getElementById('knob');
		let pointer = null;

		function syncKeys() {
			input.up = input.keys.has('KeyW') || input.keys.has('ArrowUp');
			input.down = input.keys.has('KeyS') || input.keys.has('ArrowDown');
			input.left = input.keys.has('KeyA') || input.keys.has('ArrowLeft');
			input.right = input.keys.has('KeyD') || input.keys.has('ArrowRight');
		}

		function resize() {
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			game.state.w = window.innerWidth;
			game.state.h = window.innerHeight;
			canvas.width = Math.floor(game.state.w * dpr);
			canvas.height = Math.floor(game.state.h * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			const player = game.state.player;
			player.x = clamp(player.x, 24, Math.max(24, game.state.w - 24));
			player.y = clamp(player.y, 70, Math.max(70, game.state.h - 20));
		}

		function show() {
			const { mode, pauseReason } = game.state;
			document.body.dataset.mode = mode;
			menu.hidden = mode !== 'menu';
			levelup.hidden = mode !== 'levelup';
			paused.hidden = mode !== 'paused';
			result.hidden = mode !== 'victory' && mode !== 'defeat';
			if (mode === 'paused') {
				pauseText.textContent = pauseReason === 'focus'
					? 'A janela perdeu o foco. O combate ficou suspenso.'
					: 'Jogo em pausa.';
			}
			if (mode === 'levelup') renderChoices();
			if (mode === 'victory' || mode === 'defeat') {
				document.getElementById('result-title').textContent = mode === 'victory' ? 'Corredor limpo' : 'Nave destruída';
				document.getElementById('result-copy').textContent = mode === 'victory'
					? `Destruíste o Núcleo Estelar e concluíste as ${game.state.wavesTotal} ondas. Pontuação ${game.state.score}.`
					: `O casco cedeu na onda ${game.state.wave}. Pontuação ${game.state.score}.`;
			}
		}

		function renderChoices() {
			if (choices.dataset.stamp === String(game.state.taken.length) && choices.childElementCount) return;
			choices.dataset.stamp = String(game.state.taken.length);
			choices.replaceChildren();
			game.state.choices.forEach((choice, index) => {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'choice';
				const title = document.createElement('strong');
				title.textContent = choice.label(game.state);
				const detail = document.createElement('span');
				detail.textContent = choice.detail;
				button.append(title, detail);
				button.addEventListener('click', () => {
					game.choose(index);
					choices.dataset.stamp = '';
					show();
				});
				choices.append(button);
			});
			const note = document.getElementById('level-note');
			note.textContent = game.state.pendingLevels > 1
				? `Nível ${game.state.player.level}. Ainda há ${game.state.pendingLevels} escolhas por fazer.`
				: `Nível ${game.state.player.level}. Escolhe uma melhoria. As anteriores mantêm-se.`;
		}

		document.getElementById('start').addEventListener('click', () => { game.start(); show(); });
		document.getElementById('resume').addEventListener('click', () => { game.resume(); show(); });
		document.getElementById('again').addEventListener('click', () => { game.restart(); game.start(); show(); });
		document.getElementById('to-menu').addEventListener('click', () => { game.restart(); show(); });

		window.addEventListener('keydown', (event) => {
			if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) event.preventDefault();
			if (event.code === 'KeyP' || event.code === 'Escape') {
				if (game.state.mode === 'playing') game.pause('manual');
				else if (game.state.mode === 'paused') game.resume();
				show();
				return;
			}
			if (event.repeat) return;
			input.keys.add(event.code);
			syncKeys();
		});
		window.addEventListener('keyup', (event) => {
			input.keys.delete(event.code);
			syncKeys();
		});
		function loseFocus() {
			game.releaseInput();
			endStick();
			game.pause('focus');
			show();
		}

		window.addEventListener('blur', loseFocus);
		document.addEventListener('visibilitychange', () => {
			if (document.hidden) loseFocus();
		});
		window.addEventListener('resize', resize);

		function setStick(clientX, clientY) {
			const rect = stick.getBoundingClientRect();
			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			let dx = clientX - cx;
			let dy = clientY - cy;
			const max = rect.width * 0.34;
			const length = Math.hypot(dx, dy) || 1;
			if (length > max) {
				dx = dx / length * max;
				dy = dy / length * max;
			}
			knob.style.transform = `translate(${dx}px, ${dy}px)`;
			input.left = dx < -12;
			input.right = dx > 12;
			input.up = dy < -12;
			input.down = dy > 12;
		}

		function endStick() {
			pointer = null;
			knob.style.transform = 'translate(0px, 0px)';
			input.up = false;
			input.down = false;
			input.left = false;
			input.right = false;
			syncKeys();
		}

		stick.addEventListener('pointerdown', (event) => {
			pointer = event.pointerId;
			stick.setPointerCapture(event.pointerId);
			setStick(event.clientX, event.clientY);
		});
		stick.addEventListener('pointermove', (event) => {
			if (pointer !== event.pointerId) return;
			setStick(event.clientX, event.clientY);
		});
		stick.addEventListener('pointerup', endStick);
		stick.addEventListener('pointercancel', endStick);

		let last = performance.now();
		function frame(now) {
			const dt = (now - last) / 1000;
			last = now;
			if (game.state.mode === 'playing') game.update(dt, input);
			draw(ctx, game.state);
			if (game.state.mode !== document.body.dataset.mode) show();
			requestAnimationFrame(frame);
		}
		resize();
		show();
		root.Starfall.live = game;
		requestAnimationFrame(frame);
	}

	root.Starfall = {
		createStarfall,
		CATALOG,
		FALLBACK,
		hudLayout,
		difficulty,
		wavePlan,
		MAX_DT,
		MAX_ENEMIES,
		MAX_SHOTS,
		MAX_PARTICLES,
		WAVES
	};

	if (typeof document !== 'undefined' && document.getElementById && document.getElementById('view')) {
		mount(document.getElementById('view'));
	}
}(typeof globalThis !== 'undefined' ? globalThis : this));
