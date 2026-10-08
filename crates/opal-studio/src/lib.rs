//! Opal Studio's wasm core: the same keyer, trim, packer and stacker as the
//! `opal` CLI, exposed to the browser. The browser decodes (video element) and
//! encodes (WebCodecs VideoEncoder); this crate does all the pixel work and
//! writes the `.opal` container.
//!
//! Studio layout: every clip gets its own rect in one atlas and all clips share
//! the timeline from frame 0, so N clips of L frames cost L encoded frames.

use opal_encode::{bbox, key::Keyer, pack, stack, Blit};
use opal_format::{Clip, Frame, Opal};
use wasm_bindgen::prelude::*;

fn keys(flat: &[u8]) -> Vec<[u8; 3]> {
    flat.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect()
}

/// Backdrop colors from the border of `rgba` (one or more w×h frames). Flat RGB triples.
#[wasm_bindgen]
pub fn detect_keys(rgba: &[u8], w: usize, h: usize, tol: f32, soft: f32) -> Result<Vec<u8>, JsError> {
    let found = Keyer::new(&[], tol, soft, 1.0, 16).detect(rgba, w, h).map_err(|e| JsError::new(&e))?;
    Ok(found.concat())
}

/// Chroma-key w×h RGBA frame(s) in place. `keys` = flat RGB triples.
#[wasm_bindgen]
pub fn key_frame(rgba: &mut [u8], w: usize, h: usize, keys_rgb: &[u8], tol: f32, soft: f32, despill: f32, speck: usize) {
    if keys_rgb.len() >= 3 {
        Keyer::new(&keys(keys_rgb), tol, soft, despill, speck).apply(rgba, w, h);
    }
}

struct Item {
    name: String,
    looped: bool,
    w: usize,
    h: usize,
    frames: Vec<u8>,
    bbox: [usize; 4],
    at: [usize; 2],
}

impl Item {
    fn count(&self) -> usize {
        self.frames.len() / (self.w * self.h * 4)
    }
}

#[wasm_bindgen]
pub struct Project {
    fps: f32,
    items: Vec<Item>,
    atlas: [usize; 2],
}

#[wasm_bindgen]
impl Project {
    #[wasm_bindgen(constructor)]
    pub fn new(fps: f32) -> Project {
        Project { fps, items: vec![], atlas: [0, 0] }
    }

    /// `frames`: n concatenated, already-keyed RGBA frames of the clip's region (w×h).
    pub fn add_clip(&mut self, name: String, looped: bool, w: usize, h: usize, frames: Vec<u8>) -> Result<(), JsError> {
        let flen = w * h * 4;
        if flen == 0 || frames.is_empty() || frames.len() % flen != 0 {
            return Err(JsError::new(&format!("{name}: bad frame buffer")));
        }
        let b = bbox(frames.chunks_exact(flen), w, [0, 0, w, h])
            .ok_or_else(|| JsError::new(&format!("clip '{name}' is fully transparent — check the key or crop")))?;
        self.items.push(Item { name, looped, w, h, frames, bbox: b, at: [0, 0] });
        Ok(())
    }

    /// Pack all clips. Returns [atlas_w, atlas_h, coded_w, coded_h (color half), frame_count].
    pub fn layout(&mut self) -> Vec<u32> {
        let sizes: Vec<[usize; 2]> = self.items.iter().map(|i| [i.bbox[2], i.bbox[3]]).collect();
        let (at, aw, ah) = pack(&sizes);
        self.items.iter_mut().zip(at).for_each(|(i, a)| i.at = a);
        self.atlas = [aw, ah];
        let n = self.items.iter().map(Item::count).max().unwrap_or(0);
        [aw, ah, aw.next_multiple_of(16), ah.next_multiple_of(16), n].map(|v| v as u32).to_vec()
    }

    /// Trimmed rect per clip, flat [x, y, w, h] in the atlas (after `layout`).
    pub fn rects(&self) -> Vec<u32> {
        self.items.iter().flat_map(|i| [i.at[0], i.at[1], i.bbox[2], i.bbox[3]].map(|v| v as u32)).collect()
    }

    /// Stacked RGBX frame `t` (coded_w × 2·coded_h), ready for `new VideoFrame(…, {format: 'RGBX'})`.
    pub fn frame(&self, t: usize) -> Vec<u8> {
        let (cw, ch) = (self.atlas[0].next_multiple_of(16), self.atlas[1].next_multiple_of(16));
        let blits = self.items.iter().filter(|i| t < i.count()).map(|i| {
            let flen = i.w * i.h * 4;
            Blit { src: &i.frames[t * flen..(t + 1) * flen], src_w: i.w, bbox: i.bbox, at: i.at }
        });
        let mut out = Vec::with_capacity(cw * ch * 2 * 4);
        stack(blits, (cw, ch), 4, &mut out);
        out
    }

    /// Write the container from encoder output: per-frame `sizes`/`keys` (1 = key)
    /// and all chunk bytes concatenated in decode order.
    pub fn finish(&self, codec: String, description: Vec<u8>, sizes: Vec<u32>, keys: Vec<u8>, data: Vec<u8>) -> Result<Vec<u8>, JsError> {
        let mut offset = 0;
        let frames: Vec<Frame> = sizes
            .iter()
            .zip(&keys)
            .map(|(&size, &k)| {
                let f = Frame { offset, size, key: k != 0 };
                offset += size;
                f
            })
            .collect();
        if offset as usize != data.len() {
            return Err(JsError::new("chunk sizes don't match data"));
        }
        let [aw, ah] = self.atlas;
        let opal = Opal {
            codec,
            description: &description,
            width: aw as u16,
            height: ah as u16,
            coded_width: aw.next_multiple_of(16) as u16,
            coded_height: ah.next_multiple_of(16) as u16,
            fps: self.fps,
            clips: self
                .items
                .iter()
                .map(|i| Clip {
                    name: i.name.clone(),
                    first: 0,
                    count: i.count() as u32,
                    looped: i.looped,
                    rect: [i.at[0], i.at[1], i.bbox[2], i.bbox[3]].map(|v| v as u16),
                    origin: [i.bbox[0], i.bbox[1]].map(|v| v as u16),
                    src: [i.w, i.h].map(|v| v as u16),
                })
                .collect(),
            frames,
            data: &data,
        };
        let bytes = opal.write();
        Opal::parse(&bytes).ok_or_else(|| JsError::new("internal: wrote an invalid .opal"))?;
        Ok(bytes)
    }
}
