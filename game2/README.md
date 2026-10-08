# Rift Warden: how the assets were made

Every character, enemy, projectile, pickup and effect in `web/game2/` is an AI-generated video
with a transparent background, packed into `.opal` files. Built with the
[`opal-video-sprites`](../.claude/skills/opal-video-sprites/SKILL.md) skill. Total fal spend was about $3.30
across 3 rounds, about a third of it on rejected takes.

| File | Clips | Source |
|---|---|---|
| `warden.opal` | idle, run, slash, cast | `nano-banana-2` still → `minimax/h3-max/image-to-video`, pinned loops on a padded canvas |
| `skeleton.opal` | walk, attack, death | same; death pins only the first frame (it ends lying down) |
| `golem.opal` | idle, slam | same, on a padded canvas |
| `bat.opal` | fly | pinned loop; `sprite_qa loop` picked a 9-frame internal cycle (seam 1.13 vs 2.26 whole) |
| `fireball.opal`, `orb.opal`, `portal.opal` | loop | still of the effect → pinned loop ("stays in place, flames flicker") |
| `lightning.opal` | bolt | empty green frame pinned first and last |
| `fx.opal` | explosion, hit, shock | explosion: peak still → empty frame, trimmed to frames 0–13; hit and shock: single-frame stills animated in code |
| `bg.jpg` | | `nano-banana-2`, 16:9 |

## What went wrong, and the fixes (now in the skill)

1. **Edge clipping on characters.** The first takes had a long sword, a slash arc, a palm flash and a hurt streak
   crossing the right and top edges. *Fix:* pad the still before animating, the way sprite-gen's `video-canvas`
   does. Shrink the character to about 70% of a 1024² canvas, place it back and low, and composite onto a perfectly
   flat `#00FF00`. Key out the original backdrop first, because padding with a slightly different green leaves a seam
   the video model copies. On the padded canvas, idle, slash, cast and all skeleton and golem clips came back clean.
2. **Every clip of a character must share its canvas,** or the sizes and anchors won't match in game. The one
   exception: the run clip's model added dust that crossed the left edge, so it was regenerated on a canvas with the
   Warden centred (110 px further right). The game shifts that clip's anchor by the known offset.
3. **The model adds effects you said not to add.** The hurt clip got an incoming slash streak from the right in
   both takes. The clip was dropped; damage now uses knockback, a blink and a hit spark.
4. **Effects: the model zooms in on small subjects.** The hit-star and dust stills were small and centred, but the
   clips animated from them came back filling the frame. They're used as single-frame stills with code-driven pop,
   rise and fade. The explosion was usable for its first 14 frames (until spark rays reached the border).
5. **Some edges are meant to be touched.** `sprite_qa edges` now reports each side and takes `--allow`. The
   lightning touches only the top (the bolt comes from the sky, and its top is above the screen in game), so it
   passes with `--allow top,bottom`.
6. **Sparkles make a big trim box.** The orb's sparkles reach the frame edge, so its box is the whole frame. The
   game sizes the orb by its core instead.

## Encode commands
```sh
S=game2/src; D=web/game2/assets
opal encode -o $D/warden.opal --crf 24 --fps 12 --scale 0.6 --once slash --once cast \
  $S/warden_idle.mp4 --key auto --rect idle=0,0,768,768@0-35  $S/warden_run.mp4 --key auto --rect run=0,0,768,768@0-26 \
  $S/warden_slash.mp4 --key auto --rect slash=0,0,768,768@0-26  $S/warden_cast.mp4 --key auto --rect cast=0,0,768,768@0-26
opal encode -o $D/skeleton.opal --crf 24 --fps 12 --scale 0.55 --once attack --once death \
  $S/skel_walk.mp4 --key auto --rect walk=0,0,768,768@0-26  $S/skel_attack.mp4 --key auto --rect attack=0,0,768,768@0-26 \
  $S/skel_death.mp4 --key auto --rect death=0,0,768,768@0-26
opal encode -o $D/golem.opal --crf 24 --fps 10 --scale 0.8 --once slam \
  $S/golem_idle.mp4 --key auto --rect idle=0,0,768,768@0-28  $S/golem_slam.mp4 --key auto --rect slam=0,0,768,768@0-24
opal encode -o $D/bat.opal --crf 24 --fps 12 --scale 0.32 $S/bat_fly.mp4 --key auto --rect fly=0,0,768,768@12-20
opal encode -o $D/fireball.opal --crf 24 --fps 12 --scale 0.4 $S/fireball_loop.mp4 --key auto --rect loop=0,0,768,768@0-26
opal encode -o $D/orb.opal --crf 24 --fps 12 --scale 0.3 $S/orb_loop.mp4 --key auto --rect loop=0,0,768,768@0-26
opal encode -o $D/portal.opal --crf 24 --fps 12 --scale 0.58 $S/portal_loop.mp4 --key auto --rect loop=0,0,768,768@0-35
opal encode -o $D/lightning.opal --crf 24 --fps 12 --scale 0.7 --once bolt $S/fx_lightning.mp4 --key auto --rect bolt=0,0,768,768@0-23
opal encode -o $D/fx.opal --crf 24 --fps 24 --scale 0.5 --once explosion --once hit --once shock \
  $S/fx_explosion.mp4 --key auto --rect explosion=0,0,768,768@0-13 \
  $S/peak_hit.png --key auto --rect hit=0,0,1024,1024  $S/peak_shock.png --key auto --rect shock=0,0,1024,1024
```
Rejected takes are kept locally in `src/v1/` (gitignored, 33 MB). GPU memory for everything is about 190 MB on desktop and about 70 MB
on phones (loaded at 60% scale).
