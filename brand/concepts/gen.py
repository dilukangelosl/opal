# Builds Opal concept marks as exact geometry (viewBox 256, black on white).
import math, os, sys
out = sys.argv[1]
f = lambda v: f"{v:.2f}".rstrip("0").rstrip(".")
def svg(w, h, body): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}"><path fill="#000" fill-rule="evenodd" d="{body}"/></svg>\n'
def ring(cx, cy, R, r):
    c = lambda q: f"M{f(cx-q)},{f(cy)}a{f(q)},{f(q)} 0 1 0 {f(2*q)},0a{f(q)},{f(q)} 0 1 0 {f(-2*q)},0Z"
    return c(R) + c(r)
def rect(x, y, w, h): return f"M{f(x)},{f(y)}h{f(w)}v{f(h)}h{f(-w)}Z"

# A — Stacked O: solid top half-ring over an outlined bottom half-ring (color over alpha).
R, r, gap, s = 100, 58, 14, 15
yt, yb = 128 - gap / 2, 128 + gap / 2
top = f"M{f(128-R)},{f(yt)}A{R},{R} 0 0 1 {f(128+R)},{f(yt)}H{f(128+r)}A{r},{r} 0 0 0 {f(128-r)},{f(yt)}Z"
bo = f"M{f(128-R)},{f(yb)}A{R},{R} 0 0 0 {f(128+R)},{f(yb)}H{f(128+r)}A{r},{r} 0 0 1 {f(128-r)},{f(yb)}Z"
Ri, ri, yi = R - s, r + s, yb + s  # inset hole
xo, xi = math.sqrt(Ri**2 - s**2), math.sqrt(ri**2 - s**2)
bi = f"M{f(128-xo)},{f(yi)}A{Ri},{Ri} 0 0 0 {f(128+xo)},{f(yi)}H{f(128+xi)}A{ri},{ri} 0 0 1 {f(128-xi)},{f(yi)}Z"
A = top + bo + bi

# B — Two frames: two rounded diamonds; where they overlap is solid (the visible pixel).
def rrect(x, y, w, h, rad):
    return (f"M{f(x+rad)},{f(y)}H{f(x+w-rad)}A{rad},{rad} 0 0 1 {f(x+w)},{f(y+rad)}V{f(y+h-rad)}"
            f"A{rad},{rad} 0 0 1 {f(x+w-rad)},{f(y+h)}H{f(x+rad)}A{rad},{rad} 0 0 1 {f(x)},{f(y+h-rad)}V{f(y+rad)}A{rad},{rad} 0 0 1 {f(x+rad)},{f(y)}Z")
side, o, rad, st = 124, 52, 30, 16
x1 = y1 = (256 - side - o) / 2 ; x2 = y2 = x1 + o
frame = lambda x, y: rrect(x, y, side, side, rad) + rrect(x + st, y + st, side - 2*st, side - 2*st, rad - st)
lens = (f"M{f(x2+rad)},{f(y2)}H{f(x1+side)}V{f(y1+side-rad)}A{rad},{rad} 0 0 1 {f(x1+side-rad)},{f(y1+side)}"
        f"H{f(x2)}V{f(y2+rad)}A{rad},{rad} 0 0 1 {f(x2+rad)},{f(y2)}Z")
# rotate 45° around centre, baked into coordinates via a group-free transform attribute
B_parts = [frame(x1, y1), frame(x2, y2), lens]

# C — Alpha edge: the O as a solid disc whose right side resolves into a checker of
# transparency pixels (density 100% -> 50% -> 25%). Grid unit 24 = 1/10.7 of the mark.
cx, cy, R, u = 128, 128, 100, 24
cut = 132  # solid part ends here; pixel columns start on a grid line
dy = math.sqrt(R**2 - (cut - cx) ** 2)
C = f"M{f(cut)},{f(cy-dy)}A{R},{R} 0 1 0 {f(cut)},{f(cy+dy)}Z"
rows = 9
y0 = cy - rows * u / 2
for col in range(4):
    for row in range(rows):
        x, y = cut + col * u, y0 + row * u
        mx, my = x + u / 2, y + u / 2
        inside = (mx - cx) ** 2 + (my - cy) ** 2 <= (R - 4) ** 2
        on = [(row + col) % 2 == 0, (row + col) % 2 == 0, (row + col) % 2 == 0 and row % 4 in (1, 3), (row + col) % 2 == 0 and row % 4 == 3][col]
        if inside and on:
            C += rect(x, y, u, u)

# Wordmark "opal": geometric, built from rings and bars (no live text). Units: x-height 112, stroke 26.
s2, Ro, Ri2, base, xh = 26, 56, 30, 200, 88
cyw = base - Ro
def word(x):
    # rings (evenodd) and stems (separate paths) so overlaps union instead of XOR-ing into notches
    rings, stems = "", ""
    rings += ring(x + Ro, cyw, Ro, Ri2); x += 2 * Ro + 22                                  # o
    rings += ring(x + Ro, cyw, Ro, Ri2); stems += rect(x, cyw, s2, 250 - cyw); x += 2 * Ro + 22   # p
    rings += ring(x + Ro, cyw, Ro, Ri2); stems += rect(x + 2*Ro - s2, cyw, s2, base - cyw); x += 2 * Ro + 22  # a
    stems += rect(x, 40, s2, base - 40); x += s2                                            # l
    return f'<path fill="#000" fill-rule="evenodd" d="{rings}"/><path fill="#000" d="{stems}"/>', x
W, wend = word(0)

def write(name, w, h, body, extra=""):
    open(os.path.join(out, name), "w").write(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">{extra}<path fill="#000" fill-rule="evenodd" d="{body}"/></svg>\n' if not extra else
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">{extra}</svg>\n')

write("a-symbol.svg", 256, 256, A)
write("c-symbol.svg", 256, 256, C)
bpaths = "".join(f'<path fill="#000" fill-rule="evenodd" d="{p}"/>' for p in B_parts)
write("b-symbol.svg", 256, 256, None, f'<g transform="rotate(45 128 128)">{bpaths}</g>')
# lockups: symbol + gap 40 + wordmark (wordmark scaled 0.82, vertically centred on symbol)
k, gapx = 0.82, 40
lw = 256 + gapx + wend * k
for n, body in (("a", A), ("c", C)):
    write(f"{n}-lockup.svg", lw, 256, None,
          f'<path fill="#000" fill-rule="evenodd" d="{body}"/><g transform="translate({256+gapx} {f(128 - 145*k)}) scale({k})">{W}</g>')
write("b-lockup.svg", lw, 256, None,
      f'<g transform="rotate(45 128 128)">{bpaths}</g><g transform="translate({256+gapx} {f(128 - 145*k)}) scale({k})">{W}</g>')
print("ok", lw)
