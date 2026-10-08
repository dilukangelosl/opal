---
name: opal-video-sprites
description: Generate game-ready transparent video sprites (characters, enemies, VFX) with the fal MCP and pack them into .opal files for the Opal runtime. Covers the stills, image-to-video with pinned loops, VFX on empty pinned frames, automatic QA (border clipping, loop seams), keying and encoding with the opal CLI, and using the clips in a game. Use when the user wants AI-generated sprites, animations, effects or a game built on Opal, or asks to (re)generate a character, enemy or effect video.
---

# Opal video sprites

The goal is AI video that drops into a game as a clean, looping, transparent sprite: nothing clipped,
no green fringe, small files. Every rule below fixes a failure seen in practice. The pipeline
follows [sprite-gen](https://github.com/aldegad/sprite-gen)'s video approach, adapted for fal + Opal.

```
still (#00FF00) ─▶ image-to-video (first = last frame) ─▶ QA: edges + loop ─▶ opal encode --key ─▶ player.html ─▶ game
VFX: empty #00FF00 frame as first AND last ─▶ QA: edges → trim to the clean range ─▶ opal encode ─▶ pop-in in code
```

## 0. fal hygiene (money)
- Ask `recommend_model` for each operation unless the user named a model; read `get_model_schema`; check
  `get_pricing` before spending. Pass the `decision_id` along.
- Known-good picks (Oct 2026; re-verify, since catalogs change):
  - **Stills:** `fal-ai/nano-banana-2`, $0.08 per image.
  - **Clips:** `minimax/h3-max/image-to-video`, $0.03/s. It takes `image_url` + `end_image_url`, 768P, up to 15 s.
- Submit independent jobs together with `submit_jobs`, then `wait_for_jobs`.
- **If a submit times out, do NOT resubmit.** Check `search_request_history` first; the jobs usually
  ran and finished.
- Expect a full character (idle, run, attack) plus an enemy and a VFX to cost about $0.50–1.00.

## 0b. Plan the asset list and budget first
Write the list before spending anything. One row per clip: subject, method, seconds, loop or one-shot. The Rift
Warden list, which worked, as a template:

| Asset | Method | Clips (s) |
|---|---|---|
| Hero | padded still → pinned loops | idle 3, run 2, slash 2, cast 2 (hurt: skip, do it in code) |
| Grunt enemy | padded still → pinned loops | walk 2, attack 2, death 2 (death: pin the **first frame only**, since it ends lying down) |
| Flyer | still → pinned loop | fly 2 (the loop finder may pick a short internal cycle) |
| Boss | padded still → pinned loops | idle 3, slam 2.5 (no walk: move it through portals/teleports in code) |
| Projectile, pickup, portal | still of the effect → pinned loop | 2–3 each |
| Explosion | peak still → empty frame | 2, trim |
| Lightning / beam | empty frame → empty frame | 2, `--allow` the side it comes from |
| Hit spark, dust puff | single still, animated in code | none |

**Reality check on cost:** roughly a third of the generations were rejected (edge clipping, extra effects). Budget about
1.5× the clip seconds. Rift Warden was 8 + 3 stills and about 33 s of accepted video for about $3.30 in total.

**GPU memory budget** (desktop, with mips). Plan scales and fps so the total stays under about 250 MB, and load at
`scale: 0.6` on phones (about 1/3):

| File | Encode | GPU |
|---|---|---|
| Hero, 4 clips at 12 fps | `--scale 0.6` | 66 MB (a wide slash arc enlarges the atlas) |
| Boss, 2 clips | `--fps 10 --scale 0.8` | 52 MB |
| Grunt, 3 clips | `--scale 0.55` | 30 MB |
| Lightning | `--scale 0.7` | 17 MB |
| Small loops (fireball, orb, portal, bat) | `--scale 0.3–0.6` | 1–9 MB each |

## 1. Stills (one per character)
Prompt template (edit the subject line):
> 2D side-scrolling action game character sprite, full body, seen from the exact side facing right.
> {subject: outfit, colors, what it holds, stance}. Clean hand-painted anime game art with crisp dark outlines and
> flat cel shading. The character is centered and occupies about 50–55% of the image height, with wide empty
> margins on all sides (especially in front for weapon swings). The entire background is one perfectly flat,
> uniform pure green chroma-key fill (#00FF00) with no gradient, no shadow, no ground line, no floor, no texture.
> No green anywhere on the character.

- `aspect_ratio: "1:1"`, `resolution: "1K"`. Always face **right**: the runtime mirrors with a negative scale.
- **No green on the character.** Green clothing, eyes or glows get keyed out. If the art needs green, use a
  magenta backdrop (`#FF00FF`) and say "No magenta anywhere".
- Backgrounds: same model, `16:9`, `2K`; ask for an empty, flat floor band ("bottom 22%") for characters to stand on.
- Look at every still before animating it. A bad still makes every clip from it bad.

## 1b. Pad the still before animating (do this for every character)
Swords, arcs, palm flashes and capes reach past a still that already fills the frame. Like sprite-gen's
`video-canvas`, shrink the character to about 70% of a 1024² canvas and place it back and low, so there's room
in front and above. **Key out the original green first**, then composite onto a perfectly flat `#00FF00`. Padding
with a slightly different green leaves a seam that the video model copies.
```sh
bg=$(ffmpeg -v error -i hero.png -vf "crop=8:8:0:0,scale=1:1" -f rawvideo -pix_fmt rgb24 - | od -An -tx1 | tr -d ' \n')
ffmpeg -f lavfi -i color=c=0x00FF00:s=1024x1024 -i hero.png \
  -filter_complex "[1]scale=716:716,colorkey=0x$bg:0.28:0.06[k];[0][k]overlay=70:230" -frames:v 1 hero_pad.png
```
- **All clips of one character use the same canvas,** so sizes and anchors match. If one clip needs a different
  placement (for example, a run whose trailing dust needs room behind), the game shifts that clip's anchor by the
  known offset: `(dx / 1024) * clip.width`.
- Upload local stills with `upload_file` (`prepare_upload`, then `curl --upload-file` to the signed URL), and check
  the CDN URL returns the same byte count before using it.

## 2. Character clips: pinned loops
`minimax/h3-max/image-to-video` with **`image_url` = `end_image_url` = the still**, `prompt_expansion_mode: "disabled"`,
`resolution: "768P"`. Pinning both ends to the same frame makes the clip close on itself (measured:
seam cost 0.5–1.2, better than any loop found inside the clip).

Base prompt (append after the motion sentence):
> Seen from the exact side, facing right. Stays centered in the frame; the body always stays fully inside the
> frame with margin. Camera completely locked, no zoom, no pan, no reframing. The background stays a perfectly
> flat, pure green chroma-key fill for the whole clip — no shadows, no ground line, no dust, no particles, no
> effects. Keep the design, colors and proportions exactly as in the image. The last frame returns to the exact
> pose of the first frame, so the animation loops seamlessly.

| State | Duration | Motion sentence |
|---|---|---|
| idle | 3 s | stands in a relaxed ready pose with both feet planted flat for the whole clip: slow gentle breathing in chest and shoulders, cloth sways gently. The feet never lift, step, shuffle or slide — no walking, no turning. |
| walk / run | 2 s | walks / runs naturally in place, as if on a treadmill, without moving across the screen: {gait details}, at an even rhythm. |
| attack | 2 s | performs one fast {weapon} strike in place: quick windup (~0.4 s), one clean strike in front (~0.2 s), held follow-through (~0.3 s), then recovery to the exact starting stance. Feet stay planted. *(Replace "no effects" with "no trails" if you don't want a baked swoosh, which can clip the frame; see §4.)* |
| hit / hurt | 1.5 s | flinches back from a blow, then recovers to the exact starting stance. |

## 3. VFX clips (smoke, explosions, magic): an empty pinned frame
VFX have no still, and plain text-to-video renders 16:9 and fills the frame, so effects get **cut off at the
border**. Instead:
1. Make an empty square frame: `ffmpeg -f lavfi -i color=c=0x00FF00:s=768x768 -frames:v 1 green768.png`.
   Upload it (`upload_file` with `prepare_upload`, `curl --upload-file` to the signed URL, then `verify_upload`).
2. Use it as **both** `image_url` and `end_image_url`. That gives a square canvas, and the clip starts and ends empty.
3. Prompt: the effect appears at the exact center, "about 35% of the frame width", "all of it stays within the
   central 50% of the frame; the outer 25% on every side stays empty green the whole time", "no flash rays, no
   sparks, no lines, no debris, nothing flies or drops in", then it fades "until the frame is completely empty".
4. **Expect an intro anyway.** H3 Max kept adding a streak or bomb dropping in from the top edge and sparks at
   the burst, in 4 of 4 tries. Don't keep paying for rerolls: run QA (§4), keep the clean range, and do the
   pop-in in code (scale 0.45→1 over the first 10% of the clip, fade over the last 25%).

### 3b. Effects, round two (Rift Warden)
- **The model zooms in on small effect stills.** A small, centred hit star or dust arc pinned as the first frame
  came back filling the whole frame. Characters keep their scale; effects don't. Good alternatives:
  - **Peak still → empty frame:** pin the effect at its peak as the *first* frame and the empty green as the *last*.
    The clip then only dissipates. The explosion worked this way for its first 14 frames; trim the rest with `edges`.
  - **Single-frame sprite:** encode the clean still (`opal encode … still.png`) and animate pop, rise and fade in
    code. That's ideal for hit sparks and ground puffs that last under half a second.
- **Looping effects** (fireball, orb, portal): still → pinned loop with "stays in exactly the same place, flames
  flicker". These kept their scale and passed `edges`.
- **Directional effects legitimately touch an edge:** a bolt from the sky touches the top, and a ground burst the
  bottom. Use `sprite_qa edges --allow top,bottom` and place the hidden side off-screen or under the floor.
- **The model adds effects you said not to add.** The hurt/flinch clip got an incoming slash streak in both takes.
  If a clip keeps failing, drop it and do the feedback in code (knockback, blink, a hit spark).

## 4. QA: never encode without it
```sh
python3 tools/sprite_qa.py edges clip.mp4          # exit 1 + failing frame ranges + which sides were touched
python3 tools/sprite_qa.py edges bolt.mp4 --allow top,bottom   # sides the game hides anyway
python3 tools/sprite_qa.py loop  clip.mp4 --fps 12  # whole clip vs best internal loop, as an @from-to range
ffmpeg -i clip.mp4 -vf "fps=4,scale=200:-1,tile=8x1" -frames:v 1 sheet.png   # look at it
```
- **edges fails:** the subject is clipped by the frame. Either trim to a clean range
  (`ffmpeg -ss <sec> -i clip.mp4 -c:v libx264 -crf 12 -an trimmed.mp4`, then re-run `edges`) or regenerate with
  a smaller subject and wider margins. A clipped clip shows as hard straight cut-offs in the game.
- **loop:** with pinned clips the whole clip usually wins. Use `@0-(n-2)` to drop the duplicated last frame.
- Look at the contact sheet: identity drift, extra limbs, held objects disappearing, the character walking off-center.

## 5. Encode
```sh
opal encode -o hero.opal --crf 24 --fps 12 --scale 0.5 --once attack \
  idle.mp4   --key auto --rect idle=0,0,768,768@0-35 \
  run.mp4    --key auto --rect run=0,0,768,768@0-26 \
  attack.mp4 --key auto --rect attack=0,0,768,768@0-26
```
- **`--fps 12 --scale ~0.5`:** generated 768p at 24 fps is about 10× the GPU memory a game sprite needs. Pick the
  scale from the on-screen size (sprite height in the game ÷ character height in the clip). `@from-to` counts *output* frames.
- **`--key auto`:** samples the frame border. If the subject reaches the border (big VFX), auto-detect can pick
  the subject's own color as a key. Pass the backdrop color explicitly (`--key "#00ec01"`; `sprite_qa edges`
  prints it).
- The keyer separates soft pixels (smoke, blur, glows, sword trails) from the green and strips the green tint.
  If edges keep a fringe, raise `--key-tol` (40–50). If real colors near the key wash out, lower `--despill`.
- Check every file: `web/player.html` (drop the `.opal` in; use the light background to spot fringes).

## 6. In the game (Opal runtime)
```js
const a = await opal.load('hero.opal', { scale: mobile ? 0.6 : 1 });   // 0.6 ≈ 1/3 of the GPU memory
const c = a.clips.idle, [bx, by, bw, bh] = c.box;                     // visible box inside the cell
const k = HERO_H / bh;                                                // scale for the on-screen height
const feet = by + bh - c.height / 2, cx = bx + bw / 2 - c.width / 2;  // anchors relative to the cell center
opal.set(id, x - cx * k * facing, groundY - feet * k, k * facing);    // facing = ±1: negative scale mirrors horizontally
opal.speed(id, (a.clips.attack.frames / a.fps) / 0.7);               // play a generated 2 s slash in 0.7 s
if (opal.progress(id) > 0.06 && opal.progress(id) < 0.34) hitTest(); // hit window by clip progress
```
- Use one anchor (the idle clip's) for all clips of a character, since they share a canvas. Load order is draw order.
- One-shots (`--once`): `opal.done(id)` tells you when to switch back; kill finished VFX instances.

## 6b. PixiJS (npm `opal-sprites`)
```js
import { loadOpal } from 'opal-sprites/pixi';          // Pixi v8
const hero = await loadOpal('warden.opal', { scale: mobile ? 0.6 : 1 });
const s = hero.sprite('idle', { anchor: hero.feetAnchor('idle') }); // AnimatedSprite at the clip's fps
s.scale.x = -1;                                          // face left
s.textures = hero.clips.run; s.anchor.set(...Object.values(hero.feetAnchor('run'))); s.loop = hero.loops('run'); s.gotoAndPlay(0);
```
- **Whole games:** `createPixiOpal(canvas)` has the same API as `createOpal`, so a game written for Opal runs on
  Pixi by swapping that one line (Rift Warden: `?renderer=pixi`). Use `{ app, stage }` to draw into an existing scene.
- Frames are trimmed textures whose `orig` is the whole video cell, so clips of one character line up. Re-apply
  `feetAnchor(clip)` when switching clips, because each clip has its own visible box.
- Clips generated on a *different* padded canvas (the shifted run) need the same x correction as in §1b.
- Opal's own runtime is faster for crowds (texture arrays, one draw per file). Pixi suits scenes that already use
  Pixi containers, filters and UI.
- **Demos must move.** An idle clip is subtle, so a character standing still and breathing reads as "not animated".
  Show a run that crosses the screen, actions and projectiles.

## Failure modes seen so far
| Symptom | Cause | Fix |
|---|---|---|
| Effect cut off flat at the edges | text-to-video fills a 16:9 frame | §3: empty pinned square frame, small and centered, trim with `edges` |
| Smoke keyed away / holes | auto-detect took smoke grey as a key (smoke touched the border) | explicit `--key`, and fix the clipping |
| Green halo on soft edges / trails | edge pixels mixed with the backdrop | the keyer decontaminates; raise `--key-tol` if needed |
| Sprite upside down when facing left | (old runtime) negative scale flipped both axes | fixed: negative scale mirrors horizontally only |
| Loop pops | unpinned clip | pin `end_image_url` = still; `sprite_qa loop` |
| Huge GPU memory | 768p at 24 fps encoded as-is | `--fps 12 --scale` |
| Character's green parts vanish | green in the art | magenta backdrop, or recolor |
| Sword, cape or arc crosses the frame edge | the still fills the frame | §1b: pad the still to ~70%, character back and low |
| Visible seam or box around the padded character | padded with a different green | key the original backdrop out, then composite onto flat #00FF00 |
| A small effect fills the frame in the clip | the model zooms in on small subjects | peak-still → empty-frame clip, trimmed; or a single-frame sprite animated in code |
| Effect sprite renders tiny | sparkles stretch its trim box to the whole frame | size it by its core (a fraction of `clip.width`), not by `box` |
| Unwanted streaks or flashes in hurt clips | the model adds them anyway | drop the clip; knockback + blink + hit spark in code |
| Run clip gets dust puffs behind the feet that cross the edge | the model adds ground dust even when told "no dust" | regenerate on a canvas with more room behind, and shift the anchor in code (`(dx/1024)*clip.width`) |
| A wave of stills/clips seems lost after a tool timeout | the submit timed out but the jobs ran | `search_request_history` before resubmitting, never blind retries |
| Boss has no walk cycle | a walk cycle for a huge creature is costly and often slides | idle + attack only; reposition through portals, teleports or a cutaway |
| Big action clips (roar, breath) clip at the edge: wings or fire reach the frame | the model lunges and spreads wings and pushes in on big moves, even when told "camera locked" | keep it, fade the border: `feather.sh` (alpha-merge a ramp mask toward the backdrop), and pin first and last frame to the idle still so it cuts in and out seamlessly |
| Effect isn't attached to the character (fire jet off the mouth, wrong timing) | separate effect sprite placed by guesswork | bake it in: generate "breathes fire to the right" on a wide 16:9 canvas with the character at the left, then measure the fire front per frame to time gameplay (cells ignite as the front passes) |
| GPU memory far bigger than the clips | an `.opal` file's frame layers are as large as its largest clip, in each dimension | one file per size class (wide breath, tall pillar, square symbols); no mixing |

## 7. Lessons from a slot game built from video
- **UI chrome can be video too.** Generate a board frame still (inside and outside flat green), animate it pinned,
  and measure the opening (measure it from a frame of the clip: measure vertical extents *away* from
  the centre, because crests hang into the opening there). Size the grid to the opening and draw the frame
  **after** the symbols (load order = draw order): it masks symbols as they tumble in and out. Fade symbols out
  past the opening's top and bottom too.
- **Stretch the still, not the grid.** A generated frame's opening never matches your grid ratio; scale the still
  non-uniformly (about 1.2×) before animating, then use slightly non-square cells for the rest.
- **1080P for big on-screen pieces** (`resolution: "1080P"` on h3-max): the hero character, frame and logo. 768P for
  symbols and effects. Then encode at the on-screen size.
- **Desync identical loops.** Twenty rubies spawned together shimmer in lockstep. The runtime has no seek, so
  fast-forward each new sprite once: for one frame set `speed = randomOffsetSeconds / dt`, then reset it to 1.
- **Logos with text work** on nano-banana-2 (21:9, 2K). Animate them pinned ("shine sweeps across, wings lift a little").
- **Anticipation / win-frame / pillar loops are cheap and sell the game.** Fire frames around winning cells, fire
  pillars over teasing columns, an eruption for feature triggers: each is a still plus a 2 s pinned loop.
- zsh: `"color=0x$bg:s=768x768"` hits zsh's `:s` modifier. Write `${bg}`.
