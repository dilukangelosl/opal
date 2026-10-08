//! Encoder-side image work shared by the `opal` CLI and Opal Studio (wasm):
//! chroma keying, trim boxes, atlas packing, color bleed and alpha stacking.
//! No I/O and no codec — callers bring RGBA frames and an H.264 encoder.

pub mod key;

/// Transparent gutter between packed rects (bilinear/mip safety).
pub const GAP: usize = 4;

/// Union bbox `[x, y, w, h]` of visible pixels (alpha > 2) inside `rect` over all
/// `frames` (each a full RGBA frame `w` px wide). None if fully transparent.
pub fn bbox<'a>(frames: impl IntoIterator<Item = &'a [u8]>, w: usize, rect: [usize; 4]) -> Option<[usize; 4]> {
    let [rx, ry, rw, rh] = rect;
    let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
    for f in frames {
        for y in ry..ry + rh {
            for x in rx..rx + rw {
                if f[(y * w + x) * 4 + 3] > 2 {
                    (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x + 1), y1.max(y + 1));
                }
            }
        }
    }
    (x1 > 0).then(|| [x0, y0, x1 - x0, y1 - y0])
}

/// Shelf-pack `[w, h]` rects (tallest first), trying every atlas width and
/// keeping the one that fits mobile decoders (stacked ≤ 2048), then smallest
/// coded area, then squarest. Returns (positions, atlas w, atlas h).
/// ponytail: shelf packing; swap in maxrects if big sheets still waste space.
pub fn pack(sizes: &[[usize; 2]]) -> (Vec<[usize; 2]>, usize, usize) {
    let mut order: Vec<usize> = (0..sizes.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(sizes[i][1]));
    let shelf = |width: usize| {
        let mut at = vec![[0; 2]; sizes.len()];
        let (mut x, mut y, mut row, mut aw) = (0, 0, 0, 0);
        for &i in &order {
            let [bw, bh] = sizes[i];
            if x > 0 && x + bw > width {
                (x, y, row) = (0, y + row + GAP, 0);
            }
            at[i] = [x, y];
            aw = aw.max(x + bw);
            x += bw + GAP;
            row = row.max(bh);
        }
        (at, aw, y + row)
    };
    let min_w = sizes.iter().map(|s| s[0]).max().unwrap_or(0);
    let max_w = sizes.iter().map(|s| s[0] + GAP).sum::<usize>();
    let best = (min_w..=max_w)
        .step_by(4)
        .min_by_key(|&w| {
            let (_, aw, ah) = shelf(w);
            let (cw, ch) = (aw.next_multiple_of(16), ah.next_multiple_of(16) * 2); // stacked frame
            (cw.max(ch) > 2048, cw * ch, cw.abs_diff(ch))
        })
        .unwrap_or(min_w);
    shelf(best)
}

/// One trimmed rect copied into the atlas.
pub struct Blit<'a> {
    pub src: &'a [u8], // full RGBA source frame
    pub src_w: usize,
    pub bbox: [usize; 4], // rect in the source
    pub at: [usize; 2],   // position in the atlas
}

/// Compose blits into a (cw, ch) atlas, bleed color into transparent pixels
/// (kills dark halos from chroma subsampling), and append the stacked frame
/// (color on top, alpha as gray below) with `bpp` = 3 (RGB) or 4 (RGBX).
pub fn stack<'a>(blits: impl IntoIterator<Item = Blit<'a>>, (cw, ch): (usize, usize), bpp: usize, out: &mut Vec<u8>) {
    let mut c = vec![0u8; cw * ch * 4];
    for b in blits {
        let [bx, by, bw, bh] = b.bbox;
        for y in 0..bh {
            let s = ((by + y) * b.src_w + bx) * 4;
            let d = ((b.at[1] + y) * cw + b.at[0]) * 4;
            c[d..d + bw * 4].copy_from_slice(&b.src[s..s + bw * 4]);
        }
    }
    bleed(&mut c, cw, ch);
    let base = out.len();
    out.resize(base + cw * ch * 2 * bpp, 255);
    let (top, bottom) = out[base..].split_at_mut(cw * ch * bpp);
    for (i, px) in c.chunks_exact(4).enumerate() {
        top[i * bpp..i * bpp + 3].copy_from_slice(&px[..3]);
        bottom[i * bpp..i * bpp + 3].fill(px[3]);
    }
}

/// Fill transparent pixels with neighboring colors (16 dilation passes), the
/// rest with the average visible color.
pub fn bleed(c: &mut [u8], w: usize, h: usize) {
    let mut known: Vec<bool> = c.chunks_exact(4).map(|p| p[3] > 0).collect();
    for _ in 0..16 {
        let mut next = known.clone();
        let mut changed = false;
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                if known[i] {
                    continue;
                }
                let (mut s, mut n) = ([0u32; 3], 0);
                for j in [(x > 0).then(|| i - 1), (x + 1 < w).then(|| i + 1), (y > 0).then(|| i - w), (y + 1 < h).then(|| i + w)]
                    .into_iter()
                    .flatten()
                {
                    if known[j] {
                        (0..3).for_each(|k| s[k] += c[j * 4 + k] as u32);
                        n += 1;
                    }
                }
                if n > 0 {
                    (0..3).for_each(|k| c[i * 4 + k] = (s[k] / n) as u8);
                    next[i] = true;
                    changed = true;
                }
            }
        }
        known = next;
        if !changed {
            break;
        }
    }
    // Far-away pixels: flat average color, compresses to ~nothing.
    let (mut s, mut n) = ([0u64; 3], 0u64);
    for (p, _) in c.chunks_exact(4).zip(&known).filter(|(_, k)| **k) {
        (0..3).for_each(|k| s[k] += p[k] as u64);
        n += 1;
    }
    let avg = s.map(|v| (v / n.max(1)) as u8);
    for (p, _) in c.chunks_exact_mut(4).zip(&known).filter(|(_, k)| !**k) {
        p[..3].copy_from_slice(&avg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_no_overlap() {
        let sizes = [[30, 50], [100, 20], [40, 40], [10, 90], [64, 64], [5, 5]];
        let (at, aw, ah) = pack(&sizes);
        for i in 0..sizes.len() {
            let ([ax, ay], [aw_, ah_]) = (at[i], sizes[i]);
            assert!(ax + aw_ <= aw && ay + ah_ <= ah);
            for j in i + 1..sizes.len() {
                let ([bx, by], [bw, bh]) = (at[j], sizes[j]);
                let apart = ax + aw_ + GAP <= bx || bx + bw + GAP <= ax || ay + ah_ + GAP <= by || by + bh + GAP <= ay;
                assert!(apart, "overlap {:?} {:?}", at[i], at[j]);
            }
        }
    }

    #[test]
    fn bbox_and_stack() {
        let (w, h) = (8, 6);
        let mut f = vec![0u8; w * h * 4];
        f[(2 * w + 3) * 4..][..4].copy_from_slice(&[200, 10, 20, 255]);
        assert_eq!(bbox([&f[..]], w, [0, 0, w, h]), Some([3, 2, 1, 1]));
        assert_eq!(bbox([&f[..]], w, [4, 0, 4, h]), None);
        let mut out = vec![];
        stack([Blit { src: &f, src_w: w, bbox: [3, 2, 1, 1], at: [1, 0] }], (16, 16), 4, &mut out);
        assert_eq!(out.len(), 16 * 32 * 4);
        assert_eq!(&out[4..8], &[200, 10, 20, 255]); // color at (1,0), X byte = 255
        assert_eq!(&out[(16 * 16 + 1) * 4..][..3], &[255, 255, 255]); // alpha below it
        assert_eq!(out[(16 * 16) * 4], 0); // transparent neighbor's alpha
        assert_eq!(&out[..3], &[200, 10, 20]); // bled color
    }
}
