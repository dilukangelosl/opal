//! `.opal` container: a stacked-alpha video sprite sheet.
//!
//! Each encoded frame is `coded_width x 2*coded_height`: color in the top half,
//! alpha (as luma) in the bottom half, starting at row `coded_height`.
//! The visible `width x height` area is an atlas: every clip owns a rect in it.
//! All integers little-endian. Frame data is stored contiguously in frame order.

pub const MAGIC: &[u8; 4] = b"OPAL";
pub const VERSION: u16 = 2;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Clip {
    pub name: String,
    pub first: u32,
    pub count: u32,
    pub looped: bool,
    pub rect: [u16; 4],   // x, y, w, h inside the atlas
    pub origin: [u16; 2], // where the rect sat inside its source cell (trim offset)
    pub src: [u16; 2],    // source cell size; sprite anchor is its center
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub offset: u32, // relative to `data`
    pub size: u32,
    pub key: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Opal<'a> {
    pub codec: String,         // WebCodecs codec string, e.g. "avc1.64001f"
    pub description: &'a [u8], // decoder config record (avcC); empty = in-band
    pub width: u16,            // visible atlas size
    pub height: u16,
    pub coded_width: u16, // padded color region; alpha starts at row coded_height
    pub coded_height: u16,
    pub fps: f32,
    pub clips: Vec<Clip>,
    pub frames: Vec<Frame>,
    pub data: &'a [u8],
}

impl<'a> Opal<'a> {
    /// Serialize. Assumes `frames` are contiguous in `data`, in order.
    pub fn write(&self) -> Vec<u8> {
        let mut o = Vec::with_capacity(self.data.len() + 64 + self.frames.len() * 5);
        o.extend_from_slice(MAGIC);
        o.extend_from_slice(&VERSION.to_le_bytes());
        o.extend_from_slice(&1u16.to_le_bytes()); // flags: bit0 = stacked alpha
        for v in [self.width, self.height, self.coded_width, self.coded_height] {
            o.extend_from_slice(&v.to_le_bytes());
        }
        o.extend_from_slice(&self.fps.to_le_bytes());
        o.push(self.codec.len() as u8);
        o.extend_from_slice(self.codec.as_bytes());
        o.extend_from_slice(&(self.description.len() as u32).to_le_bytes());
        o.extend_from_slice(self.description);
        o.extend_from_slice(&(self.clips.len() as u16).to_le_bytes());
        for c in &self.clips {
            o.push(c.name.len() as u8);
            o.extend_from_slice(c.name.as_bytes());
            o.extend_from_slice(&c.first.to_le_bytes());
            o.extend_from_slice(&c.count.to_le_bytes());
            o.push(c.looped as u8);
            for v in c.rect.iter().chain(&c.origin).chain(&c.src) {
                o.extend_from_slice(&v.to_le_bytes());
            }
        }
        o.extend_from_slice(&(self.frames.len() as u32).to_le_bytes());
        for f in &self.frames {
            o.extend_from_slice(&f.size.to_le_bytes());
            o.push(f.key as u8);
        }
        o.extend_from_slice(self.data);
        o
    }

    /// Parse and validate. Returns None on any malformed input.
    pub fn parse(b: &'a [u8]) -> Option<Self> {
        let mut r = R { b, p: 0 };
        if r.take(4)? != MAGIC || r.u16()? != VERSION || r.u16()? & 1 == 0 {
            return None;
        }
        let [width, height, coded_width, coded_height] = [r.u16()?, r.u16()?, r.u16()?, r.u16()?];
        let fps = f32::from_le_bytes(r.take(4)?.try_into().ok()?);
        let n = r.u8()? as usize;
        let codec = String::from_utf8(r.take(n)?.to_vec()).ok()?;
        let n = r.u32()? as usize;
        let description = r.take(n)?;
        let mut clips = Vec::new();
        for _ in 0..r.u16()? {
            let n = r.u8()? as usize;
            let name = String::from_utf8(r.take(n)?.to_vec()).ok()?;
            let (first, count, looped) = (r.u32()?, r.u32()?, r.u8()? != 0);
            let rect = [r.u16()?, r.u16()?, r.u16()?, r.u16()?];
            let (origin, src) = ([r.u16()?, r.u16()?], [r.u16()?, r.u16()?]);
            clips.push(Clip { name, first, count, looped, rect, origin, src });
        }
        let n = r.u32()? as usize;
        let mut frames = Vec::with_capacity(n.min(b.len() / 5));
        let mut offset = 0u32;
        for _ in 0..n {
            let size = r.u32()?;
            frames.push(Frame { offset, size, key: r.u8()? != 0 });
            offset = offset.checked_add(size)?;
        }
        let data = &b[r.p..];
        let ok = offset as usize <= data.len()
            && fps > 0.0
            && width > 0 && height > 0
            && width <= coded_width && height <= coded_height
            && clips.iter().all(|c| {
                c.count > 0
                    && c.first.checked_add(c.count).is_some_and(|e| e as usize <= frames.len())
                    && c.rect[2] > 0 && c.rect[3] > 0
                    && c.rect[0] as u32 + c.rect[2] as u32 <= width as u32
                    && c.rect[1] as u32 + c.rect[3] as u32 <= height as u32
            });
        ok.then_some(Opal {
            codec, description, width, height, coded_width, coded_height, fps, clips, frames, data,
        })
    }

    pub fn frame_data(&self, i: usize) -> &'a [u8] {
        let f = self.frames[i];
        &self.data[f.offset as usize..(f.offset + f.size) as usize]
    }
}

struct R<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> R<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.b.get(self.p..self.p.checked_add(n)?)?;
        self.p += n;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_le_bytes(self.take(2)?.try_into().ok()?))
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_reject_garbage() {
        let data = [1u8, 2, 3, 4, 5];
        let o = Opal {
            codec: "avc1.64001f".into(),
            description: &[9, 9],
            width: 10, height: 12, coded_width: 16, coded_height: 16,
            fps: 30.0,
            clips: vec![Clip {
                name: "idle".into(), first: 0, count: 2, looped: true,
                rect: [1, 2, 8, 9], origin: [3, 4], src: [64, 64],
            }],
            frames: vec![Frame { offset: 0, size: 3, key: true }, Frame { offset: 3, size: 2, key: false }],
            data: &data,
        };
        let bytes = o.write();
        assert_eq!(Opal::parse(&bytes), Some(o.clone()));
        assert_eq!(Opal::parse(&bytes).unwrap().frame_data(1), &[4, 5]);
        for cut in 0..bytes.len() {
            assert_eq!(Opal::parse(&bytes[..cut]), None, "truncated at {cut}");
        }
        let mut bad = o.clone();
        bad.clips[0].count = 3; // clip past last frame
        assert_eq!(Opal::parse(&bad.write()), None);
        let mut bad = o;
        bad.clips[0].rect[2] = 10; // rect past atlas edge
        assert_eq!(Opal::parse(&bad.write()), None);
    }
}
