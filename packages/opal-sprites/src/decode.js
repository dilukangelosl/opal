// .opal parsing and decoding to plain RGBA canvases, for renderers other than
// Opal's own (PixiJS, three.js, Canvas2D…). Mirrors crates/opal-format (v2).
// Decoding uses the browser's hardware H.264 decoder (WebCodecs).

const MAGIC = [0x4f, 0x50, 0x41, 0x4c]; // "OPAL"

/** Parse an .opal file. Throws on anything malformed (treat files as untrusted). */
export function parseOpal(buffer) {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0;
  const need = (n) => { if (p + n > b.length) throw new Error('opal: truncated file'); };
  const u8 = () => (need(1), b[p++]);
  const u16 = () => (need(2), (p += 2), v.getUint16(p - 2, true));
  const u32 = () => (need(4), (p += 4), v.getUint32(p - 4, true));
  const bytes = (n) => (need(n), (p += n), b.subarray(p - n, p));
  const str = (n) => new TextDecoder().decode(bytes(n));

  if (MAGIC.some((m, i) => b[i] !== m)) throw new Error('opal: not an .opal file');
  p = 4;
  const version = u16();
  if (version !== 2) throw new Error(`opal: unsupported version ${version}`);
  if (!(u16() & 1)) throw new Error('opal: unsupported layout');
  const [width, height, codedWidth, codedHeight] = [u16(), u16(), u16(), u16()];
  need(4); const fps = v.getFloat32(p, true); p += 4;
  const codec = str(u8());
  const description = bytes(u32()).slice();
  const clips = [];
  for (let i = 0, n = u16(); i < n; i++) {
    const name = str(u8());
    const first = u32(), count = u32(), loop = u8() !== 0;
    const rect = [u16(), u16(), u16(), u16()], origin = [u16(), u16()], src = [u16(), u16()];
    clips.push({ name, first, count, loop, rect, origin, src });
  }
  const frames = [];
  let offset = 0;
  for (let i = 0, n = u32(); i < n; i++) {
    const size = u32(), key = u8() !== 0;
    frames.push({ offset, size, key });
    offset += size;
  }
  const data = b.subarray(p);
  if (offset > data.length || !(fps > 0) || !width || !height || width > codedWidth || height > codedHeight) throw new Error('opal: corrupt header');
  for (const c of clips) {
    if (!c.count || c.first + c.count > frames.length || c.rect[0] + c.rect[2] > width || c.rect[1] + c.rect[3] > height) throw new Error(`opal: corrupt clip ${c.name}`);
  }
  return { version, width, height, codedWidth, codedHeight, fps, codec, description, clips, frames, data };
}

/**
 * Decode every clip of an .opal file into RGBA frames packed onto a few canvas pages.
 * @param {string|URL|ArrayBuffer|Uint8Array} src
 * @param {{ scale?: number, pageSize?: number }} [opts] scale < 1 stores frames smaller (less memory)
 * @returns {Promise<{ fps: number, scale: number, pages: HTMLCanvasElement[], clips: Record<string, DecodedClip> }>}
 */
export async function decodeOpal(src, { scale = 1, pageSize = 2048 } = {}) {
  if (!('VideoDecoder' in globalThis)) throw new Error('opal: WebCodecs is unavailable (needs https and Chrome, Edge, Firefox desktop or Safari 26+)');
  const buf = typeof src === 'string' || src instanceof URL ? await (await fetch(src)).arrayBuffer() : src;
  const o = parseOpal(buf);

  const config = { codec: o.codec, optimizeForLatency: true };
  if (o.description.length) config.description = o.description;
  if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error(`opal: codec ${o.codec} unsupported here`);

  // pages: shelf-pack every (clip, frame) cell at its scaled size
  const pages = [];
  let page = null, px = 0, py = 0, row = 0;
  const alloc = (w, h) => {
    if (!page || px + w > pageSize) { px = 0; py += row; row = 0; }
    if (!page || py + h > pageSize) {
      page = document.createElement('canvas'); page.width = page.height = pageSize;
      pages.push(page); px = py = row = 0;
    }
    const at = { page: pages.length - 1, x: px, y: py, w, h };
    px += w + 2; row = Math.max(row, h + 2);
    return at;
  };
  const clips = {};
  for (const c of o.clips) {
    const w = Math.max(1, Math.round(c.rect[2] * scale)), h = Math.max(1, Math.round(c.rect[3] * scale));
    if (w > pageSize || h > pageSize) throw new Error(`opal: clip ${c.name} is larger than pageSize`);
    clips[c.name] = { ...c, frames: Array.from({ length: c.count }, () => alloc(w, h)) };
  }

  const fw = o.codedWidth, fh = o.codedHeight * 2;
  const grab = new OffscreenCanvas(fw, fh), gctx = grab.getContext('2d', { willReadFrequently: true });
  const cell = new OffscreenCanvas(1, 1), cctx = cell.getContext('2d');
  let index = 0, failure = null;
  const decoder = new VideoDecoder({
    output(frame) {
      try {
        gctx.drawImage(frame, 0, 0, fw, fh);
        const i = index++;
        for (const c of Object.values(clips)) {
          if (i < c.first || i >= c.first + c.count) continue;
          const [x, y, w, h] = c.rect;
          const color = gctx.getImageData(x, y, w, h), alpha = gctx.getImageData(x, y + o.codedHeight, w, h);
          const d = color.data, a = alpha.data;
          for (let k = 3; k < d.length; k += 4) d[k] = Math.max(0, Math.min(255, ((a[k - 3] - 2.55) / 0.98) | 0)); // alpha lives in the lower half's luma
          const at = c.frames[i - c.first], ctx = pages[at.page].getContext('2d');
          if (at.w === w && at.h === h) ctx.putImageData(color, at.x, at.y);
          else { cell.width = w; cell.height = h; cctx.putImageData(color, 0, 0); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(cell, at.x, at.y, at.w, at.h); }
        }
      } catch (e) { failure = e; } finally { frame.close(); }
    },
    error: (e) => (failure = e),
  });
  decoder.configure(config);
  o.frames.forEach((f, i) => decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: i, data: o.data.subarray(f.offset, f.offset + f.size) })));
  await decoder.flush();
  decoder.close();
  if (failure) throw failure;
  if (index !== o.frames.length) throw new Error(`opal: decoded ${index} of ${o.frames.length} frames`);
  return { fps: o.fps, scale, pages, clips };
}
