//! `opal encode` — RGBA video(s) -> trimmed, atlas-packed, stacked-alpha H.264 `.opal`.
//! Shells out to ffmpeg/ffprobe for decode/encode; does region slicing, trim,
//! packing, color bleed, alpha stacking and container packing itself.

use opal_encode::{bbox, key::{self, Keyer}, pack, stack, Blit};
use opal_format::{Clip, Frame, Opal};
use std::{env, fs, io::Write, path::Path, process::{Command, Stdio}};

type Res<T> = Result<T, String>;

const USAGE: &str = "usage: opal encode -o out.opal [--crf 20] [--once <clip>] INPUT...
  INPUT       [name=]video.(mov|webm|...)   whole frame is one clip
  --grid CxR  slice the previous input into a CxR grid of cells...
  --names a,b,,d[@0-23]   ...named row-major; empty name = skip cell; @from-to = frame range
  --rect name=x,y,w,h[@0-23]   add an arbitrary region of the previous input
  --key auto | #rrggbb,#rgb,...  chroma-key the previous input (auto = detect backdrop)
  --key-tol 30  --key-soft 20  --despill 1  --despeckle 16   keying tuning
      (tol/soft: chroma distance; despill 0..1; despeckle: drop islands < N px, 0 = off)";

struct Input {
    name: String,
    path: String,
    grid: Option<(usize, usize)>,
    names: Vec<String>,
    rects: Vec<String>,
    key: Option<String>,
}

struct Region {
    name: String,
    cell: [usize; 4],     // x, y, w, h in the source frame
    frames: (usize, usize), // [from, to)
    bbox: [usize; 4],     // trimmed rect in source coords
    at: [usize; 2],       // packed position in the atlas
}

fn main() {
    if let Err(e) = run() {
        eprintln!("opal: {e}");
        std::process::exit(1);
    }
}

fn run() -> Res<()> {
    let mut args = env::args().skip(1);
    if args.next().as_deref() != Some("encode") {
        return Err(USAGE.into());
    }
    let (mut out, mut crf, mut once, mut inputs) = (None, 20u32, vec![], Vec::<Input>::new());
    let (mut tol, mut soft, mut despill, mut speck) = (30f32, 20f32, 1f32, 16usize);
    while let Some(a) = args.next() {
        let mut next = || args.next().ok_or(USAGE);
        match a.as_str() {
            "-o" => out = Some(next()?),
            "--crf" => crf = next()?.parse().map_err(|_| "bad --crf")?,
            "--once" => once.push(next()?),
            "--key-tol" => tol = next()?.parse().map_err(|_| "bad --key-tol")?,
            "--key-soft" => soft = next()?.parse().map_err(|_| "bad --key-soft")?,
            "--despill" => despill = next()?.parse().map_err(|_| "bad --despill")?,
            "--despeckle" => speck = next()?.parse().map_err(|_| "bad --despeckle")?,
            "--grid" | "--names" | "--rect" | "--key" => {
                let v = next()?;
                let i = inputs.last_mut().ok_or(format!("{a} must follow an input"))?;
                match a.as_str() {
                    "--grid" => {
                        let (c, r) = v.split_once('x').ok_or("--grid wants CxR, e.g. 4x2")?;
                        i.grid = Some((c.parse().map_err(|_| "bad --grid")?, r.parse().map_err(|_| "bad --grid")?));
                    }
                    "--names" => i.names = v.split(',').map(str::to_string).collect(),
                    "--key" => i.key = Some(v),
                    _ => i.rects.push(v),
                }
            }
            _ => {
                let (name, path) = match a.split_once('=') {
                    Some((n, p)) => (n.to_string(), p.to_string()),
                    None => (Path::new(&a).file_stem().unwrap_or_default().to_string_lossy().into(), a),
                };
                inputs.push(Input { name, path, grid: None, names: vec![], rects: vec![], key: None });
            }
        }
    }
    let out = out.ok_or(USAGE)?;
    if inputs.is_empty() {
        return Err(USAGE.into());
    }

    // 1. Decode, resolve regions, trim each region over its frame range, pack per input.
    // ponytail: all frames in RAM; stream if inputs get huge.
    let fps = probe(&inputs[0].path)?.2;
    let mut decoded = vec![]; // (rgba, w, h, regions, span)
    let (mut aw, mut ah) = (0, 0);
    for inp in &inputs {
        let (w, h, f, codec) = probe(&inp.path)?;
        if (f - fps).abs() > 0.01 {
            return Err(format!("{}: all inputs must share fps ({fps})", inp.path));
        }
        let mut rgba = decode(&inp.path, &codec)?;
        if let Some(spec) = &inp.key {
            let keys = match spec.as_str() {
                "auto" => Keyer::new(&[], tol, soft, despill, speck).detect(&rgba, w, h).map_err(|e| format!("{}: {e}", inp.path))?,
                hexes => key::parse_hex(hexes)?,
            };
            println!("{}: keying {}", inp.path, keys.iter().map(|&k| key::hex(k)).collect::<Vec<_>>().join(", "));
            Keyer::new(&keys, tol, soft, despill, speck).apply(&mut rgba, w, h);
        }
        let total = rgba.len() / (w * h * 4);
        let mut regions = resolve(inp, w, h, total)?;
        for r in &mut regions {
            let frames = (r.frames.0..r.frames.1).map(|t| &rgba[t * w * h * 4..(t + 1) * w * h * 4]);
            r.bbox = bbox(frames, w, r.cell).ok_or(format!("{}: region '{}' is fully transparent", inp.path, r.name))?;
        }
        let (at, pw, ph) = pack(&regions.iter().map(|r| [r.bbox[2], r.bbox[3]]).collect::<Vec<_>>());
        regions.iter_mut().zip(at).for_each(|(r, a)| r.at = a);
        (aw, ah) = (aw.max(pw), ah.max(ph));
        let span = (
            regions.iter().map(|r| r.frames.0).min().unwrap_or(0),
            regions.iter().map(|r| r.frames.1).max().unwrap_or(0),
        );
        decoded.push((rgba, w, h, regions, span));
    }
    let (cw, ch) = (aw.next_multiple_of(16), ah.next_multiple_of(16)); // seam on a macroblock edge
    if cw > 2048 || ch * 2 > 2048 {
        eprintln!("opal: warning: coded frame {cw}x{} exceeds 2048 — some mobile H.264 decoders will refuse it. Split the sheet or downscale.", ch * 2);
    }

    // 2. Build stacked atlas frames + clip table.
    let mut raw = Vec::new();
    let mut clips = vec![];
    let mut n = 0u32;
    for (rgba, w, h, regions, (s0, s1)) in &decoded {
        for r in regions {
            clips.push(Clip {
                name: r.name.clone(),
                first: n + (r.frames.0 - s0) as u32,
                count: (r.frames.1 - r.frames.0) as u32,
                looped: !once.contains(&r.name),
                rect: [r.at[0], r.at[1], r.bbox[2], r.bbox[3]].map(|v| v as u16),
                origin: [r.bbox[0] - r.cell[0], r.bbox[1] - r.cell[1]].map(|v| v as u16),
                src: [r.cell[2], r.cell[3]].map(|v| v as u16),
            });
        }
        for t in *s0..*s1 {
            let f = &rgba[t * w * h * 4..(t + 1) * w * h * 4];
            stack(regions.iter().map(|r| Blit { src: f, src_w: *w, bbox: r.bbox, at: r.at }), (cw, ch), 3, &mut raw);
        }
        n += (s1 - s0) as u32;
    }
    let raw_mb = raw.len() as f64 / 1e6;

    // 3. Encode H.264 (no B-frames, keyframe at every input start) and repack as AVCC.
    let mut starts = vec![0u32];
    for (.., (s0, s1)) in &decoded {
        starts.push(starts.last().unwrap() + (s1 - s0) as u32);
    }
    starts.pop();
    let keys: Vec<String> = clips.iter().map(|c| c.first).chain(starts).map(|f| format!("eq(n,{f})")).collect();
    let annexb = encode(raw, cw, ch * 2, fps, crf, &keys.join("+"))?;
    let (codec, description, aus) = to_avcc(&annexb)?;
    if aus.len() != n as usize {
        return Err(format!("encoder produced {} frames, expected {n}", aus.len()));
    }

    let mut data = Vec::new();
    let frames = aus
        .into_iter()
        .map(|(key, au)| {
            let f = Frame { offset: data.len() as u32, size: au.len() as u32, key };
            data.extend_from_slice(&au);
            f
        })
        .collect();
    let opal = Opal {
        codec, description: &description,
        width: aw as u16, height: ah as u16, coded_width: cw as u16, coded_height: ch as u16,
        fps, clips, frames, data: &data,
    };
    let bytes = opal.write();
    fs::write(&out, &bytes).map_err(|e| format!("{out}: {e}"))?;
    println!(
        "{out}: {n} frames, atlas {aw}x{ah}, {} -> {:.1} KB (raw {raw_mb:.1} MB), GPU cache {:.1} MB",
        opal.codec, bytes.len() as f64 / 1024.0, (aw * ah * 4 * n as usize) as f64 / 1e6
    );
    for c in &opal.clips {
        println!("  {:<12} {:>3} frames  {}x{} (cell {}x{}){}", c.name, c.count, c.rect[2], c.rect[3], c.src[0], c.src[1], if c.looped { "" } else { "  once" });
    }
    Ok(())
}

/// Split "name@a-b" into (name, Some((a, b+1))).
fn range(s: &str, total: usize) -> Res<(String, (usize, usize))> {
    let Some((name, r)) = s.split_once('@') else { return Ok((s.into(), (0, total))) };
    let (a, b) = r.split_once('-').ok_or(format!("bad frame range '{r}' (want from-to)"))?;
    let (a, b): (usize, usize) = (a.parse().map_err(|_| "bad range")?, b.parse().map_err(|_| "bad range")?);
    if a > b || b >= total {
        return Err(format!("{name}: frame range {a}-{b} outside 0-{}", total - 1));
    }
    Ok((name.into(), (a, b + 1)))
}

fn resolve(inp: &Input, w: usize, h: usize, total: usize) -> Res<Vec<Region>> {
    let region = |name, cell, frames| Region { name, cell, frames, bbox: [0; 4], at: [0; 2] };
    let mut out = vec![];
    if let Some((cols, rows)) = inp.grid {
        let (gw, gh) = (w / cols, h / rows);
        if inp.names.len() > cols * rows {
            return Err(format!("{}: {} names for {cols}x{rows} grid", inp.path, inp.names.len()));
        }
        for (i, n) in inp.names.iter().enumerate().filter(|(_, n)| !n.is_empty()) {
            let (name, fr) = range(n, total)?;
            out.push(region(name, [i % cols * gw, i / cols * gh, gw, gh], fr));
        }
    }
    for spec in &inp.rects {
        let bad = || format!("bad --rect '{spec}' (want name=x,y,w,h)");
        let (name, rest) = spec.split_once('=').ok_or_else(bad)?;
        let (geom, fr) = match rest.split_once('@') {
            Some((g, r)) => (g, range(&format!("{name}@{r}"), total)?.1),
            None => (rest, (0, total)),
        };
        let v: Vec<usize> = geom.split(',').map(|x| x.parse().map_err(|_| bad())).collect::<Res<_>>()?;
        let [x, y, rw, rh] = v[..] else { return Err(bad()) };
        if x + rw > w || y + rh > h || rw == 0 || rh == 0 {
            return Err(format!("--rect {name}: outside {w}x{h} frame"));
        }
        out.push(region(name.into(), [x, y, rw, rh], fr));
    }
    if inp.grid.is_some() && inp.names.is_empty() {
        return Err(format!("{}: --grid needs --names", inp.path));
    }
    if out.is_empty() {
        out.push(region(inp.name.clone(), [0, 0, w, h], (0, total)));
    }
    Ok(out)
}

fn probe(p: &str) -> Res<(usize, usize, f32, String)> {
    let o = Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,r_frame_rate", "-of", "csv=p=0", p])
        .output()
        .map_err(|e| format!("ffprobe not found: {e}"))?;
    let s = String::from_utf8_lossy(&o.stdout);
    let v: Vec<&str> = s.trim().split(',').collect();
    let bad = || format!("{p}: can't probe video stream");
    if v.len() < 4 {
        return Err(bad());
    }
    let (num, den) = v[3].split_once('/').unwrap_or((v[3], "1"));
    let fps = num.parse::<f32>().map_err(|_| bad())? / den.parse::<f32>().map_err(|_| bad())?;
    Ok((v[1].parse().map_err(|_| bad())?, v[2].parse().map_err(|_| bad())?, fps, v[0].into()))
}

fn decode(p: &str, codec: &str) -> Res<Vec<u8>> {
    let mut c = Command::new("ffmpeg");
    c.args(["-v", "error"]);
    // ffmpeg's native VP8/9 decoders drop alpha; libvpx keeps it.
    match codec {
        "vp9" => c.args(["-c:v", "libvpx-vp9"]),
        "vp8" => c.args(["-c:v", "libvpx"]),
        _ => &mut c,
    };
    let o = c.args(["-i", p, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]).output().map_err(|e| format!("ffmpeg: {e}"))?;
    if !o.status.success() {
        return Err(format!("decode {p}: {}", String::from_utf8_lossy(&o.stderr)));
    }
    Ok(o.stdout)
}

fn encode(raw: Vec<u8>, w: usize, h: usize, fps: f32, crf: u32, keys: &str) -> Res<Vec<u8>> {
    let mut child = Command::new("ffmpeg")
        .args(["-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", &format!("{w}x{h}"), "-r", &fps.to_string(), "-i", "-"])
        .args(["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"])
        .args(["-c:v", "libx264", "-preset", "slow", "-crf", &crf.to_string(), "-profile:v", "high"])
        .args(["-x264-params", "aud=1:bframes=0:scenecut=0:keyint=99999:min-keyint=1"])
        .args(["-force_key_frames", &format!("expr:{keys}")])
        .args(["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"])
        .args(["-f", "h264", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg: {e}"))?;
    let mut stdin = child.stdin.take().unwrap();
    let feeder = std::thread::spawn(move || stdin.write_all(&raw));
    let o = child.wait_with_output().map_err(|e| e.to_string())?;
    let _ = feeder.join();
    if !o.status.success() {
        return Err(format!("encode: {}", String::from_utf8_lossy(&o.stderr)));
    }
    Ok(o.stdout)
}

/// Annex-B -> (codec string, avcC, [(is_key, length-prefixed access unit)]).
/// Splits on AUD; keeps only slice NALs per frame (SPS/PPS go in avcC).
fn to_avcc(b: &[u8]) -> Res<(String, Vec<u8>, Vec<(bool, Vec<u8>)>)> {
    let mut starts = vec![];
    let mut i = 0;
    while i + 3 <= b.len() {
        if b[i..i + 3] == [0, 0, 1] {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let (mut sps, mut pps, mut aus) = (None, None, Vec::<(bool, Vec<u8>)>::new());
    for (k, &s) in starts.iter().enumerate() {
        let mut e = starts.get(k + 1).map_or(b.len(), |&n| n - 3);
        while e > s && b[e - 1] == 0 {
            e -= 1; // NALs never end in 0x00; these are the next start code's leading zero
        }
        let nal = &b[s..e];
        match nal.first().map(|h| h & 0x1f) {
            Some(9) => aus.push((false, vec![])),
            Some(7) => { sps.get_or_insert(nal); }
            Some(8) => { pps.get_or_insert(nal); }
            Some(t @ (1 | 5)) => {
                let au = aus.last_mut().ok_or("slice before first AUD")?;
                au.0 |= t == 5;
                au.1.extend_from_slice(&(nal.len() as u32).to_be_bytes());
                au.1.extend_from_slice(nal);
            }
            _ => {} // SEI etc.
        }
    }
    let (sps, pps) = (sps.ok_or("no SPS")?, pps.ok_or("no PPS")?);
    let codec = format!("avc1.{:02x}{:02x}{:02x}", sps[1], sps[2], sps[3]);
    let mut d = vec![1, sps[1], sps[2], sps[3], 0xff, 0xe1];
    d.extend_from_slice(&(sps.len() as u16).to_be_bytes());
    d.extend_from_slice(sps);
    d.push(1);
    d.extend_from_slice(&(pps.len() as u16).to_be_bytes());
    d.extend_from_slice(pps);
    Ok((codec, d, aus))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(range("walk@2-5", 10).unwrap(), ("walk".into(), (2, 6)));
        assert_eq!(range("walk", 10).unwrap(), ("walk".into(), (0, 10)));
        assert!(range("walk@5-10", 10).is_err());
    }
}
