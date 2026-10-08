// PixiJS v8 adapter: .opal clips become ordinary Pixi textures, so they work with
// AnimatedSprite, containers, filters and Pixi's batching.
//
//   import { loadOpal } from 'opal-sprites/pixi';
//   const hero = await loadOpal('hero.opal');
//   const sprite = hero.sprite('run');          // an AnimatedSprite, already playing
//   sprite.textures = hero.clips.slash;          // switch clip; anchors stay aligned
//
// Each frame is a trimmed texture whose original size is the whole video cell, so
// anchor (0.5, 0.5) is the same point for every clip of a character, and the
// visible pixels are tightly packed on a few shared pages.
import { AnimatedSprite, Rectangle, Texture } from 'pixi.js';
import { decodeOpal } from './decode.js';

export { decodeOpal, parseOpal } from './decode.js';

/**
 * @param {string|URL|ArrayBuffer|Uint8Array} src
 * @param {{ scale?: number, pageSize?: number }} [opts]
 */
export async function loadOpal(src, opts = {}) {
  const d = await decodeOpal(src, opts);
  const s = d.scale;
  const sources = d.pages.map((canvas) => Texture.from(canvas).source);
  const clips = {};
  for (const [name, c] of Object.entries(d.clips)) {
    clips[name] = c.frames.map((f) => new Texture({
      source: sources[f.page],
      frame: new Rectangle(f.x, f.y, f.w, f.h),
      orig: new Rectangle(0, 0, c.src[0] * s, c.src[1] * s),
      trim: new Rectangle(c.origin[0] * s, c.origin[1] * s, f.w, f.h),
      defaultAnchor: { x: 0.5, y: 0.5 },
      label: `${name}#${f.page}`,
    }));
  }
  const meta = d.clips;
  return {
    fps: d.fps,
    /** Texture arrays per clip, for `new AnimatedSprite(clips.name)`. */
    clips,
    /** Whether the clip was encoded to loop (`--once` clips don't). */
    loops: (name) => meta[name].loop,
    /** Anchor that puts the clip's lowest visible pixel (the feet) at the sprite's y. */
    feetAnchor(name) {
      const c = meta[name];
      return { x: 0.5, y: (c.origin[1] + c.rect[3]) / c.src[1] };
    },
    /** A ready AnimatedSprite at the clip's own frame rate (Pixi ticks at 60). */
    sprite(name, { play = true, anchor } = {}) {
      if (!clips[name]) throw new Error(`opal: no clip '${name}' (have ${Object.keys(clips).join(', ')})`);
      const a = new AnimatedSprite(clips[name]);
      a.animationSpeed = d.fps / 60;
      a.loop = meta[name].loop;
      if (anchor) a.anchor.set(anchor.x, anchor.y);
      if (play) a.play();
      return a;
    },
    /** Free the GPU textures and pages. */
    destroy() {
      Object.values(clips).flat().forEach((t) => t.destroy(false));
      sources.forEach((t) => t.destroy());
    },
  };
}

/**
 * The same API as Opal's own runtime (`createOpal`), drawn by PixiJS — so a game written
 * against `createOpal` runs on Pixi by swapping one line:
 *
 *   const opal = await createPixiOpal(canvas);   // instead of createOpal(canvas)
 *
 * Coordinates and scales mean exactly what they mean in `createOpal` (canvas pixels; a
 * scale multiplies the clip's encoded pixels; negative scale mirrors horizontally).
 * Each loaded file gets its own Container, in load order, so draw order matches too.
 * Pass an existing Pixi `Application` as `app` to draw into your own scene instead.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ app?: import('pixi.js').Application, stage?: import('pixi.js').Container }} [opts]
 */
export async function createPixiOpal(canvas, { app, stage } = {}) {
  const { Application, Container, Sprite } = await import('pixi.js');
  const own = !app;
  if (own) {
    app = new Application();
    await app.init({ canvas, width: canvas.width, height: canvas.height, resolution: 1, autoStart: false, backgroundAlpha: 0, antialias: false, preference: 'webgl' });
  }
  const root = stage ?? app.stage;
  const insts = new Map();
  let nextId = 0;

  async function load(url, { scale = 1 } = {}) {
    const p = await loadOpal(url, { scale });
    const layer = new Container();
    root.addChild(layer);
    const clips = {};
    for (const [name, textures] of Object.entries(p.clips)) {
      const t0 = textures[0];
      // file-scale numbers, identical to createOpal's clip info
      const w = Math.round(t0.orig.width / scale), h = Math.round(t0.orig.height / scale);
      const box = [t0.trim.x / scale, t0.trim.y / scale, t0.trim.width / scale, t0.trim.height / scale].map(Math.round);
      clips[name] = { index: Object.keys(clips).length, frames: textures.length, width: w, height: h, box, textures, loop: p.loops(name) };
    }
    const frames = Object.values(clips).reduce((s, c) => s + c.frames, 0);
    return { fps: p.fps, frames, clips, layer, loadScale: scale, pixi: p };
  }

  function spawn(a, clip, x, y, scale = 1) {
    const c = a.clips[clip];
    if (!c) throw new Error(`opal: no clip '${clip}'`);
    const s = new Sprite(c.textures[0]);
    s.anchor.set(0.5);
    a.layer.addChild(s);
    const id = nextId++;
    insts.set(id, { a, c, s, t: 0, speed: 1 });
    set(id, x, y, scale, 1);
    return id;
  }
  function set(id, x, y, scale = 1, opacity = 1) {
    const i = insts.get(id); if (!i) return;
    const k = scale / i.a.loadScale;
    i.s.position.set(x, y); i.s.scale.set(k, Math.abs(k)); i.s.alpha = opacity;
  }
  function play(a, id, clip) { const i = insts.get(id); if (!i) return; i.c = a.clips[clip]; i.t = 0; }
  const progress = (id) => { const i = insts.get(id); return i ? (i.t * i.a.fps) / i.c.frames : 0; };

  function render(dt) {
    if (own && (app.renderer.width !== canvas.width || app.renderer.height !== canvas.height)) app.renderer.resize(canvas.width, canvas.height);
    for (const i of insts.values()) {
      i.t += dt * i.speed;
      const n = i.c.frames, len = n / i.a.fps;
      if (i.c.loop && i.t >= len) i.t %= len;
      i.s.texture = i.c.textures[Math.min(n - 1, Math.floor(i.t * i.a.fps))];
    }
    if (own) app.renderer.render(app.stage);
  }

  return {
    app, load, render, spawn, set, play,
    speed: (id, s) => { const i = insts.get(id); if (i) i.speed = s; },
    progress,
    done: (id) => { const i = insts.get(id); return !!i && !i.c.loop && progress(id) >= 1; },
    kill: (id) => { const i = insts.get(id); if (i) { i.s.destroy(); insts.delete(id); } },
  };
}
