#!/usr/bin/env python3
"""QA for generated sprite clips before they go into `opal encode`. Stdlib only; needs ffmpeg.

  sprite_qa.py edges clip.mp4             content touching the frame border? (clipped effect/limb)
  sprite_qa.py loop  clip.mp4 --fps 12    best seamless loop range, vs. using the whole clip

`edges` exits 1 when any frame has non-backdrop pixels on its border: that clip is cut off and
must be regenerated (smaller subject, wider margin, or a pinned empty first/last frame).
`--allow top,bottom` ignores sides the game hides anyway (a bolt from the sky, a ground burst);
the report always says which sides were touched.
`loop` prints an `--rect ...@a-b` frame range to paste into `opal encode`.
"""
import argparse, subprocess, sys

def frames(path, fps=None, width=160):
    vf = (f"fps={fps}," if fps else "") + f"scale={width}:-2"
    probe = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vf", vf, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                           capture_output=True, check=True).stdout
    h = len(probe) // (width * 3)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout
    n = width * h * 3
    return [raw[i:i + n] for i in range(0, len(raw) - n + 1, n)], width, h

def edges(args):
    fr, w, h = frames(args.clip)
    first = fr[0]
    # backdrop = median of the first frame's border (pinned clips start on the empty backdrop or the still)
    ring = [(x, y) for x in range(w) for y in (0, h - 1)] + [(x, y) for y in range(h) for x in (0, w - 1)]
    px = lambda f, x, y: f[(y * w + x) * 3:(y * w + x) * 3 + 3]
    key = [sorted(px(first, x, y)[c] for x, y in ring)[len(ring) // 2] for c in range(3)]
    b_ = args.band
    sides = {"top": [(x, y) for x in range(w) for y in range(b_)], "bottom": [(x, y) for x in range(w) for y in range(h - b_, h)],
             "left": [(x, y) for y in range(h) for x in range(b_)], "right": [(x, y) for y in range(h) for x in range(w - b_, w)]}
    allow = {s.strip() for s in args.allow.split(",") if s.strip()}
    bad, touched = [], {k: 0 for k in sides}
    for i, f in enumerate(fr):
        worst = 0
        for name, band in sides.items():
            hits = sum(1 for x, y in band if sum((a - b) ** 2 for a, b in zip(px(f, x, y), key)) > args.dist ** 2)
            if hits / len(band) > args.max_frac:
                touched[name] += 1
                if name not in allow:
                    worst = max(worst, hits / len(band))
        if worst:
            bad.append((i, worst))
    print(f"{args.clip}: backdrop #{''.join(f'{v:02x}' for v in key)}, {len(fr)} frames")
    print("  sides touched (frames): " + ", ".join(f"{k} {v}" + (" (allowed)" if k in allow else "") for k, v in touched.items() if v) if any(touched.values()) else "  sides touched: none")
    if bad:
        worst = max(bad, key=lambda b: b[1])
        print(f"  FAIL: content touches the border in {len(bad)} frames (first {bad[0][0]}, worst {worst[0]}: {worst[1]:.1%} of the edge)")
        runs, start = [], bad[0][0]
        for (a_, _), (b_, _) in zip(bad, bad[1:] + [(None, 0)]):
            if b_ != a_ + 1:
                runs.append(f"{start}-{a_}" if a_ != start else f"{start}"); start = b_
        print(f"  frames (at the clip's own fps): {', '.join(runs)}")
        return 1
    print("  ok: nothing touches the border")
    return 0

def loop(args):
    fr, w, h = frames(args.clip, args.fps, 48)
    n = len(fr)
    g = [bytes(sum(f[i:i + 3]) // 3 for i in range(0, len(f), 3)) for f in fr]
    d = lambda a, b: sum(abs(x - y) for x, y in zip(g[a], g[b])) / len(g[0])
    vel = [d(k, k + 1) for k in range(n - 1)] + [0]
    best = None
    for i in range(n):
        for j in range(i + args.min, n):
            c = d(i, j) + 0.5 * (d(i + 1, j + 1) if j + 1 < n else d(i, j)) + 2 * abs(vel[i] - vel[j - 1])
            if best is None or c < best[0]:
                best = (c, i, j)
    whole = d(0, n - 1)
    print(f"{args.clip}: {n} frames @ {args.fps} fps")
    print(f"  whole clip seam cost {whole:.2f}  -> use @0-{n - 2} (drop the duplicated last frame)")
    if best:
        print(f"  best internal loop cost {best[0]:.2f} -> @{best[1]}-{best[2] - 1} ({best[2] - best[1]} frames)")
        print(f"  pick: {'whole clip' if whole <= best[0] else 'internal loop'}")
    return 0

p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
sub = p.add_subparsers(dest="cmd", required=True)
e = sub.add_parser("edges"); e.add_argument("clip"); e.add_argument("--band", type=int, default=2)
e.add_argument("--dist", type=float, default=90, help="RGB distance from the backdrop that counts as content")
e.add_argument("--max-frac", type=float, default=0.004, help="tolerated share of edge pixels (codec noise)")
e.add_argument("--allow", default="", help="comma list of sides allowed to touch: top,bottom,left,right")
l = sub.add_parser("loop"); l.add_argument("clip"); l.add_argument("--fps", type=float, default=12); l.add_argument("--min", type=int, default=8)
a = p.parse_args()
sys.exit(edges(a) if a.cmd == "edges" else loop(a))
