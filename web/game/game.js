// Opal Dojo — a small arena brawler whose every character and effect is a
// transparent video sprite, played by the Opal runtime. Logic works in a fixed
// 1280×720 world; the canvas is scaled to fit the window.
import { createOpal } from '../opal.js';

const W = 1280, H = 720, GROUND = 652;          // feet line in world px
const HERO_H = 205, IMP_H = 104, SMOKE_W = 280;  // on-screen sizes in world px
const RUN = 430, MAX_IMPS = 400;
const $ = (s) => document.getElementById(s);
const rand = (a, b) => a + Math.random() * (b - a);

// ---------- layout: fit a 16:9 world into the window
const world = $('world'), cv = $('cv');
const mobile = matchMedia('(pointer: coarse)').matches;
let S = 1; // canvas px per world px
function fit() {
  const k = Math.min(innerWidth / W, innerHeight / H);
  world.style.width = `${W * k}px`; world.style.height = `${H * k}px`;
  const dpr = Math.min(devicePixelRatio, mobile ? 1.5 : 2);
  cv.width = Math.round(W * k * dpr); cv.height = Math.round(H * k * dpr);
  S = cv.width / W;
}
fit(); addEventListener('resize', fit);

// ---------- assets
const opal = await createOpal(cv);
const lod = { scale: mobile ? 0.6 : 1 }; // mobile: keep ~1/3 of the GPU memory
const [impA, heroA, smokeA] = await Promise.all(['imp', 'hero', 'smoke'].map((n) => opal.load(`assets/${n}.opal`, lod)));
// load order = draw order: imps, then hero, then smoke on top

// Per clip: where the feet are and where the body's center is, relative to the cell center (source px).
const anchor = (a, clip) => {
  const c = a.clips[clip], [bx, by, bw, bh] = c.box;
  return { feet: by + bh - c.height / 2, cx: bx + bw / 2 - c.width / 2, h: bh, w: bw };
};
const heroK = HERO_H / anchor(heroA, 'idle').h;
const heroCx = anchor(heroA, 'idle').cx; // shared by all hero clips: same canvas, same body
const heroFeet = Object.fromEntries(['idle', 'run', 'attack'].map((c) => [c, anchor(heroA, c).feet]));
const impAn = anchor(impA, 'walk'), impK = IMP_H / impAn.h;
const smokeK = SMOKE_W / anchor(smokeA, 'burst').w;
const ATTACK_SPEED = (heroA.clips.attack.frames / heroA.fps) / 0.7; // whole slash in 0.7 s
$('loading').textContent = `${impA.frames + heroA.frames + smokeA.frames} video frames decoded to the GPU · made with Opal`;

// place a sprite by its feet (x = body center in world px), facing ±1
function put(id, a, k, an, x, feetY, facing, op = 1) {
  const kk = k * S;
  opal.set(id, (x - an.cx * k * facing) * S, (feetY - an.feet * k) * S, kk * facing, op);
}

// ---------- game state (declared before input so early key presses are safe)
let state = 'title', hero, imps, smokes, score, wave, killsToWave, spawnT, combo, comboT, shake, bannerT;

// ---------- input
const keys = new Set();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (['Space', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if ((e.code === 'Space' || e.code === 'KeyJ') && !e.repeat) slashQueued = true;
  if ((e.code === 'Enter' || e.code === 'Space') && state !== 'play' && !e.repeat) start();
});
addEventListener('keyup', (e) => keys.delete(e.code));
let slashQueued = false;
const pad = { l: false, r: false };
for (const [id, k] of [['pl', 'l'], ['pr', 'r']]) {
  $(id).addEventListener('pointerdown', (e) => { pad[k] = true; e.preventDefault(); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) $(id).addEventListener(ev, () => (pad[k] = false));
}
$('pa').addEventListener('pointerdown', (e) => { slashQueued = true; e.preventDefault(); });
$('start').onclick = start;
$('again').onclick = start;

function start() {
  if (state === 'play') return;
  hero?.id != null && opal.kill(hero.id);
  imps?.forEach((e) => opal.kill(e.id));
  smokes?.forEach((s) => opal.kill(s.id));
  hero = { x: W / 2, facing: 1, clip: 'idle', hp: 5, inv: 0, hit: new Set(), id: opal.spawn(heroA, 'idle', 0, 0, 1) };
  imps = []; smokes = [];
  score = 0; wave = 1; killsToWave = 12; spawnT = 1; combo = 0; comboT = 0; shake = 0;
  state = 'play';
  $('title').hidden = $('over').hidden = true;
  $('hud').hidden = false;
  banner('Wave 1');
}

function banner(text) { $('banner').textContent = text; $('banner').classList.add('show'); bannerT = 1.6; }

function heroClip(clip) {
  if (hero.clip === clip) return;
  hero.clip = clip;
  opal.play(heroA, hero.id, clip);
  opal.speed(hero.id, clip === 'attack' ? ATTACK_SPEED : clip === 'run' ? 1.25 : 1);
  if (clip === 'attack') hero.hit.clear();
}

function spawnImp() {
  const side = Math.random() < 0.5 ? -1 : 1;
  const lane = rand(-16, 14); // a little depth so the crowd isn't a single line
  const e = { x: side < 0 ? -80 : W + 80, lane, v: rand(70, 115) + wave * 11, id: opal.spawn(impA, 'walk', 0, 0, 1) };
  opal.speed(e.id, e.v / 95);
  imps.push(e);
}

function kill(e, i) {
  opal.kill(e.id);
  imps.splice(i, 1);
  const s = { x: e.x, y: GROUND + e.lane - IMP_H * 0.55, id: opal.spawn(smokeA, 'burst', 0, 0, 1) };
  opal.speed(s.id, 1.5);
  smokes.push(s);
  combo = comboT > 0 ? combo + 1 : 1;
  comboT = 1.6;
  score += 10 * Math.min(combo, 20);
  shake = Math.min(shake + 0.12, 0.3);
  if (--killsToWave <= 0) { wave++; killsToWave = 12 + wave * 6; banner(`Wave ${wave}`); }
}

function update(dt) {
  // hero
  const left = keys.has('ArrowLeft') || keys.has('KeyA') || pad.l, right = keys.has('ArrowRight') || keys.has('KeyD') || pad.r;
  const dir = (right ? 1 : 0) - (left ? 1 : 0);
  const p = hero.clip === 'attack' ? opal.progress(hero.id) : 1;
  if (slashQueued && (hero.clip !== 'attack' || p > 0.42)) {
    if (dir) hero.facing = dir;
    hero.clip = '';
    heroClip('attack');
  }
  slashQueued = false;
  const busy = hero.clip === 'attack' && opal.progress(hero.id) < 0.42; // committed part of the slash
  if (!busy) {
    if (dir) { hero.facing = dir; hero.x = Math.max(60, Math.min(W - 60, hero.x + dir * RUN * dt)); heroClip('run'); }
    else if (hero.clip !== 'attack' || opal.done(hero.id)) heroClip('idle');
  }
  // slash hit window: the blade sweeps through the first ~30% of the clip
  if (hero.clip === 'attack') {
    const q = opal.progress(hero.id);
    if (q > 0.06 && q < 0.34) {
      for (let i = imps.length - 1; i >= 0; i--) {
        const e = imps[i], d = (e.x - hero.x) * hero.facing;
        if (d > -40 && d < 210 && !hero.hit.has(e)) { hero.hit.add(e); kill(e, i); }
      }
    }
  }
  hero.inv = Math.max(0, hero.inv - dt);

  // imps
  spawnT -= dt;
  const every = Math.max(0.12, 1.25 * Math.pow(0.84, wave - 1));
  while (spawnT <= 0) { if (imps.length < MAX_IMPS) spawnImp(); spawnT += every; }
  for (const e of imps) {
    const d = hero.x - e.x;
    e.facing = d >= 0 ? 1 : -1;
    if (Math.abs(d) > 48) e.x += e.facing * e.v * dt;
    else if (hero.inv <= 0) {
      hero.hp--; hero.inv = 1.3; shake = 0.35;
      for (const o of imps) if (Math.abs(o.x - hero.x) < 160) o.x -= Math.sign(hero.x - o.x || 1) * 110;
      if (hero.hp <= 0) return gameOver();
    }
  }
  // smoke: fade the tail, drop when done
  for (let i = smokes.length - 1; i >= 0; i--) if (opal.progress(smokes[i].id) >= 1) { opal.kill(smokes[i].id); smokes.splice(i, 1); }

  comboT -= dt; if (comboT <= 0) combo = 0;
  bannerT -= dt; if (bannerT <= 0) $('banner').classList.remove('show');
  shake = Math.max(0, shake - dt);
}

function draw() {
  const sx = shake > 0 ? rand(-1, 1) * shake * 14 : 0, sy = shake > 0 ? rand(-1, 1) * shake * 8 : 0;
  world.style.transform = shake > 0 ? `translate(${sx}px, ${sy}px)` : '';
  const flash = hero.inv > 0 && Math.floor(hero.inv * 12) % 2 === 0 ? 0.35 : 1;
  put(hero.id, heroA, heroK, { cx: heroCx, feet: heroFeet[hero.clip || 'idle'] }, hero.x, GROUND, hero.facing, flash);
  for (const e of imps) {
    const depth = 1 + e.lane / 140;
    put(e.id, impA, impK * depth, impAn, e.x, GROUND + e.lane, e.facing);
  }
  for (const s of smokes) {
    // the clip starts on the full puff (its pop-in was cut: it reached the frame edge), so pop it in here
    const q = opal.progress(s.id), pop = q < 0.1 ? 0.45 + 0.55 * Math.sin((q / 0.1) * Math.PI / 2) : 1;
    opal.set(s.id, s.x * S, s.y * S, smokeK * S * pop, q > 0.75 ? Math.max(0, 1 - (q - 0.75) / 0.25) : 1);
  }
  $('score').textContent = score.toLocaleString();
  const hp = Math.max(0, Math.min(5, hero.hp));
  $('hearts').textContent = '♥'.repeat(hp) + '♡'.repeat(5 - hp);
  $('wave').textContent = `Wave ${wave} · ${killsToWave} to go`;
  $('combo').textContent = combo > 1 ? `${combo} combo` : '';
}

function gameOver() {
  state = 'over';
  $('final').textContent = `Score ${score.toLocaleString()} · reached wave ${wave}`;
  $('over').hidden = false;
  setTimeout(() => $('again').focus(), 50);
}

// ---------- loop
let last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 1 / 20); last = now;
  if (state === 'play') { update(dt); if (state === 'play') draw(); }
  opal.render(state === 'over' ? 0 : dt);
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = fpsN = 0; }
  if (state !== 'title') $('tech').textContent = `${imps.length + smokes.length + 1} video sprites · ${fps.toFixed(0)} fps`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
$('start').focus();
window.__game = { spawn: (n) => { for (let i = 0; i < n; i++) spawnImp(); }, get state() { return state; }, get imps() { return imps?.length ?? 0; }, get score() { return score; }, get hero() { return hero; }, start, keys };
