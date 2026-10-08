---
name: opal-sprites
description: Use Opal (npm "opal-sprites") to put transparent video sprites in web games — characters, enemies and VFX from green-screen/alpha/AI video. Covers making .opal files (opal CLI, Opal Studio), the runtime API (createOpal), PixiJS integration (loadOpal, AnimatedSprite, createPixiOpal to run a whole game on Pixi), decodeOpal for other renderers, anchoring/flipping/hit timing, memory and mobile tuning, browser support and troubleshooting. Use when the user mentions Opal, .opal files, opal-sprites, transparent/alpha video sprites, video sprites in Pixi/WebGL/canvas, or wants game characters/effects from video.
---

# Opal: transparent video sprites for web games

Opal turns transparent video (green screen, alpha video, or AI-generated clips) into small `.opal`
files, and plays thousands of them at once in the browser.
- **Format:** plain H.264, with colour on top and alpha stored as grey underneath, so every browser decodes it in
  hardware. Clips are trimmed and atlas-packed. Multiple named clips (idle, run, attack…) live in one file.
- **Runtime:** about 15 KB (Rust/wasm + WebGL2). Each file is decoded **once** into a GPU texture array; after that
  every sprite is a textured quad, and each file is a single instanced draw call. Measured: 300+ animated video
  sprites at 120 fps, versus `<video>` elements managing about 20 fps at 200.
- Repo: https://github.com/dilukangelosl/opal · site and demos: https://dilukangelosl.github.io/opal/
- To *generate* sprites with AI (fal), use the companion skill **opal-video-sprites**.

## Choose the path
| Need | Use |
|---|---|
| Fastest rendering, crowds, a game built from scratch | `createOpal(canvas)` from `opal-sprites` |
| A project already on PixiJS v8 | `loadOpal()` from `opal-sprites/pixi` → `AnimatedSprite` |
| An existing Opal game that should run on Pixi | `createPixiOpal(canvas)`: same API as `createOpal`, one-line swap |
| three.js / Canvas2D / anything else | `decodeOpal()` → RGBA canvas pages + frame rects |
| Making `.opal` files by hand | **Opal Studio** (browser): `/web/studio/` |
| Making `.opal` files in scripts or CI | **opal CLI** (`cargo build --release -p opal-cli`) |

```sh
npm i opal-sprites          # pixi.js >= 8 is an optional peer dependency
```

## Making .opal files

### opal CLI (Rust; needs ffmpeg/ffprobe on PATH)
```sh
opal encode -o hero.opal idle=idle.mov run=run.mov                  # one clip per input; loops by default
opal encode -o hero.opal --once die idle.mov run.mov die=die.webm    # --once = play once, no loop
opal encode -o hero.opal sheet.mov --grid 3x2 --names idle,walk,,jump,attack,die@0-44
opal encode -o fx.opal  boom.mp4 --rect boom=0,0,768,768@10-33        # region + frame range (inclusive)
opal encode -o hero.opal --key auto green.mp4                          # chroma key: detect the backdrop
opal encode -o hero.opal --key "#00ff00,#00e000" twotone.mp4           # chroma key: explicit colours
opal encode -o hero.opal --fps 12 --scale 0.5 --crf 24 ...             # game-size: about 10× less GPU memory
```
- **Clip naming:** grid cells are named row-major; an empty name skips the cell. `@from-to` counts *output* frames
  (after `--fps`), inclusive. `--rect` coordinates are in source pixels.
- **Clip lengths:** inputs are concatenated in time. Each input's regions are trimmed separately and packed into a
  shared atlas.
- **Keying controls:**
  - `--key-tol 30` and `--key-soft 20` set the threshold and edge softness.
  - `--despill 1` strips the green tint.
  - `--despeckle 16` removes specks smaller than that many pixels.
- **How keying works:** it compares colour relative to brightness, so lighting falloff doesn't matter. It also
  decontaminates soft edges, glows, smoke and motion blur.
- **Output:** the CLI prints each clip's size and the GPU memory. It warns if the coded frame is over 2048 px, which
  some phone decoders reject.

### Opal Studio (no install)
Drop videos in, then:
1. drag rectangles or **Split into a grid**
2. set first and last frames
3. remove the background (detect, pick colours or enter hex)
4. preview over a **reference screenshot of your game** to get the size right ("Export at preview size" bakes it
   in)
5. **Export .opal**; the preview then switches to the real runtime

In the Studio, clips share one timeline (N clips × L frames = L encoded frames).

### Checking files
`/web/player.html`: drop an `.opal` in to play every clip. Use the light background to spot green fringes.

## Runtime API: `createOpal`
```js
import { createOpal } from 'opal-sprites';

const opal = await createOpal(canvas);                       // WebGL2 on this canvas (it clears to transparent)
const hero = await opal.load('/hero.opal', { scale: 1 });    // { clips, fps, frames, atlas, vram, bytes }
const id = opal.spawn(hero, 'idle', x, y, scale);            // x,y in CANVAS pixels = centre of the clip's video cell

function frame(dt) {                                         // seconds
  opal.set(id, x, y, scale * facing, opacity);               // facing ±1: negative scale mirrors horizontally only
  opal.render(dt);                                           // advances animation and draws everything
}
opal.play(hero, id, 'attack');      // switch clip, restart it
opal.speed(id, 2.5);                // playback speed multiplier
opal.progress(id);                  // 0..1 through the clip (keeps growing past 1 for one-shots)
opal.done(id);                      // a one-shot (--once) clip has finished
opal.kill(id);                      // free the instance
```
- **Draw order** is the load order of files; within a file, spawn order. Load backgrounds' VFX layers last if they
  should be on top.
- **`load(url, { scale, mipmaps })`:**
  - `scale: 0.5` stores frames at half size, which is a quarter of the memory. Use about `0.6` on phones.
  - Keep mipmaps on: measured faster *and* sharper when sprites are drawn smaller than authored.
- **The canvas must be sized in device pixels** (e.g. `canvas.width = cssW * Math.min(devicePixelRatio, 2)`), and
  you multiply your world coordinates by that factor. The runtime clears the canvas each `render`, so put
  backgrounds behind it in the DOM (or on another canvas).
- **WASM URL:** defaults to `new URL('opal.wasm', import.meta.url)`; Vite, webpack 5, Rollup and esbuild handle it.
  Override with `createOpal(canvas, '/path/opal.wasm')`.

### Anchoring characters on the ground (important)
`spawn` and `set` position the **centre of the video cell**, not the feet. Use the clip's visible box:
```js
const c = asset.clips.idle, [bx, by, bw, bh] = c.box;        // visible box inside the cell (encoded px)
const k = targetHeightPx / bh;                                // scale that makes the character targetHeightPx tall
const feet = by + bh - c.height / 2;                          // feet relative to the cell centre
const cx = bx + bw / 2 - c.width / 2;                         // body centre relative to the cell centre
opal.set(id, (x - cx * k * facing) * S, (groundY - feet * k) * S, k * facing * S, 1);   // S = canvas px per world px
```
- **One anchor per character:** use the same one (from the idle clip) for all of a character's clips, since they
  share one canvas, so clip switches don't jump.
- **Effects:** centre on the box (`cy = by + bh/2 - c.height/2`).
- **Mirroring:** a negative scale mirrors around the cell centre, and the `cx * facing` term keeps the body in place.

### Timing gameplay to animation
- **Hit windows:** check `progress()` against the frames where the strike happens, e.g. `0.17 < p < 0.4`. Look at
  a contact sheet of the clip to find them.
- **Snappier actions:** generated actions are often 2 s long, so run them faster with
  `opal.speed(id, (clip.frames / asset.fps) / 0.6)` to make them 0.6 s.
- **Commit windows:** lock movement until about 40% progress, then allow canceling into the next action. That
  feels responsive.
- **Projectiles:** spawn them when the cast passes the palm-push frame (e.g. `progress > 0.3`).
- **One-shot effects:** `spawn` them, then kill them when `progress >= 1`. If a clip starts at its peak, pop it in
  with code (scale 0.55→1 over the first ~10%) and fade over the last third.
- **Afterimages:** spawn extra instances of the run clip at old positions with falling opacity. They're nearly free
  because they share the texture.

## PixiJS v8: `opal-sprites/pixi`
```js
import { Application } from 'pixi.js';
import { loadOpal } from 'opal-sprites/pixi';

const app = new Application(); await app.init({ resizeTo: window });
const hero = await loadOpal('/hero.opal', { scale: 1 });           // decodes with WebCodecs into trimmed textures

const s = hero.sprite('run', { anchor: hero.feetAnchor('run') });  // AnimatedSprite at the clip's fps, playing
s.position.set(400, 650); s.scale.x = -1;                          // feet on y=650, facing left
app.stage.addChild(s);

// switch clip: re-apply that clip's feet anchor and loop flag
s.textures = hero.clips.slash; s.anchor.copyFrom(hero.feetAnchor('slash')); s.loop = hero.loops('slash'); s.gotoAndPlay(0);
s.onComplete = () => { /* one-shot finished */ };
```
- **Textures:** each frame is a trimmed `Texture` whose `orig` is the full video cell (shared pages, so Pixi
  batches them). Clips of one character line up, filters work, and so on.
- **Sizing:** `hero.clips[name][0].frame.height` is the visible height in texture pixels. Scale = target height ÷
  that.
- **Frame rate:** `animationSpeed` is `fps / 60` (Pixi ticks at 60). `sprite()` sets it, so multiply it for faster
  actions.
- **Cleanup:** `hero.destroy()` frees the pages and textures.

### Whole game on Pixi: `createPixiOpal`
The same API as `createOpal` (`load`, `spawn`, `set`, `play`, `speed`, `progress`, `done`, `kill`, `render`), drawn by
Pixi:
```js
import { createPixiOpal } from 'opal-sprites/pixi';
const opal = await createPixiOpal(canvas);                       // owns a Pixi Application on that canvas
// or inside your own scene:
const opal = await createPixiOpal(canvas, { app, stage: worldContainer });   // then call opal.render(dt) every tick
```
Rift Warden runs unchanged this way (`/web/game2/?renderer=pixi`). The rule of thumb: use `createOpal` for raw
speed with huge crowds, and `createPixiOpal` or `loadOpal` when the project already uses Pixi's scene graph, filters
and UI.

## Other renderers: `decodeOpal` / `parseOpal`
```js
import { decodeOpal, parseOpal } from 'opal-sprites';
const { fps, pages, clips } = await decodeOpal('/fx.opal', { scale: 1, pageSize: 2048 });
// pages: HTMLCanvasElement[] (RGBA); clips.boom.frames[i] = { page, x, y, w, h }
// clip info: rect, origin (trim offset in the cell), src (cell size), loop, count
const info = parseOpal(arrayBuffer);   // header, clips, frame index (no decoding); throws on malformed files
```
For three.js, make a `CanvasTexture` per page and set UVs from the frame rect. For Canvas2D, `drawImage(page, x, y, w, h, …)`.

## Memory and performance budget
- **GPU memory:** about `atlas_w × atlas_h × 4 × frames × 4/3` (mipmaps). `load()` returns `vram`; check it.
- **Typical (desktop):** hero with 4 clips at 12 fps, about 66 MB; a 2-clip boss, about 52 MB; small loops, 1–9 MB.
  Keep the total under about 250 MB on desktop. On phones, load at `scale: 0.6` (about a third) and cap DPR at 1.5–2.
- **Encode at game size:** `--fps 12` and `--scale` matched to the on-screen size are the biggest wins.
- **Load time:** decoding is a one-time cost, about 100–200 ms per file. Load during a title screen.
- **Big sheets:** keep the coded frame ≤ 2048 px (the CLI warns), or split into several files.

## Browser support
WebCodecs (`VideoDecoder`) plus WebGL2:
- **Supported:** Chrome and Edge, Firefox desktop, and Safari 26+ (macOS and iOS).
- **Not supported:** Firefox for Android.
- **Secure context:** pages must be served over **https** or localhost; plain-http LAN IPs won't work. Test phones
  over https (e.g. GitHub Pages).
- **Fallback:** check `'VideoDecoder' in window` and show a message or static sprites.

## Troubleshooting
| Symptom | Fix |
|---|---|
| `WebCodecs unavailable` | serve over https or localhost; use a supported browser |
| Character floats or sinks, or jumps when clips switch | anchor by `box` feet with one shared anchor (see above); in Pixi, re-apply `feetAnchor(clip)` |
| Sprite drawn upside down when mirrored | use a negative **scale** (horizontal only); don't negate y |
| Green fringe | re-encode with a higher `--key-tol` (40–50) and `--despill 1`; check in player.html |
| Effect cut off flat at an edge | the source clip touched its frame border; regenerate with margin (see opal-video-sprites) |
| Huge memory | lower `--scale` and `--fps`; `load(url, { scale: 0.5 })` |
| Blurry when scaled up | encode at a larger `--scale`; keep mipmaps on |
| Nothing renders, no errors | `render(dt)` not called each frame, canvas has 0 size, or positions in CSS px instead of canvas px |
| Animation appears frozen | `dt` is 0 (paused loop) or `speed(id, 0)`; idle clips are subtle, so check a run |
| Bundler can't find opal.wasm | pass the URL explicitly: `createOpal(canvas, wasmUrl)` |

## Reference
- **Game examples:** `/web/game2/game.js` (Rift Warden: hit windows, projectiles, VFX, boss, afterimages,
  `?renderer=pixi`) and `/web/game/game.js` (Opal Dojo, a minimal game).
- **Format v2:** `"OPAL"`, then version, flags, atlas and coded sizes, fps, codec string, avcC, clips (name, first,
  count, loop, rect, origin, src), then the frame index and the AVCC frames. The Rust reader and writer are in
  `crates/opal-format`, and the JS reader is `parseOpal`.
