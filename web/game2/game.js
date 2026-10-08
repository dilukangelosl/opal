// Rift Warden — every character, enemy, projectile and effect is a transparent
// AI-generated video sprite played by the Opal runtime. World is 1280×720.
import { createOpal } from '../opal.js';

const W = 1280, H = 720, GROUND = 652;
const SIZE = { warden: 190, skel: 150, golem: 330, bat: 96, fireball: 120, orb: 44, portal: 230, explosion: 230, shock: 380, hit: 120, bolt: 760 };
const $ = (s) => document.getElementById(s);
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- layout
const world = $('world'), cv = $('cv'), c2 = $('fx2d'), g2 = c2.getContext('2d');
const mobile = matchMedia('(pointer: coarse)').matches;
let S = 1, CSS = 1;
function fit() {
  CSS = Math.min(innerWidth / W, innerHeight / H);
  world.style.width = `${W * CSS}px`; world.style.height = `${H * CSS}px`;
  const dpr = Math.min(devicePixelRatio, mobile ? 1.5 : 2);
  cv.width = c2.width = Math.round(W * CSS * dpr); cv.height = c2.height = Math.round(H * CSS * dpr);
  S = cv.width / W;
}
fit(); addEventListener('resize', fit);

// ---------- assets (load order = draw order)
const opal = await createOpal(cv);
const lod = { scale: mobile ? 0.6 : 1 };
const names = ['portal', 'orb', 'skeleton', 'golem', 'warden', 'bat', 'fireball', 'fx', 'lightning'];
const A = Object.fromEntries((await Promise.all(names.map((n) => opal.load(`assets/${n}.opal`, lod)))).map((a, i) => [names[i], a]));
const totalFrames = Object.values(A).reduce((s, a) => s + a.frames, 0);
$('loading').textContent = `${totalFrames} video frames from ${names.length} .opal files decoded to the GPU · made with Opal`;

const anchor = (a, clip) => {
  const c = a.clips[clip], [bx, by, bw, bh] = c.box;
  return { feet: by + bh - c.height / 2, cx: bx + bw / 2 - c.width / 2, cy: by + bh / 2 - c.height / 2, w: bw, h: bh };
};
const AN = {
  warden: anchor(A.warden, 'idle'), skel: anchor(A.skeleton, 'walk'), golem: anchor(A.golem, 'idle'), bat: anchor(A.bat, 'fly'),
  fireball: anchor(A.fireball, 'loop'), orb: anchor(A.orb, 'loop'), portal: anchor(A.portal, 'loop'),
  explosion: anchor(A.fx, 'explosion'), shock: anchor(A.fx, 'shock'), hit: anchor(A.fx, 'hit'), bolt: anchor(A.lightning, 'bolt'),
};
const K = {
  warden: SIZE.warden / AN.warden.h, skel: SIZE.skel / AN.skel.h, golem: SIZE.golem / AN.golem.h, bat: SIZE.bat / AN.bat.w,
  fireball: SIZE.fireball / AN.fireball.w, orb: SIZE.orb / AN.orb.w, portal: SIZE.portal / AN.portal.h,
  explosion: SIZE.explosion / AN.explosion.w, shock: SIZE.shock / AN.shock.w, hit: SIZE.hit / AN.hit.w, bolt: SIZE.bolt / AN.bolt.h,
};
K.orb = SIZE.orb / (A.orb.clips.loop.width * 0.22); // sparkles reach the frame edge, so size by the orb core
// The run clip was generated on a canvas with the Warden 110 px (of 1024) further right than the
// other clips (so its trailing dust had room); shift its anchor back so clip switches don't jump.
const wardenAnchor = Object.fromEntries(['idle', 'run', 'slash', 'cast'].map((c) =>
  [c, { ...AN.warden, cx: AN.warden.cx + (c === 'run' ? (110 / 1024) * A.warden.clips.run.width : 0) }]));
const STATIC_FX = { hit: 0.24, shock: 0.5 }; // single-frame stills animated in code (the model zoomed these to the frame edge)
const dur = (a, clip) => a.clips[clip].frames / a.fps;
const speedFor = (a, clip, seconds) => dur(a, clip) / seconds;

// place by feet (characters) or by visible center (effects, flyers); facing = ±1
function atFeet(id, an, k, x, feetY, facing = 1, op = 1) { opal.set(id, (x - an.cx * k * facing) * S, (feetY - an.feet * k) * S, k * facing * S, op); }
function atCenter(id, an, k, x, y, facing = 1, op = 1) { opal.set(id, (x - an.cx * k * facing) * S, (y - an.cy * k) * S, k * facing * S, op); }

// ---------- input
const keys = new Set(), pressed = new Set();
const actionKey = { KeyJ: 'slash', KeyK: 'fire', Space: 'dash', ShiftLeft: 'dash', ShiftRight: 'dash', KeyL: 'ult' };
addEventListener('keydown', (e) => {
  if (['Space', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (!e.repeat && actionKey[e.code]) pressed.add(actionKey[e.code]);
  keys.add(e.code);
  if ((e.code === 'Enter' || (e.code === 'Space' && state !== 'play')) && !e.repeat && state !== 'play') start();
});
addEventListener('keyup', (e) => keys.delete(e.code));
const pad = { l: false, r: false };
for (const [id, k] of [['pl', 'l'], ['pr', 'r']]) {
  $(id).addEventListener('pointerdown', (e) => { pad[k] = true; e.preventDefault(); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) $(id).addEventListener(ev, () => (pad[k] = false));
}
for (const [id, act] of [['pj', 'slash'], ['pk', 'fire'], ['pd', 'dash'], ['pu', 'ult']]) $(id).addEventListener('pointerdown', (e) => { pressed.add(act); e.preventDefault(); });
$('start').onclick = start; $('again').onclick = start;

// ---------- state
let state = 'title', hero, enemies, portals, orbs, shots, fxs, ghosts, texts, boss, wave, score, combo, comboT, shake, stop, nextWaveT, bannerT, pending;

function clearAll() {
  for (const list of [enemies, portals, orbs, shots, fxs, ghosts]) list?.forEach((o) => opal.kill(o.id));
  if (hero) opal.kill(hero.id);
  if (boss) opal.kill(boss.id);
}

function start() {
  if (state === 'play') return;
  clearAll();
  hero = { x: W / 2, facing: 1, clip: 'idle', hp: 10, max: 10, soul: 0, inv: 0, dash: 0, dashCd: 0, fireCd: 0, cast: false, hits: new Set(), ghostT: 0, id: opal.spawn(A.warden, 'idle', 0, 0, 1) };
  enemies = []; portals = []; orbs = []; shots = []; fxs = []; ghosts = []; texts = []; pending = [];
  boss = null; wave = 0; score = 0; combo = 0; comboT = 0; shake = 0; stop = 0; nextWaveT = 1.2; bannerT = 0;
  state = 'play';
  $('title').hidden = $('over').hidden = true; $('hud').hidden = false; $('boss').hidden = true;
}

function banner(title, sub = '') { $('banner').innerHTML = title + (sub ? `<small>${sub}</small>` : ''); $('banner').classList.add('show'); bannerT = 2; }
function text(x, y, t, color = '#fff', size = 30) { texts.push({ x, y, t, color, size, life: 0.9 }); }
function kick(s, freeze = 0) { shake = Math.max(shake, s); stop = Math.max(stop, freeze); }

// ---------- spawning
function startWave() {
  wave++;
  const bossWave = wave % 5 === 0;
  const skels = bossWave ? 2 + (wave >> 1) : 3 + wave * 2, bats = bossWave ? Math.floor(wave / 2) : wave >= 2 ? wave + 1 : 0;
  const nPortals = Math.min(3, 1 + Math.floor(wave / 2));
  const queue = [...Array(skels).fill('skel'), ...Array(bats).fill('bat')].sort(() => Math.random() - 0.5);
  for (let i = 0; i < nPortals; i++) {
    let x; do { x = rand(110, W - 110); } while (Math.abs(x - hero.x) < 260);
    openPortal(x, queue.filter((_, j) => j % nPortals === i));
  }
  if (bossWave) spawnBoss();
  banner(bossWave ? 'The Golem wakes' : `Wave ${wave}`, bossWave ? 'Dash through its shockwaves' : `${queue.length} things are coming through`);
}

function openPortal(x, queue) {
  portals.push({ x, queue, t: 0, spawnT: 0.8, id: opal.spawn(A.portal, 'loop', 0, 0, 1) });
}

function spawnEnemy(type, x) {
  if (type === 'bat') {
    const e = { type, x, baseY: rand(380, 470), y: 0, hp: 1, phase: rand(0, 6), t: 0, v: rand(110, 160) + wave * 6, facing: 1, swoop: 0, retreat: 0, id: opal.spawn(A.bat, 'fly', 0, 0, 1) };
    opal.speed(e.id, 1.4); enemies.push(e);
  } else {
    const e = { type, x, hp: 3 + Math.floor(wave / 4), state: 'walk', v: rand(65, 95) + wave * 5, facing: 1, kb: 0, cd: rand(0.3, 1), hitDone: false, fade: 0, lane: rand(-8, 10), id: opal.spawn(A.skeleton, 'walk', 0, 0, 1) };
    opal.speed(e.id, e.v / 80); enemies.push(e);
  }
}

function spawnBoss() {
  const x = hero.x < W / 2 ? W - 230 : 230;
  boss = { x, hp: 120 + wave * 12, max: 120 + wave * 12, state: 'idle', slamCd: 2.5, tpT: 9, facing: 1, flash: 0, id: opal.spawn(A.golem, 'idle', 0, 0, 1) };
  openPortal(x, []);
  $('boss').hidden = false;
}

function fx(kind, x, y, scale = 1, speed = 1, facing = 1) {
  const a = kind === 'bolt' ? A.lightning : A.fx, clip = kind === 'bolt' ? 'bolt' : kind;
  const f = { kind, x, y, k: K[kind] * scale, facing, age: 0, life: STATIC_FX[kind], id: opal.spawn(a, clip, 0, 0, 1) };
  opal.speed(f.id, speed); fxs.push(f); return f;
}

function dropOrb(x, y) { orbs.push({ x, y, vy: -rand(260, 380), vx: rand(-80, 80), t: 0, id: opal.spawn(A.orb, 'loop', 0, 0, 1) }); }

// ---------- combat
function damageEnemy(e, dmg, kx = 0) {
  if (e.dead) return;
  e.hp -= dmg;
  const ey = e.type === 'bat' ? e.y : GROUND - 80;
  text(e.x + rand(-16, 16), ey - 50, String(dmg), dmg >= 5 ? '#7df9ff' : '#ffd27a', dmg >= 5 ? 40 : 30);
  fx('hit', e.x, ey, rand(0.8, 1.1), 1.6);
  if (e.type === 'skel') e.kb = kx;
  if (e.hp <= 0) killEnemy(e);
}

function killEnemy(e) {
  e.dead = true;
  combo = comboT > 0 ? combo + 1 : 1; comboT = 2.2;
  const mult = Math.min(1 + combo * 0.1, 3);
  score += Math.round((e.type === 'bat' ? 150 : 100) * mult);
  if (Math.random() < 0.7) dropOrb(e.x, e.type === 'bat' ? e.y : GROUND - 60);
  if (e.type === 'bat') {
    fx('explosion', e.x, e.y, 0.55, 1.6);
    opal.kill(e.id); enemies.splice(enemies.indexOf(e), 1);
  } else {
    e.state = 'dead'; opal.play(A.skeleton, e.id, 'death'); opal.speed(e.id, speedFor(A.skeleton, 'death', 0.9));
  }
}

function damageBoss(dmg) {
  if (!boss || boss.dead) return;
  boss.hp -= dmg; boss.flash = 0.12;
  text(boss.x + rand(-40, 40), GROUND - 300, String(dmg), '#ff9f5a', 38);
  fx('hit', boss.x + rand(-50, 50), GROUND - rand(120, 260), 1.3, 1.6);
  if (boss.hp <= 0) {
    boss.dead = true; kick(0.6, 0.25);
    for (let i = 0; i < 7; i++) pending.push({ t: i * 0.16, fn: () => fx('explosion', boss.x + rand(-120, 120), GROUND - rand(60, 300), rand(0.8, 1.3), 1.3) });
    pending.push({ t: 1.2, fn: () => { opal.kill(boss.id); boss = null; $('boss').hidden = true; } });
    for (let i = 0; i < 8; i++) dropOrb(boss.x + rand(-80, 80), GROUND - 150);
    score += 5000; banner('Golem shattered', '+5000');
  }
}

function hurtHero(dmg, fromX) {
  if (hero.inv > 0 || hero.dash > 0) return;
  hero.hp -= dmg; hero.inv = 1.1; kick(0.35, 0.08);
  text(hero.x, GROUND - 230, `-${dmg}`, '#ff4d6d', 34);
  hero.x = clamp(hero.x + Math.sign(hero.x - fromX || 1) * 60, 50, W - 50); // knockback; the blink is in draw()
  fx('hit', hero.x, GROUND - 110, 1.2);
  if (hero.hp <= 0) gameOver();
}

function setHeroClip(clip, seconds) {
  if (hero.clip !== clip || seconds) { opal.play(A.warden, hero.id, clip); }
  hero.clip = clip;
  opal.speed(hero.id, seconds ? speedFor(A.warden, clip, seconds) : clip === 'run' ? 1.15 : 1);
  if (clip === 'slash') hero.hits.clear();
  if (clip === 'cast') hero.cast = false;
}

function ultimate() {
  if (hero.soul < 10) return;
  hero.soul = 0; setHeroClip('cast', 0.5);
  $('flash').style.opacity = 0.75; setTimeout(() => ($('flash').style.opacity = 0), 120);
  kick(0.5);
  const targets = enemies.filter((e) => !e.dead);
  targets.forEach((e, i) => pending.push({ t: 0.08 + i * 0.06, fn: () => { if (!e.dead) { fx('bolt', e.x, GROUND, 1, 1.5); damageEnemy(e, 10); } } }));
  if (boss) for (let i = 0; i < 4; i++) pending.push({ t: 0.1 + i * 0.12, fn: () => { if (boss) { fx('bolt', boss.x + rand(-60, 60), GROUND, 1, 1.5); damageBoss(12); } } });
  if (!targets.length && !boss) fx('bolt', hero.x + hero.facing * 200, GROUND, 1, 1.5);
  banner('Thunder!');
}

// ---------- update
function update(dt) {
  const left = keys.has('ArrowLeft') || keys.has('KeyA') || pad.l, right = keys.has('ArrowRight') || keys.has('KeyD') || pad.r;
  const dir = (right ? 1 : 0) - (left ? 1 : 0);
  const p = opal.progress(hero.id);
  const locked = (hero.clip === 'slash' && p < 0.42) || (hero.clip === 'cast' && p < 0.35) ;

  // actions
  hero.dashCd -= dt; hero.fireCd -= dt; hero.inv = Math.max(0, hero.inv - dt);
  if (pressed.has('ult')) ultimate();
  if (pressed.has('dash') && hero.dashCd <= 0 && hero.dash <= 0) {
    if (dir) hero.facing = dir;
    hero.dash = 0.2; hero.dashCd = 0.75; setHeroClip('run'); opal.speed(hero.id, 2.4);
  }
  if (pressed.has('slash') && !locked && hero.dash <= 0) { if (dir) hero.facing = dir; setHeroClip('slash', 0.55); }
  if (pressed.has('fire') && !locked && hero.fireCd <= 0 && hero.dash <= 0) { if (dir) hero.facing = dir; hero.fireCd = 0.5; setHeroClip('cast', 0.5); }
  pressed.clear();

  // movement
  if (hero.dash > 0) {
    hero.dash -= dt; hero.x = clamp(hero.x + hero.facing * 2700 * dt, 50, W - 50);
    if ((hero.ghostT -= dt) <= 0) { hero.ghostT = 0.035; ghosts.push({ x: hero.x, facing: hero.facing, life: 0.28, id: opal.spawn(A.warden, 'run', 0, 0, 1) }); }
  } else if (!locked) {
    if (dir) { hero.facing = dir; hero.x = clamp(hero.x + dir * 380 * dt, 50, W - 50); if (hero.clip !== 'run') setHeroClip('run'); }
    else if (hero.clip === 'run' || opal.done(hero.id)) setHeroClip('idle');
  }
  if (hero.clip !== 'idle' && hero.clip !== 'run' && opal.done(hero.id) && hero.dash <= 0) setHeroClip(dir ? 'run' : 'idle');

  // slash hit window
  if (hero.clip === 'slash') {
    const q = opal.progress(hero.id);
    if (q > 0.17 && q < 0.4) {
      for (const e of [...enemies]) {
        if (e.dead || hero.hits.has(e)) continue;
        const d = (e.x - hero.x) * hero.facing, high = e.type === 'bat' && e.y < GROUND - 270;
        if (d > -50 && d < 235 && !high) { hero.hits.add(e); damageEnemy(e, 2, hero.facing * 260); kick(0.12, 0.05); }
      }
      if (boss && !hero.hits.has(boss) && (boss.x - hero.x) * hero.facing > -60 && (boss.x - hero.x) * hero.facing < 270) { hero.hits.add(boss); damageBoss(3); kick(0.15, 0.06); }
    }
  }
  // cast: release the fireball as the palm pushes forward
  if (hero.clip === 'cast' && !hero.cast && opal.progress(hero.id) > 0.3 && hero.soul >= 0) {
    hero.cast = true;
    const s = { x: hero.x + hero.facing * 95, y: GROUND - SIZE.warden * 0.6, facing: hero.facing, life: 1.6, id: opal.spawn(A.fireball, 'loop', 0, 0, 1) };
    opal.speed(s.id, 1.6); shots.push(s);
  }

  // fireballs
  for (const s of [...shots]) {
    s.x += s.facing * 980 * dt; s.life -= dt;
    let hit = s.life <= 0 || s.x < -60 || s.x > W + 60;
    const struck = enemies.find((e) => !e.dead && Math.abs(e.x - s.x) < 55 && Math.abs((e.type === 'bat' ? e.y : GROUND - 75) - s.y) < 85);
    const bossHit = boss && !boss.dead && Math.abs(boss.x - s.x) < 110;
    if (struck || bossHit) {
      hit = true; fx('explosion', s.x, s.y, 1, 1.3); kick(0.22, 0.05);
      for (const e of [...enemies]) if (!e.dead && Math.hypot(e.x - s.x, (e.type === 'bat' ? e.y : GROUND - 75) - s.y) < 140) damageEnemy(e, 3, s.facing * 200);
      if (bossHit) damageBoss(5);
    }
    if (hit) { opal.kill(s.id); shots.splice(shots.indexOf(s), 1); }
  }

  // portals
  for (const pt of [...portals]) {
    pt.t += dt; pt.spawnT -= dt;
    if (pt.spawnT <= 0 && pt.queue.length) { spawnEnemy(pt.queue.shift(), pt.x); pt.spawnT = Math.max(0.35, 0.95 - wave * 0.04); }
    if (!pt.queue.length && pt.t > 1.4 && !pt.closing) pt.closing = 0.45;
    if (pt.closing !== undefined && (pt.closing -= dt) <= 0) { opal.kill(pt.id); portals.splice(portals.indexOf(pt), 1); }
  }

  // enemies
  for (const e of [...enemies]) {
    if (e.type === 'bat') {
      e.t += dt; const dx = hero.x - e.x;
      e.facing = dx >= 0 ? 1 : -1;
      if (e.retreat > 0) { e.retreat -= dt; e.baseY = Math.max(330, e.baseY - 260 * dt); e.x -= e.facing * e.v * 0.6 * dt; }
      else {
        e.x += e.facing * e.v * dt;
        if (Math.abs(dx) < 220) e.baseY += (GROUND - 130 - e.baseY) * Math.min(1, 2.5 * dt);
        if (Math.abs(dx) < 50 && Math.abs(GROUND - 120 - e.y) < 70) { hurtHero(1, e.x); e.retreat = 1.2; }
      }
      e.y = e.baseY + Math.sin(e.t * 4 + e.phase) * 26;
    } else if (e.state === 'dead') {
      if (opal.done(e.id)) { e.fade += dt; if (e.fade > 0.7) { opal.kill(e.id); enemies.splice(enemies.indexOf(e), 1); } }
    } else {
      e.cd -= dt;
      e.x += e.kb * dt; e.kb *= Math.pow(0.02, dt);
      const dx = hero.x - e.x;
      if (e.state === 'walk') {
        e.facing = dx >= 0 ? 1 : -1;
        if (Math.abs(dx) > 85) e.x += e.facing * e.v * dt;
        else if (e.cd <= 0) { e.state = 'attack'; e.hitDone = false; opal.play(A.skeleton, e.id, 'attack'); opal.speed(e.id, speedFor(A.skeleton, 'attack', 0.95)); }
      } else if (e.state === 'attack') {
        const q = opal.progress(e.id);
        if (!e.hitDone && q > 0.28 && q < 0.45) { e.hitDone = true; if (Math.abs(dx) < 125) hurtHero(1, e.x); }
        if (opal.done(e.id)) { e.state = 'walk'; e.cd = rand(0.8, 1.6); opal.play(A.skeleton, e.id, 'walk'); opal.speed(e.id, e.v / 80); }
      }
    }
  }

  // boss
  if (boss && !boss.dead) {
    const dx = hero.x - boss.x;
    boss.facing = dx >= 0 ? 1 : -1; boss.slamCd -= dt; boss.tpT -= dt; boss.flash = Math.max(0, boss.flash - dt);
    if (boss.state === 'idle' && boss.slamCd <= 0) { boss.state = 'slam'; boss.hitDone = false; opal.play(A.golem, boss.id, 'slam'); opal.speed(boss.id, speedFor(A.golem, 'slam', 1.6)); }
    if (boss.state === 'slam') {
      const q = opal.progress(boss.id);
      if (!boss.hitDone && q > 0.42) {
        boss.hitDone = true; kick(0.45, 0.06);
        const dirn = boss.facing, x0 = boss.x + dirn * 140;
        for (let i = 0; i < 6; i++) pending.push({ t: i * 0.11, fn: () => { const x = x0 + dirn * i * 125; if (x > -50 && x < W + 50) { fx('shock', x, GROUND, 0.75, 1.5); if (Math.abs(hero.x - x) < 80) hurtHero(2, x); } } });
      }
      if (opal.done(boss.id)) { boss.state = 'idle'; boss.slamCd = Math.max(1.6, 3.4 - wave * 0.05); opal.play(A.golem, boss.id, 'idle'); opal.speed(boss.id, 1); }
    }
    if (boss.state === 'idle' && boss.tpT <= 0) { // step through a rift to the other side
      boss.tpT = rand(8, 11); openPortal(boss.x, []);
      boss.x = hero.x < W / 2 ? rand(W - 300, W - 180) : rand(180, 300);
      openPortal(boss.x, ['skel', 'skel']);
    }
    if (Math.abs(dx) < 95) hurtHero(1, boss.x);
  }

  // orbs
  for (const o of [...orbs]) {
    o.t += dt;
    const dx = hero.x - o.x, dy = GROUND - 100 - o.y, d = Math.hypot(dx, dy);
    if (o.t > 0.5 && d < 190) { o.x += (dx / d) * 700 * dt; o.y += (dy / d) * 700 * dt; }
    else { o.vy += 900 * dt; o.x += o.vx * dt; o.y += o.vy * dt; if (o.y > GROUND - 30) { o.y = GROUND - 30; o.vy *= -0.4; o.vx *= 0.6; } }
    if (d < 45 && o.t > 0.25) { hero.soul = Math.min(10, hero.soul + 1); score += 10; opal.kill(o.id); orbs.splice(orbs.indexOf(o), 1); }
    else if (o.t > 14) { opal.kill(o.id); orbs.splice(orbs.indexOf(o), 1); }
  }

  // effects
  for (const f of [...fxs]) {
    const over = f.life ? (f.age += dt) >= f.life : opal.progress(f.id) >= 1;
    if (over) { opal.kill(f.id); fxs.splice(fxs.indexOf(f), 1); }
  }
  for (const g of [...ghosts]) if ((g.life -= dt) <= 0) { opal.kill(g.id); ghosts.splice(ghosts.indexOf(g), 1); }
  for (const p2 of [...pending]) if ((p2.t -= dt) <= 0) { pending.splice(pending.indexOf(p2), 1); p2.fn(); }
  for (const t of texts) { t.life -= dt; t.y -= 60 * dt; }
  texts = texts.filter((t) => t.life > 0);

  // waves
  comboT -= dt; if (comboT <= 0) combo = 0;
  const alive = enemies.length + portals.reduce((s, p3) => s + p3.queue.length, 0) + (boss ? 1 : 0);
  if (!alive && state === 'play') {
    if (nextWaveT === null) { nextWaveT = 2.6; if (wave) banner('Wave cleared', `Score ${score.toLocaleString()}`); }
    if ((nextWaveT -= dt) <= 0) { nextWaveT = null; startWave(); }
  } else if (alive) nextWaveT = null;
  if ((bannerT -= dt) <= 0) $('banner').classList.remove('show');
}

// ---------- draw
function draw() {
  const sh = shake > 0 ? shake : 0;
  world.style.transform = sh ? `translate(${rand(-1, 1) * sh * 16}px, ${rand(-1, 1) * sh * 10}px)` : '';
  const blink = hero.inv > 0 && Math.floor(hero.inv * 14) % 2 === 0 ? 0.35 : 1;
  atFeet(hero.id, wardenAnchor[hero.clip] ?? AN.warden, K.warden, hero.x, GROUND, hero.facing, blink);
  for (const g of ghosts) atFeet(g.id, wardenAnchor.run, K.warden, g.x, GROUND, g.facing, (g.life / 0.28) * 0.45);
  for (const e of enemies) {
    if (e.type === 'bat') atCenter(e.id, AN.bat, K.bat, e.x, e.y, e.facing);
    else atFeet(e.id, AN.skel, K.skel * (1 + e.lane / 200), e.x, GROUND + e.lane, e.facing, e.state === 'dead' ? Math.max(0, 1 - e.fade / 0.7) : 1);
  }
  if (boss) atFeet(boss.id, AN.golem, K.golem, boss.x, GROUND, boss.facing, boss.flash > 0 ? 0.6 : 1);
  for (const pt of portals) {
    const open = Math.min(1, pt.t / 0.3), close = pt.closing !== undefined ? Math.max(0, pt.closing / 0.45) : 1;
    atFeet(pt.id, AN.portal, K.portal * open * close, pt.x, GROUND - 8, 1, 0.92);
  }
  for (const o of orbs) atCenter(o.id, AN.orb, K.orb, o.x, o.y + Math.sin(o.t * 5) * 4);
  for (const s of shots) atCenter(s.id, AN.fireball, K.fireball, s.x, s.y, s.facing);
  for (const f of fxs) {
    if (f.kind === 'hit') { const q = f.age / f.life; atCenter(f.id, AN.hit, f.k * (0.45 + 0.75 * Math.sin(Math.min(1, q * 1.6) * Math.PI / 2)), f.x, f.y, 1, 1 - q * q); continue; }
    if (f.kind === 'shock') { const q = f.age / f.life; atFeet(f.id, AN.shock, f.k * (0.75 + 0.35 * q), f.x, f.y - 14 * q, f.facing, 1 - q * q); continue; }
    // video effects: the clip starts at its peak, so pop it in, and fade the tail
    const q = opal.progress(f.id), pop = q < 0.12 ? 0.55 + 0.45 * Math.sin((q / 0.12) * Math.PI / 2) : 1, op = q > 0.65 ? Math.max(0, 1 - (q - 0.65) / 0.35) : 1;
    if (f.kind === 'bolt') atFeet(f.id, AN.bolt, f.k, f.x, f.y, f.facing, op);
    else atCenter(f.id, AN[f.kind], f.k * pop, f.x, f.y, f.facing, op);
  }
  // 2D overlay: damage numbers
  g2.setTransform(S, 0, 0, S, 0, 0); g2.clearRect(0, 0, W, H);
  g2.textAlign = 'center'; g2.lineJoin = 'round';
  for (const t of texts) {
    g2.globalAlpha = Math.min(1, t.life / 0.3); g2.font = `900 ${t.size}px Cinzel, serif`;
    g2.lineWidth = 5; g2.strokeStyle = '#0b0714'; g2.strokeText(t.t, t.x, t.y); g2.fillStyle = t.color; g2.fillText(t.t, t.x, t.y);
  }
  g2.globalAlpha = 1;
  // HUD
  $('hp').firstElementChild.style.transform = `scaleX(${Math.max(0, hero.hp) / hero.max})`;
  $('soul').firstElementChild.style.transform = `scaleX(${hero.soul / 10})`;
  $('soul').classList.toggle('full', hero.soul >= 10);
  $('soulLabel').textContent = hero.soul >= 10 ? 'Soul full: press L for thunder' : `Soul ${hero.soul}/10`;
  $('score').textContent = score.toLocaleString();
  $('wave').textContent = wave ? `Wave ${wave}` : '';
  $('combo').textContent = combo > 1 ? `${combo} combo` : '';
  if (boss) $('bossHp').style.transform = `scaleX(${Math.max(0, boss.hp) / boss.max})`;
}

function gameOver() {
  state = 'over';
  $('final').textContent = `Score ${score.toLocaleString()} · fell on wave ${wave}`;
  $('over').hidden = false; setTimeout(() => $('again').focus(), 50);
}

// ---------- loop
let last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 0;
function frame(now) {
  let dt = Math.min((now - last) / 1000, 1 / 20); last = now;
  if (state === 'play') {
    shake = Math.max(0, shake - dt);
    if (stop > 0) { stop -= dt; dt = 0; } else update(dt);
    if (state === 'play') draw();
  }
  opal.render(state === 'over' ? 0 : dt);
  fpsAcc += Math.max(dt, 1e-3); fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = fpsN = 0; }
  if (state !== 'title') {
    const n = 1 + enemies.length + portals.length + orbs.length + shots.length + fxs.length + ghosts.length + (boss ? 1 : 0);
    $('tech').textContent = `${n} video sprites · ${fps.toFixed(0)} fps`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
$('start').focus();
window.__game = {
  get state() { return state; }, get hero() { return hero; }, get enemies() { return enemies; }, get boss() { return boss; },
  get score() { return score; }, get wave() { return wave; }, start, press: (a) => pressed.add(a), keys,
  spawn: (type, n) => { for (let i = 0; i < n; i++) spawnEnemy(type, rand(80, W - 80)); },
  setWave: (n) => { wave = n - 1; }, soul: (n) => { hero.soul = n; },
};
