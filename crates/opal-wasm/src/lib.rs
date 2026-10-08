//! Opal runtime core (wasm32, no wasm-bindgen). Parses `.opal`, owns sprite
//! instances, advances animation and writes per-asset instance batches that
//! JS uploads straight from linear memory. JS only touches WebCodecs + WebGL.
//!
//! Batch layout per instance (10 x f32): x, y, w, h, u, v, uw, vh, layer, opacity.

use opal_format::Opal;

struct Asset {
    opal: Opal<'static>,
    batch: Vec<f32>,
}

struct Inst {
    asset: u32,
    clip: u32,
    alive: bool,
    t: f32,
    x: f32,
    y: f32,
    scale: f32,
    opacity: f32,
}

struct State {
    assets: Vec<Asset>,
    insts: Vec<Inst>,
    free: Vec<u32>,
}

static mut S: State = State { assets: Vec::new(), insts: Vec::new(), free: Vec::new() };

// ponytail: wasm is single-threaded and exports don't re-enter, so one global is sound here.
fn s() -> &'static mut State {
    unsafe { &mut *(&raw mut S) }
}

fn asset(id: u32) -> &'static Opal<'static> {
    &s().assets[id as usize].opal
}

// ---- loading -------------------------------------------------------------

/// Scratch buffer for JS to copy a file into. Ownership passes to `opal_load`.
#[unsafe(no_mangle)]
pub extern "C" fn opal_alloc(len: usize) -> *mut u8 {
    Box::leak(vec![0u8; len].into_boxed_slice()).as_mut_ptr()
}

/// Returns asset id, or -1 if the file is invalid.
/// ponytail: assets are never unloaded; add opal_unload when games stream levels.
#[unsafe(no_mangle)]
pub extern "C" fn opal_load(ptr: *const u8, len: usize) -> i32 {
    let bytes: &'static [u8] = unsafe { core::slice::from_raw_parts(ptr, len) };
    match Opal::parse(bytes) {
        Some(opal) => {
            s().assets.push(Asset { opal, batch: Vec::new() });
            s().assets.len() as i32 - 1
        }
        None => -1,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn opal_width(a: u32) -> u32 { asset(a).width as u32 }
#[unsafe(no_mangle)]
pub extern "C" fn opal_height(a: u32) -> u32 { asset(a).height as u32 }
#[unsafe(no_mangle)]
pub extern "C" fn opal_clip_frames(a: u32, c: u32) -> u32 { asset(a).clips[c as usize].count }
#[unsafe(no_mangle)]
pub extern "C" fn opal_clip_w(a: u32, c: u32) -> u32 { asset(a).clips[c as usize].src[0] as u32 }
#[unsafe(no_mangle)]
pub extern "C" fn opal_clip_h(a: u32, c: u32) -> u32 { asset(a).clips[c as usize].src[1] as u32 }
#[unsafe(no_mangle)]
pub extern "C" fn opal_coded_height(a: u32) -> u32 { asset(a).coded_height as u32 }
#[unsafe(no_mangle)]
pub extern "C" fn opal_codec_ptr(a: u32) -> *const u8 { asset(a).codec.as_ptr() }
#[unsafe(no_mangle)]
pub extern "C" fn opal_codec_len(a: u32) -> usize { asset(a).codec.len() }
#[unsafe(no_mangle)]
pub extern "C" fn opal_desc_ptr(a: u32) -> *const u8 { asset(a).description.as_ptr() }
#[unsafe(no_mangle)]
pub extern "C" fn opal_desc_len(a: u32) -> usize { asset(a).description.len() }
#[unsafe(no_mangle)]
pub extern "C" fn opal_frame_count(a: u32) -> u32 { asset(a).frames.len() as u32 }
#[unsafe(no_mangle)]
pub extern "C" fn opal_frame_ptr(a: u32, i: u32) -> *const u8 { asset(a).frame_data(i as usize).as_ptr() }
#[unsafe(no_mangle)]
pub extern "C" fn opal_frame_size(a: u32, i: u32) -> u32 { asset(a).frames[i as usize].size }
#[unsafe(no_mangle)]
pub extern "C" fn opal_frame_key(a: u32, i: u32) -> u32 { asset(a).frames[i as usize].key as u32 }
#[unsafe(no_mangle)]
pub extern "C" fn opal_clip_count(a: u32) -> u32 { asset(a).clips.len() as u32 }
#[unsafe(no_mangle)]
pub extern "C" fn opal_clip_name_ptr(a: u32, c: u32) -> *const u8 { asset(a).clips[c as usize].name.as_ptr() }
#[unsafe(no_mangle)]
pub extern "C" fn opal_clip_name_len(a: u32, c: u32) -> usize { asset(a).clips[c as usize].name.len() }

// ---- instances -----------------------------------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn opal_spawn(asset_id: u32, clip: u32, x: f32, y: f32, scale: f32) -> u32 {
    assert!((clip as usize) < asset(asset_id).clips.len());
    let inst = Inst { asset: asset_id, clip, alive: true, t: 0.0, x, y, scale, opacity: 1.0 };
    let st = s();
    match st.free.pop() {
        Some(id) => {
            st.insts[id as usize] = inst;
            id
        }
        None => {
            st.insts.push(inst);
            st.insts.len() as u32 - 1
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn opal_set(id: u32, x: f32, y: f32, scale: f32, opacity: f32) {
    let i = &mut s().insts[id as usize];
    (i.x, i.y, i.scale, i.opacity) = (x, y, scale, opacity);
}

/// Switch clip, restarting from its first frame.
#[unsafe(no_mangle)]
pub extern "C" fn opal_play(id: u32, clip: u32) {
    let i = &mut s().insts[id as usize];
    assert!((clip as usize) < asset(i.asset).clips.len());
    (i.clip, i.t) = (clip, 0.0);
}

/// 1 once a non-looping clip has shown its last frame.
#[unsafe(no_mangle)]
pub extern "C" fn opal_done(id: u32) -> u32 {
    let i = &s().insts[id as usize];
    let o = asset(i.asset);
    let c = &o.clips[i.clip as usize];
    (!c.looped && i.t * o.fps >= c.count as f32) as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn opal_kill(id: u32) {
    let st = s();
    if std::mem::replace(&mut st.insts[id as usize].alive, false) {
        st.free.push(id);
    }
}

/// Advance all instances by `dt` seconds and rebuild every asset's batch.
#[unsafe(no_mangle)]
pub extern "C" fn opal_tick(dt: f32) {
    let st = s();
    st.assets.iter_mut().for_each(|a| a.batch.clear());
    for i in st.insts.iter_mut().filter(|i| i.alive) {
        let a = &mut st.assets[i.asset as usize];
        let o = &a.opal;
        let c = &o.clips[i.clip as usize];
        let len = c.count as f32 / o.fps;
        i.t += dt;
        if c.looped && i.t >= len {
            i.t %= len; // keep t small so f32 precision never drifts
        }
        let f = ((i.t * o.fps) as u32).min(c.count - 1);
        let k = i.scale;
        let [rx, ry, rw, rh] = c.rect.map(|v| v as f32);
        let (aw, ah) = (o.width as f32, o.height as f32);
        a.batch.extend_from_slice(&[
            i.x + (c.origin[0] as f32 - c.src[0] as f32 * 0.5) * k,
            i.y + (c.origin[1] as f32 - c.src[1] as f32 * 0.5) * k,
            rw * k,
            rh * k,
            rx / aw,
            ry / ah,
            rw / aw,
            rh / ah,
            (c.first + f) as f32,
            i.opacity,
        ]);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn opal_batch_ptr(a: u32) -> *const f32 { s().assets[a as usize].batch.as_ptr() }
#[unsafe(no_mangle)]
pub extern "C" fn opal_batch_len(a: u32) -> usize { s().assets[a as usize].batch.len() }
