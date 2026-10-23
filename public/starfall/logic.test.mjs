import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('./game.js', import.meta.url), 'utf8');
const sandbox = {};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const { createStarfall, difficulty, wavePlan, hudLayout, CATALOG, MAX_PARTICLES, MAX_DT, WAVES } = sandbox.Starfall;

function sequence(values) {
	let index = 0;
	return () => values[Math.min(index++, values.length - 1)];
}

test('experiência abre escolha e a melhoria seguinte conserva a anterior', () => {
	const game = createStarfall({ random: sequence([0, 0.2, 0.4, 0.6, 0.8, 0.1, 0.9, 0.3, 0.5, 0.7]) });
	game.start();
	const need = game.state.player.xpNext + (36 + 28);
	game.state.orbs.push({ x: game.state.player.x, y: game.state.player.y, r: 8, value: need, vx: 0, vy: 0 });
	game.update(0.016, {});
	assert.equal(game.state.mode, 'levelup');
	assert.equal(game.state.choices.length, 3);
	assert.equal(game.state.pendingLevels, 2);
	assert.equal(game.choose(0), true);
	assert.equal(game.state.taken.length, 1);
	const first = game.state.taken[0];
	const afterFirst = snapshot(game.state);
	assert.equal(game.state.mode, 'levelup');
	assert.equal(game.choose(0), true);
	assert.equal(game.state.mode, 'playing');
	assert.deepEqual([...game.state.taken], [first, game.state.taken[1]]);
	assert.ok(stillHas(afterFirst, snapshot(game.state), first));
	assert.equal(game.choose(0), false);
});

test('laser, rajada, míssil e drone criam disparos diferentes', () => {
	const game = createStarfall({ random: () => 0.25 });
	game.start();
	game.state.enemies.push({ id: 99, kind: 'scout', x: 480, y: 40, r: 12, hp: 500, maxHp: 500, speed: 0, xp: 1, score: 1, color: '#fff', cd: 9, phase: 0, dead: false });
	game.state.player.weapons.laser = 1;
	game.state.player.weapons.spread = 1;
	game.state.player.weapons.missile = 2;
	game.state.player.weapons.drone = 1;
	game.state.player.cd = {};
	game.update(0.016, {});
	const kinds = game.state.shots.filter((shot) => shot.owner === 'player').map((shot) => shot.kind);
	assert.ok(kinds.includes('pulse'));
	assert.ok(kinds.includes('laser'));
	assert.equal(kinds.filter((kind) => kind === 'spread').length, 3);
	assert.equal(kinds.filter((kind) => kind === 'missile').length, 2);
	assert.ok(kinds.includes('drone'));
	const laser = game.state.shots.find((shot) => shot.kind === 'laser');
	assert.equal(laser.pierce, 1);
	const missile = game.state.shots.find((shot) => shot.kind === 'missile');
	assert.ok(missile.damage > game.state.shots.find((shot) => shot.kind === 'pulse').damage);
});

test('colisão de projétil, escudo e derrota', () => {
	const game = createStarfall({ random: () => 0.4 });
	game.start();
	const enemy = {
		id: 7, kind: 'brute', x: 120, y: 120, r: 18, hp: 30, maxHp: 30, speed: 0, xp: 22, score: 260, color: '#ffc857', cd: 9, phase: 0, dead: false
	};
	game.state.enemies = [enemy];
	game.state.shots.push({ x: 120, y: 120, vx: 0, vy: 0, r: 6, damage: 12, life: 1, owner: 'player', kind: 'pulse', pierce: 0, hit: [] });
	game.update(0.016, {});
	assert.ok(enemy.hp <= 18);
	game.state.player.shield = 10;
	game.state.player.maxShield = 10;
	game.state.player.hp = 40;
	game.state.shots.push({ x: game.state.player.x, y: game.state.player.y, vx: 0, vy: 0, r: 6, damage: 15, life: 1, owner: 'enemy', kind: 'enemy', pierce: 0, hit: [] });
	game.update(0.016, {});
	assert.ok(game.state.player.shield < 0.2);
	assert.ok(Math.abs(game.state.player.hp - 35) < 0.3);
	game.state.player.hurt = 0;
	game.state.shots.push({ x: game.state.player.x, y: game.state.player.y, vx: 0, vy: 0, r: 8, damage: 90, life: 1, owner: 'enemy', kind: 'enemy', pierce: 0, hit: [] });
	game.update(0.016, {});
	assert.equal(game.state.mode, 'defeat');
	assert.equal(game.state.player.hp, 0);
});

test('ondas ficam mais difíceis, o chefe aparece e a vitória exige a última onda limpa', () => {
	assert.ok(difficulty(6) > difficulty(1));
	assert.ok(wavePlan(1).every((kind) => kind === 'scout'));
	assert.ok(wavePlan(2).includes('gunner'));
	assert.ok(wavePlan(4).includes('brute'));
	assert.ok(wavePlan(3).includes('boss'));
	assert.ok(wavePlan(6).includes('boss'));
	const game = createStarfall({ random: () => 0.5 });
	game.start();
	assert.equal(game.state.wave, 1);
	assert.ok(game.state.queue.length > 0);
	game.state.queue = [];
	game.state.enemies = [];
	for (let i = 0; i < 40; i += 1) game.update(0.05, {});
	assert.equal(game.state.wave, 2);
	assert.equal(game.state.mode, 'playing');
	game.state.wave = WAVES;
	game.state.queue = [];
	game.state.enemies = [];
	game.state.gap = null;
	const score = game.state.score;
	game.update(0.016, {});
	assert.equal(game.state.mode, 'victory');
	assert.equal(game.state.score, score + 200 * WAVES);
	game.update(1, {});
	assert.equal(game.state.score, score + 200 * WAVES);
});

test('um intervalo enorme não atravessa o ecrã nem esvazia a onda', () => {
	const game = createStarfall({ random: () => 0.2 });
	game.start();
	const before = game.state.player.y;
	const queued = game.state.queue.length;
	game.update(9, { up: true });
	assert.ok(before - game.state.player.y <= game.state.player.speed * MAX_DT + 0.001);
	assert.ok(game.state.player.y < before);
	assert.ok(game.state.queue.length >= queued - 1);
	game.state.mode = 'playing';
	for (let i = 0; i < 400; i += 1) {
		game.state.particles.push({ x: 0, y: 0, vx: 0, vy: 0, life: 10, age: 0, color: '#fff', size: 2 });
	}
	game.update(0.016, {});
	assert.ok(game.state.particles.length <= MAX_PARTICLES);
});

test('reiniciar limpa progresso, entidades e input', () => {
	const game = createStarfall({ random: () => 0.3 });
	const input = { up: true, down: true, left: true, right: false, keys: new Set(['KeyW', 'KeyS', 'KeyA']) };
	game.bindInput(input);
	game.start();
	game.state.score = 900;
	game.state.player.weapons.laser = 2;
	game.state.player.level = 4;
	game.state.taken = ['laser', 'damage'];
	game.state.shots.push({ x: 1, y: 1, r: 2, owner: 'player' });
	game.state.enemies.push({ id: 1, dead: false, hp: 10 });
	game.state.pendingLevels = 2;
	game.restart();
	assert.equal(game.state.mode, 'menu');
	assert.equal(game.state.score, 0);
	assert.equal(game.state.player.level, 1);
	assert.equal(game.state.player.hp, 100);
	assert.equal(game.state.player.weapons.laser, undefined);
	assert.equal(game.state.shots.length, 0);
	assert.equal(game.state.enemies.length, 0);
	assert.deepEqual([...game.state.taken], []);
	assert.equal(game.state.pendingLevels, 0);
	assert.equal(input.up, false);
	assert.equal(input.down, false);
	assert.equal(input.left, false);
	assert.equal(input.keys.size, 0);
	game.start();
	assert.equal(game.state.mode, 'playing');
	assert.equal(game.state.wave, 1);
});

test('contacto durante invulnerabilidade não destrói o inimigo nem tira vida', () => {
	const game = createStarfall({ random: () => 0.2 });
	game.start();
	game.state.queue = [];
	const enemy = { id: 3, kind: 'scout', x: game.state.player.x, y: game.state.player.y, r: 12, hp: 20, maxHp: 20, speed: 0, xp: 8, score: 100, color: '#fff', cd: 9, phase: 0, dead: false };
	game.state.enemies = [enemy];
	game.state.player.hurt = 0.3;
	game.state.player.hp = 90;
	game.state.player.shield = 0;
	game.state.player.maxShield = 0;
	game.update(0.016, {});
	assert.equal(enemy.dead, false);
	assert.equal(game.state.enemies.some((item) => item.id === 3), true);
	assert.equal(game.state.player.hp, 90);
	assert.ok(game.state.player.hurt > 0);
	game.state.player.hurt = 0;
	game.update(0.016, {});
	assert.equal(enemy.dead, true);
	assert.ok(game.state.player.hp < 90);
});

test('catálogo esgotado oferece fallback dentro dos limites', () => {
	const game = createStarfall({ random: () => 0 });
	game.start();
	const player = game.state.player;
	player.weapons.laser = 3;
	player.weapons.spread = 3;
	player.weapons.missile = 3;
	player.weapons.drone = 3;
	player.damage = 4;
	player.rate = 3;
	player.maxShield = 150;
	player.shield = 10;
	player.maxHp = 250;
	player.hp = 200;
	player.speed = 520;
	game.state.queue = [];
	game.state.enemies = [];
	game.state.orbs.push({ x: player.x, y: player.y, r: 8, value: player.xpNext + player.xpNext + 28, vx: 0, vy: 0 });
	game.update(0.016, {});
	assert.equal(game.state.mode, 'levelup');
	assert.equal(game.state.choices.length, 3);
	assert.equal(game.state.pendingLevels, 2);
	game.state.choices.forEach((choice) => {
		assert.equal(CATALOG.some((item) => item.id === choice.id), false);
	});
	assert.equal(game.choose(0), true);
	assert.equal(game.state.mode, 'levelup');
	assert.equal(game.state.choices.length, 3);
	assert.equal(game.choose(0), true);
	assert.equal(game.state.mode, 'playing');
	assert.equal(game.state.pendingLevels, 0);
	assert.equal(player.damage, 4);
	assert.equal(player.rate, 3);
	assert.equal(player.maxShield, 150);
	assert.ok(player.shield <= 150);
	assert.equal(player.maxHp, 250);
	assert.ok(player.hp <= 250);
	assert.equal(player.speed, 520);
	assert.equal(player.weapons.laser, 3);
});

test('HUD com quatro armas cabe de 320 a 1280 sem cruzar as barras', () => {
	[320, 390, 760, 800, 960, 1100, 1280].forEach((width) => {
		const game = createStarfall({ random: () => 0.5, width, height: 800 });
		game.state.player.weapons.laser = 3;
		game.state.player.weapons.spread = 3;
		game.state.player.weapons.missile = 3;
		game.state.player.weapons.drone = 3;
		const layout = hudLayout(game.state);
		assert.equal(layout.fits, true, String(width));
		assert.ok(layout.gap >= 8, String(width));
		const joined = layout.lines.join(' ');
		assert.match(joined, /Laser 3|Las 3|L3/);
		assert.match(joined, /Rajada 3|Raj 3|R3/);
		assert.match(joined, /Mísseis 3|Mís 3|M3/);
		assert.match(joined, /Drones 3|Dro 3|D3/);
		const texts = layout.texts.concat(layout.labels);
		texts.forEach((box) => {
			layout.bars.forEach((bar) => {
				const hit = box.x < bar.x + bar.w && box.x + box.w > bar.x && box.y < bar.y + bar.h && box.y + box.h > bar.y;
				assert.equal(hit, false, `${width} ${box.text}`);
			});
		});
	});
});

test('libertar o foco limpa teclas e direcções', () => {
	const game = createStarfall({ random: () => 0.4 });
	const input = { up: true, down: true, left: true, right: true, keys: new Set(['KeyW', 'ArrowLeft']) };
	game.bindInput(input);
	game.start();
	game.releaseInput();
	assert.equal(input.keys.size, 0);
	assert.equal(input.up, false);
	assert.equal(input.down, false);
	assert.equal(input.left, false);
	assert.equal(input.right, false);
	assert.equal(game.state.mode, 'playing');
});

function snapshot(state) {
	const { weapons, damage, rate, maxShield, maxHp, speed } = state.player;
	return { laser: weapons.laser || 0, spread: weapons.spread || 0, missile: weapons.missile || 0, drone: weapons.drone || 0, damage, rate, maxShield, maxHp, speed };
}

function stillHas(before, after, id) {
	if (id === 'damage') return after.damage >= before.damage;
	if (id === 'rate') return after.rate >= before.rate;
	if (id === 'shield') return after.maxShield >= before.maxShield;
	if (id === 'hull') return after.maxHp >= before.maxHp;
	if (id === 'thrust') return after.speed >= before.speed;
	return after[id] >= before[id];
}
