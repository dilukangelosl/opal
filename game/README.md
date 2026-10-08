# Opal Dojo: how the assets were made

Every character and effect in `web/game/` is a transparent video sprite generated with fal
and packed with the `opal` CLI. Approach: [sprite-gen](https://github.com/aldegad/sprite-gen)'s video
pipeline (still on #00FF00 → image-to-video with a locked camera, the character in place
"as if on a treadmill", a flat backdrop, and the end frame pinned to the start frame so the loop closes).

| Asset | Model | Notes |
|---|---|---|
| `src/hero.png`, `src/imp.png` | `fal-ai/nano-banana-2` | Side view facing right, full body, ~55% of the frame height, on a flat `#00FF00` background |
| `src/bg.png` | `fal-ai/nano-banana-2` | 16:9 night dojo courtyard with an empty stone floor in the bottom 22% |
| `src/hero_{idle,run,attack}.mp4`, `src/imp_walk.mp4` | `minimax/h3-max/image-to-video` | `image_url` = `end_image_url` = the still (a pinned loop), 2–3 s, 768P, prompt expansion off |
| `src/smoke_d.mp4` → `smoke_d_trim.mp4` | `minimax/h3-max/image-to-video` | First and last frame = an empty 768² `#00FF00` frame (square canvas, starts and ends empty). The model still adds a drop-in and sparks that touch the border, so the clip is trimmed from 0.75 s, where `tools/sprite_qa.py edges` passes, and the game does the pop-in. `smoke.mp4` (text-to-video) was the clipped first attempt. |

Total generation cost was about $0.85, including three smoke retries.

Each pinned clip's first and last frames already matched (seam cost 0.5–1.2 vs ≥0.65 for any
internal loop), so each clip is used whole, minus its duplicated last frame:

```sh
opal encode -o web/game/assets/hero.opal --crf 24 --fps 12 --scale 0.5 --once attack \
  game/src/hero_idle.mp4   --key auto --rect idle=0,0,768,768@0-35 \
  game/src/hero_run.mp4    --key auto --rect run=0,0,768,768@0-26 \
  game/src/hero_attack.mp4 --key auto --rect attack=0,0,768,768@0-26
opal encode -o web/game/assets/imp.opal --fps 12 --scale 0.32 game/src/imp_walk.mp4 --key auto --rect walk=0,0,768,768@0-26
ffmpeg -ss 0.75 -i game/src/smoke_d.mp4 -c:v libx264 -crf 12 -an game/src/smoke_d_trim.mp4
python3 tools/sprite_qa.py edges game/src/smoke_d_trim.mp4     # must pass
opal encode -o web/game/assets/smoke.opal --fps 12 --scale 0.42 --once burst game/src/smoke_d_trim.mp4 --key auto --rect burst=0,0,768,768
```

Sizes: hero 658 KB, imp 89 KB, smoke 149 KB.

The full repeatable process is a Claude Code skill: [`.claude/skills/opal-video-sprites`](../.claude/skills/opal-video-sprites/SKILL.md).

Measured in Chrome on an M-series Mac: 304 video sprites at 120 fps (vsync-capped). A simulated phone
(6× CPU slowdown) runs 104 sprites at 120 fps; GPU slowdown isn't simulated, so real phones still need testing.
