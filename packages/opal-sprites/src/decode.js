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

// Turns a decoded stacked frame (colour on top, alpha as luma below) into premultiplied RGBA on the GPU,
// so the main thread never loops over pixels. One shared context for every decode on the page.
let merger;
function getMerger() {
  if (merger !== undefined) return merger;
  merger = null;
  try {
    if (typeof OffscreenCanvas !== 'function') return merger;
    const cv = new OffscreenCanvas(1, 1), gl = cv.getContext('webgl2', { premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) return merger;
    const sh = (t, src) => { const x = gl.createShader(t); gl.shaderSource(x, src); gl.compileShader(x); return x; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}'));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float; uniform sampler2D t; uniform vec2 size; out vec4 o;
void main(){ vec2 uv = vec2(gl_FragCoord.x / size.x, 1.0 - gl_FragCoord.y / size.y);
  vec3 c = texture(t, vec2(uv.x, uv.y * 0.5)).rgb;
  float a = clamp((texture(t, vec2(uv.x, 0.5 + uv.y * 0.5)).r - 0.01) / 0.98, 0.0, 1.0);
  o = vec4(c * a, a); }`));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return merger;
    gl.useProgram(pr);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const uSize = gl.getUniformLocation(pr, 'size');
    merger = {
      canvas: cv,
      /** draws `frame`'s colour × alpha into the canvas (w×h = the colour half) */
      merge(frame, w, h) {
        if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
        gl.viewport(0, 0, w, h);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        gl.uniform2f(uSize, w, h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
    };
  } catch { merger = null; }
  return merger;
}

/**
 * Decode every clip of an .opal file into RGBA frames packed onto a few pages.
 *
 * Memory: each page is trimmed to the area it uses, and with `bitmaps: true` a page becomes an ImageBitmap as soon
 * as its last frame is in, and its canvas is released. Only ~1 page per file is a canvas at any moment then, which
 * keeps mobile Safari under its canvas-memory limit (over it, iOS reloads the tab).
 * @param {string|URL|ArrayBuffer|Uint8Array} src
 * @param {{ scale?: number, pageSize?: number, bitmaps?: boolean }} [opts] scale < 1 stores frames smaller (less memory)
 * @returns {Promise<{ fps: number, scale: number, pages: (HTMLCanvasElement|ImageBitmap)[], clips: Record<string, DecodedClip> }>}
 */
// Licence footprint: one console line and a data-opal attribute on <html>. The fingerprint string is used at runtime,
// so it survives minification and shows up in every bundle that ships Opal (searchable in HTTP Archive, grep.app…).
const OPAL_FP = 'opal-fp-7d1a6e0c';
function opalMark() {
  if (typeof document === 'undefined' || document.documentElement.hasAttribute('data-opal')) return;
  document.documentElement.setAttribute('data-opal', OPAL_FP);
  console.info(`Opal video sprites (${OPAL_FP}) · PolyForm Noncommercial license · commercial use: dilukangelo@gmail.com`);
}

export async function decodeOpal(src, { scale = 1, pageSize = 2048, bitmaps = false } = {}) {
  opalMark();
  if (!('VideoDecoder' in globalThis)) throw new Error('opal: WebCodecs is unavailable (needs https and Chrome, Edge, Firefox desktop or Safari 26+)');
  const buf = typeof src === 'string' || src instanceof URL ? await (await fetch(src)).arrayBuffer() : src;
  const o = parseOpal(buf);

  const config = { codec: o.codec, optimizeForLatency: true };
  if (o.description.length) config.description = o.description;
  if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error(`opal: codec ${o.codec} unsupported here`);

  // layout first: shelf-pack every (clip, frame) cell at its scaled size; a page is only created when it's written
  const layout = [];
  let cur = null, px = 0, py = 0, row = 0;
  const alloc = (w, h) => {
    if (!cur || px + w > pageSize) { px = 0; py += row; row = 0; }
    if (!cur || py + h > pageSize) { cur = { w: 1, h: 1, left: 0 }; layout.push(cur); px = py = row = 0; }
    const at = { page: layout.length - 1, x: px, y: py, w, h };
    cur.w = Math.max(cur.w, px + w); cur.h = Math.max(cur.h, py + h); cur.left++;
    px += w + 2; row = Math.max(row, h + 2);
    return at;
  };
  const clips = {};
  for (const c of o.clips) {
    const w = Math.max(1, Math.round(c.rect[2] * scale)), h = Math.max(1, Math.round(c.rect[3] * scale));
    if (w > pageSize || h > pageSize) throw new Error(`opal: clip ${c.name} is larger than pageSize`);
    clips[c.name] = { ...c, frames: Array.from({ length: c.count }, () => alloc(w, h)) };
  }
  const pages = new Array(layout.length).fill(null), open = [], done = [];
  const pageCtx = (i) => {
    if (!open[i]) {
      const cv = document.createElement('canvas'); cv.width = layout[i].w; cv.height = layout[i].h;
      open[i] = cv.getContext('2d'); pages[i] = cv;
    }
    return open[i];
  };
  const finish = (i) => {
    const cv = pages[i];
    if (!bitmaps) { open[i] = null; return; }
    done.push(createImageBitmap(cv).then((bm) => { pages[i] = bm; cv.width = cv.height = 0; })); // free the canvas backing store
    open[i] = null;
  };

  const fw = o.codedWidth, fh = o.codedHeight * 2, gpu = getMerger();
  const grab = gpu ? null : new OffscreenCanvas(fw, fh), gctx = grab && grab.getContext('2d', { willReadFrequently: true });
  const cell = new OffscreenCanvas(1, 1), cctx = cell.getContext('2d');
  let index = 0, failure = null;
  const decoder = new VideoDecoder({
    output(frame) {
      try {
        const i = index++;
        if (gpu) gpu.merge(frame, fw, o.codedHeight); else gctx.drawImage(frame, 0, 0, fw, fh);
        for (const c of Object.values(clips)) {
          if (i < c.first || i >= c.first + c.count) continue;
          const [x, y, w, h] = c.rect, at = c.frames[i - c.first], ctx = pageCtx(at.page);
          if (gpu) {
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(gpu.canvas, x, y, w, h, at.x, at.y, at.w, at.h);
          } else {
            const color = gctx.getImageData(x, y, w, h), alpha = gctx.getImageData(x, y + o.codedHeight, w, h);
            const d = color.data, a = alpha.data;
            for (let k = 3; k < d.length; k += 4) d[k] = Math.max(0, Math.min(255, ((a[k - 3] - 2.55) / 0.98) | 0)); // alpha lives in the lower half's luma
            if (at.w === w && at.h === h) ctx.putImageData(color, at.x, at.y);
            else { cell.width = w; cell.height = h; cctx.putImageData(color, 0, 0); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(cell, at.x, at.y, at.w, at.h); }
          }
          if (--layout[at.page].left === 0) finish(at.page);
        }
      } catch (e) { failure = e; } finally { frame.close(); }
    },
    error: (e) => (failure = e),
  });
  decoder.configure(config);
  o.frames.forEach((f, i) => decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: i, data: o.data.subarray(f.offset, f.offset + f.size) })));
  await decoder.flush();
  decoder.close();
  await Promise.all(done);
  if (failure) throw failure;
  if (index !== o.frames.length) throw new Error(`opal: decoded ${index} of ${o.frames.length} frames`);
  return { fps: o.fps, scale, pages, clips };
}
