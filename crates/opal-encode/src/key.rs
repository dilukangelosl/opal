//! Chroma keying for inputs shot/rendered on a solid backdrop.
//!
//! Colored keys compare *chromaticity* (YCbCr chroma divided by luma): lighting
//! falloff and shadows scale chroma and luma together, so a vignetted green
//! screen stays one color. Neutral keys (black, white, grey) have no chroma to
//! go on, so they compare plain YCbCr with full luma weight instead.

pub struct Keyer {
    keys: Vec<[f32; 3]>, // YCbCr
    pub tol: f32,        // distance below which a pixel is fully transparent
    pub soft: f32,       // feather width above `tol` (soft edges)
    pub despill: f32,    // 0..1, how much key tint to strip from nearby pixels
    pub speck: usize,    // islands smaller than this many px are removed
}

fn ycc([r, g, b]: [f32; 3]) -> [f32; 3] {
    let y = 0.299 * r + 0.587 * g + 0.114 * b; // BT.601; Cb/Cr centered on 0
    [y, (b - y) * 0.564, (r - y) * 0.713]
}

fn neutral(k: [f32; 3]) -> bool {
    k[1].hypot(k[2]) < 0.2 * (k[0] + 16.0) // saturation, not raw chroma: dark green is still green
}

/// Chroma per unit luma (+16 keeps near-black noise from exploding).
fn chromaticity(c: [f32; 3]) -> [f32; 2] {
    [c[1] / (c[0] + 16.0), c[2] / (c[0] + 16.0)]
}

/// Colored keys: chromaticity distance in chroma units at mid brightness (fixed
/// scale, so tolerance doesn't depend on which shade of the backdrop was picked).
fn rgb([y, cb, cr]: [f32; 3]) -> [f32; 3] {
    let (r, b) = (y + cr / 0.713, y + cb / 0.564);
    [r, (y - 0.299 * r - 0.114 * b) / 0.587, b]
}

fn dist(c: [f32; 3], k: [f32; 3]) -> f32 {
    if neutral(k) {
        return ((c[0] - k[0]).powi(2) + (c[1] - k[1]).powi(2) + (c[2] - k[2]).powi(2)).sqrt();
    }
    let (n, m) = (chromaticity(c), chromaticity(k));
    (n[0] - m[0]).hypot(n[1] - m[1]) * 128.0
}

/// "#00ff00,#c0c" style list -> RGB triples.
pub fn parse_hex(s: &str) -> Result<Vec<[u8; 3]>, String> {
    s.split(',')
        .map(|h| {
            let h = h.trim().trim_start_matches('#');
            let h = match h.len() {
                3 => h.chars().flat_map(|c| [c, c]).collect(),
                6 => h.to_string(),
                _ => return Err(format!("bad key color '{h}' (want #rrggbb or #rgb)")),
            };
            let v = u32::from_str_radix(&h, 16).map_err(|_| format!("bad key color '{h}'"))?;
            Ok([(v >> 16) as u8, (v >> 8) as u8, v as u8])
        })
        .collect()
}

pub fn hex([r, g, b]: [u8; 3]) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

impl Keyer {
    pub fn new(keys: &[[u8; 3]], tol: f32, soft: f32, despill: f32, speck: usize) -> Self {
        Keyer { keys: keys.iter().map(|k| ycc(k.map(f32::from))).collect(), tol, soft: soft.max(1e-3), despill, speck }
    }

    /// Find backdrop colors from opaque pixels on the frame border (first,
    /// middle, last frame). Greedy: take the densest chroma neighborhood among
    /// uncovered samples until ≥90% are covered. Binning on chroma only means
    /// lighting falloff doesn't split one backdrop into many buckets. Up to 4
    /// keys handle gradients and two-tone backdrops.
    pub fn detect(&self, rgba: &[u8], w: usize, h: usize) -> Result<Vec<[u8; 3]>, String> {
        let n = rgba.len() / (w * h * 4);
        let mut samples = vec![];
        for t in [0, n / 2, n.saturating_sub(1)] {
            let f = &rgba[t * w * h * 4..(t + 1) * w * h * 4];
            let edge = (0..w).flat_map(|x| (0..4).flat_map(move |d| [(x, d), (x, h - 1 - d)]))
                .chain((0..h).flat_map(|y| (0..4).flat_map(move |d| [(d, y), (w - 1 - d, y)])));
            for (x, y) in edge {
                let p = &f[(y * w + x) * 4..][..4];
                if p[3] >= 128 {
                    samples.push([p[0], p[1], p[2]]);
                }
            }
        }
        if samples.is_empty() {
            return Err("frame border is already transparent — no backdrop to key".into());
        }
        let near = |s: &[u8; 3], keys: &[[u8; 3]]| {
            let c = ycc(s.map(f32::from));
            keys.iter().any(|k| dist(c, ycc(k.map(f32::from))) <= self.tol + self.soft)
        };
        let mut keys: Vec<[u8; 3]> = vec![];
        while keys.len() < 4 {
            let rest: Vec<&[u8; 3]> = samples.iter().filter(|s| !near(s, &keys)).collect();
            if rest.len() * 10 < samples.len() {
                break;
            }
            const B: usize = 64; // chromaticity cells of 0.1 over [-3.2, 3.2]
            let bin = |s: &[u8; 3]| {
                let n = chromaticity(ycc(s.map(f32::from)));
                let q = |v: f32| ((v + 3.2) / 0.1).clamp(0.0, (B - 1) as f32) as usize;
                (q(n[0]), q(n[1]))
            };
            let mut hist = [[0u32; B]; B];
            rest.iter().for_each(|s| { let (i, j) = bin(s); hist[i][j] += 1 });
            let window = |i: usize, j: usize| (i.saturating_sub(1)..=(i + 1).min(B - 1))
                .flat_map(move |a| (j.saturating_sub(1)..=(j + 1).min(B - 1)).map(move |b| (a, b)));
            let (bi, bj) = (0..B * B)
                .map(|n| (n / B, n % B))
                .max_by_key(|&(i, j)| window(i, j).map(|(a, b)| hist[a][b]).sum::<u32>())
                .unwrap();
            let (mut count, mut sum) = (0u64, [0u64; 3]);
            for s in rest.iter().filter(|s| { let (i, j) = bin(s); i.abs_diff(bi) <= 1 && j.abs_diff(bj) <= 1 }) {
                count += 1;
                (0..3).for_each(|k| sum[k] += s[k] as u64);
            }
            // A real backdrop dominates the border: first key needs ≥25%, extras ≥5%.
            if (count as usize) * if keys.is_empty() { 4 } else { 20 } < samples.len() {
                break;
            }
            keys.push(sum.map(|v| (v / count) as u8));
        }
        let covered = samples.iter().filter(|s| near(s, &keys)).count();
        if keys.is_empty() || covered * 10 < samples.len() * 6 {
            return Err("no uniform backdrop on the frame border; pass --key #rrggbb".into());
        }
        Ok(keys)
    }

    /// Key every frame in place (multiplies existing alpha), frames spread over all cores.
    pub fn apply(&self, rgba: &mut [u8], w: usize, h: usize) {
        let flen = w * h * 4;
        if cfg!(target_arch = "wasm32") {
            // plain wasm32 has no threads
            for f in rgba.chunks_exact_mut(flen) {
                f.chunks_exact_mut(4).for_each(|p| self.pixel(p));
                despeckle(f, w, h, self.speck);
            }
            return;
        }
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
        let per = (rgba.len() / flen).div_ceil(threads).max(1) * flen;
        std::thread::scope(|s| {
            for c in rgba.chunks_mut(per) {
                s.spawn(move || {
                    for f in c.chunks_exact_mut(flen) {
                        f.chunks_exact_mut(4).for_each(|p| self.pixel(p));
                        despeckle(f, w, h, self.speck);
                    }
                });
            }
        });
    }

    fn pixel(&self, p: &mut [u8]) {
        let mut c = ycc([p[0], p[1], p[2]].map(f32::from));
        let (k, d) = self.keys.iter().map(|&k| (k, dist(c, k))).min_by(|a, b| a.1.total_cmp(&b.1)).unwrap();
        // Clip black/white: snap the outer 5% so backdrop noise doesn't leave faint
        // pixels (which would also defeat trimming); stretch the rest so soft edges stay smooth.
        let stretch = |v: f32| ((v - 0.05) / 0.9).clamp(0.0, 1.0);
        let mut a = stretch((d - self.tol) / self.soft);
        // Distance says *whether* a pixel is backdrop; it can't say *how much* of a mixed pixel
        // is. For that, project raw chroma onto the key's: a neutral fg (smoke, glow, a blade)
        // mixed with the key at alpha a keeps (1 − a) of the key's chroma along that direction.
        let kl2 = k[1] * k[1] + k[2] * k[2];
        if !neutral(k) && kl2 > 1.0 {
            a = a.min(stretch(1.0 - (c[1] * k[1] + c[2] * k[2]) / kl2));
        }
        p[3] = (p[3] as f32 * a).round() as u8;

        // Decontaminate partly transparent pixels (soft edges, motion blur, smoke, glows):
        // the camera saw fg·a + key·(1−a), so recover fg = (seen − key·(1−a)) / a.
        // ponytail: a floor of 0.2 stops noise blowing up in near-invisible pixels.
        if a > 0.0 && a < 1.0 {
            let (kr, ae) = (rgb(k), a.max(0.2));
            for (o, kv) in p[..3].iter_mut().zip(kr) {
                *o = ((*o as f32 - kv * (1.0 - ae)) / ae).round().clamp(0.0, 255.0) as u8;
            }
            c = ycc([p[0], p[1], p[2]].map(f32::from));
        }

        // Despill: remove chroma pointing toward the key, fading out over
        // tol..tol+3*soft. ponytail: spill and real near-key colors (red on a pink
        // screen) sit at similar distances; --despill trades one for the other.
        let len = k[1].hypot(k[2]);
        let wgt = self.despill * (1.0 - (d - self.tol) / (3.0 * self.soft)).clamp(0.0, 1.0);
        if len > 1.0 && wgt > 0.0 && p[3] > 0 {
            let (ux, uy) = (k[1] / len, k[2] / len);
            let proj = (c[1] * ux + c[2] * uy).max(0.0) * wgt;
            for (o, v) in p[..3].iter_mut().zip(rgb([c[0], c[1] - ux * proj, c[2] - uy * proj])) {
                *o = v.round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

/// Remove islands of visible pixels smaller than `min` (8-connected). Backdrop
/// noise survives keying as small clusters, worst in dark vignetted corners;
/// left in, they'd also stretch the trim box to the whole cell.
fn despeckle(f: &mut [u8], w: usize, h: usize, min: usize) {
    let mut seen: Vec<bool> = f.chunks_exact(4).map(|p| p[3] == 0).collect();
    let (mut stack, mut comp) = (vec![], vec![]);
    for start in 0..w * h {
        if seen[start] {
            continue;
        }
        seen[start] = true;
        stack.push(start);
        comp.clear();
        while let Some(i) = stack.pop() {
            comp.push(i);
            let (x, y) = (i % w, i / w);
            for yy in y.saturating_sub(1)..=(y + 1).min(h - 1) {
                for xx in x.saturating_sub(1)..=(x + 1).min(w - 1) {
                    let j = yy * w + xx;
                    if !seen[j] {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }
        }
        if comp.len() < min {
            comp.iter().for_each(|&i| f[i * 4 + 3] = 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_parse() {
        assert_eq!(parse_hex("#00ff00, c0c").unwrap(), vec![[0, 255, 0], [204, 0, 204]]);
        assert!(parse_hex("#12345").is_err());
    }

    /// Noisy, lit-unevenly green backdrop + red square with a green-spilled
    /// light edge (e.g. pale hair picking up bounce light from the screen).
    #[test]
    fn detect_and_key_green_screen() {
        let (w, h) = (48, 48);
        let mut f = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let shade = (x + y) as u8; // lighting gradient across the backdrop
                let px = if (16..32).contains(&x) && (16..32).contains(&y) {
                    if x == 16 { [150, 200, 150] } else { [220, 30, 30] } // left edge: grey + green spill
                } else {
                    [20 + shade / 2, 170 + shade / 2, 60 + (x as u8 % 7)]
                };
                f[(y * w + x) * 4..][..4].copy_from_slice(&[px[0], px[1], px[2], 255]);
            }
        }
        let k = Keyer::new(&[], 30.0, 20.0, 1.0, 16);
        let keys = k.detect(&f, w, h).unwrap();
        assert!(keys.iter().all(|k| k[1] > k[0] + 100 && k[1] > k[2] + 60), "{keys:?}");

        let k = Keyer::new(&keys, 30.0, 20.0, 1.0, 16);
        for (x, y) in [(5, 40), (6, 40), (5, 41)] {
            f[(y * w + x) * 4..][..3].copy_from_slice(&[200, 40, 200]); // 3-px noise cluster
        }
        k.apply(&mut f, w, h);
        let px = |x: usize, y: usize| &f[(y * w + x) * 4..][..4];
        for (x, y) in [(0, 0), (47, 47), (5, 40), (40, 5)] { // (5,40) = despeckled
            assert_eq!(px(x, y)[3], 0, "backdrop at {x},{y} not keyed");
        }
        assert_eq!(px(24, 24), &[220, 30, 30, 255], "foreground damaged");
        let e = px(16, 20);
        assert!(e[3] > 128 && (e[1] as i32) - (e[0] as i32) < 15, "edge spill not reduced: {e:?}");
    }

    #[test]
    fn decontaminates_soft_pixels() {
        // white smoke at ~50% over a pure green screen reads (128, 255, 128): mint, not white
        let mut px = [128u8, 255, 128, 255];
        Keyer::new(&[[0, 255, 0]], 30.0, 20.0, 1.0, 0).pixel(&mut px);
        assert!(px[3] > 40 && px[3] < 255, "should stay partly transparent: {px:?}");
        assert!((px[1] as i32) < px[0] as i32 + 25 && px[0] > 180, "green cast should be removed: {px:?}");
    }

    #[test]
    fn rejects_busy_border() {
        let (w, h) = (16, 16);
        let f: Vec<u8> = (0..w * h).flat_map(|i| [(i * 37) as u8, (i * 91) as u8, (i * 53) as u8, 255]).collect();
        assert!(Keyer::new(&[], 30.0, 20.0, 1.0, 16).detect(&f, w, h).is_err());
    }
}
