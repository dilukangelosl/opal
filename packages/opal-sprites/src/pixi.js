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
