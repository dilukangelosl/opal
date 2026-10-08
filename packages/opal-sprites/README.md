# opal-sprites

Transparent **video** sprites for web games. Characters, enemies and effects come from AI or
green-screen video, packed into tiny `.opal` files. Play them with Opal's own ~15 KB WebGL2 runtime,
or as regular **PixiJS** textures.

- **[Live demo: Rift Warden](https://dilukangelosl.github.io/opal/web/game2/)**, where every character and effect is a video sprite
- **[PixiJS demo](https://dilukangelosl.github.io/opal/web/pixi/)**
- Make `.opal` files with [Opal Studio](https://dilukangelosl.github.io/opal/web/studio/) in the browser, or the `opal` CLI ([repo](https://github.com/dilukangelosl/opal))

```sh
npm i opal-sprites
```

## PixiJS (v8)
```js
import { Application } from 'pixi.js';
import { loadOpal } from 'opal-sprites/pixi';

const app = new Application(); await app.init({ resizeTo: window });
const hero = await loadOpal('/assets/warden.opal');   // decoded once with the hardware video decoder

const sprite = hero.sprite('run', { anchor: hero.feetAnchor('run') });   // an AnimatedSprite, playing
sprite.position.set(400, 650);
sprite.scale.x = -1;                                   // face left
app.stage.addChild(sprite);

sprite.textures = hero.clips.slash;                    // switch clip; it stays anchored
sprite.loop = hero.loops('slash');
sprite.gotoAndPlay(0);
```
Each frame is a trimmed `Texture` on a few shared pages, with `orig` set to the full video cell, so every clip
of a character shares one anchor point and Pixi batches them. `loadOpal(src, { scale: 0.5 })` keeps frames at
half size (a quarter of the memory), which suits phones.

### Port a whole game to Pixi in one line
`createPixiOpal` has exactly the same API as Opal's runtime (`load`, `spawn`, `set`, `play`, `speed`, `progress`,
`done`, `kill`, `render`). [Rift Warden](https://dilukangelosl.github.io/opal/web/game2/?renderer=pixi) runs
unchanged on Pixi this way:
```js
import { createPixiOpal } from 'opal-sprites/pixi';
const opal = await createPixiOpal(canvas);            // instead of createOpal(canvas)
// or draw into your own scene: createPixiOpal(canvas, { app, stage: myContainer })
```

## Opal runtime (fastest)
Opal's own renderer keeps every frame in one GPU texture array and draws each file with a single instanced call.
That's 300+ animated video sprites at 120 fps.
```js
import { createOpal } from 'opal-sprites';

const opal = await createOpal(canvas);
const hero = await opal.load('/assets/warden.opal', { scale: isMobile ? 0.6 : 1 });
const id = opal.spawn(hero, 'idle', x, y, scale);      // negative scale mirrors
opal.play(hero, id, 'slash'); opal.speed(id, 2);
if (opal.progress(id) > 0.2 && opal.progress(id) < 0.4) hitTest();
// every frame:
opal.render(dt);
```
Bundlers: the runtime loads `opal.wasm` with `new URL('opal.wasm', import.meta.url)`, which Vite, webpack 5,
Rollup and esbuild handle out of the box. Or pass your own URL: `createOpal(canvas, '/opal.wasm')`.

## Any other renderer
```js
import { decodeOpal, parseOpal } from 'opal-sprites';
const { fps, pages, clips } = await decodeOpal('/fx.opal');
// pages: canvases with RGBA frames; clips.explosion.frames[i] = { page, x, y, w, h }
```

## Requirements
WebCodecs: Chrome/Edge, Firefox desktop, Safari 26+, served over https or localhost. `.opal` files are plain H.264
plus an alpha plane, so every one of those browsers decodes them in hardware.

MIT
