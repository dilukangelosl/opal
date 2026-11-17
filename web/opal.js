// Opal web runtime glue. Rust/wasm owns the format + sprite state; this file
// only drives WebCodecs (hardware decode) and WebGL2 (one instanced draw per asset).
//
// Model: each asset is decoded ONCE at load. Every (clip, frame) visible box is
// shelf-packed into square RGBA pages (one texture array layer each, premultiplied),
// so GPU memory is what the frames actually cover, not atlas × frames, and the
// layer count stays tiny (some phone GPUs allow only 256). Playback is then just
// texture lookups: each sprite is the frame's octagon (box minus its corner cuts,
// v4 files), which skips most of the fully transparent pixels a quad would shade.

const VS_BLIT = `#version 300 es
void main(){ vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1) * 4.0 - 1.0; gl_Position = vec4(p, 0, 1); }`;

// Recombine stacked color/alpha into one premultiplied RGBA cell, optionally downscaled.
const FS_BLIT = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec4 srcr;  // source rect in the decoded frame, uv (colour half)
uniform vec4 dst;   // destination cell in the page, px (= the viewport)
out vec4 o;
void main(){
  vec2 uv = srcr.xy + (gl_FragCoord.xy - dst.xy) / dst.zw * srcr.zw;
  vec3 c = texture(src, uv).rgb;
  float a = texture(src, uv + vec2(0.0, 0.5)).r;
  a = clamp((a - 0.01) / 0.98, 0.0, 1.0); // eat codec noise around 0 and 1
  o = vec4(c * a, a);
}`;

// Octagon per instance: the frame box with its four corners cut (cut = px along each edge,
// already scaled). Vertex order is a fan from the top-left cut, clockwise.
const VS_SPRITE = `#version 300 es
layout(location=0) in vec4 rect; layout(location=1) in vec4 uvr; layout(location=2) in vec2 lo; layout(location=3) in vec4 cut;
uniform vec2 res;
out vec3 uvw; out float op;
void main(){
  vec2 s = abs(rect.zw);
  vec4 cx = cut / s.x, cy = cut / s.y; // cuts as fractions of the box (tl, tr, br, bl)
  int v = gl_VertexID; vec2 k;
  if (v == 0) k = vec2(cx.x, 0.0); else if (v == 1) k = vec2(1.0 - cx.y, 0.0); else if (v == 2) k = vec2(1.0, cy.y);
  else if (v == 3) k = vec2(1.0, 1.0 - cy.z); else if (v == 4) k = vec2(1.0 - cx.z, 1.0); else if (v == 5) k = vec2(cx.w, 1.0);
  else if (v == 6) k = vec2(0.0, 1.0 - cy.w); else k = vec2(0.0, cy.x);
  vec2 p = (rect.xy + k * rect.zw) / res * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0, 1);
  uvw = vec3(uvr.xy + k * uvr.zw, lo.x); op = lo.y;
}`;

const FS_SPRITE = `#version 300 es
precision mediump float; precision mediump sampler2DArray;
uniform sampler2DArray tex;
in vec3 uvw; in float op; out vec4 o;
void main(){ o = texture(tex, uvw) * op; }`;

const STRIDE = 14 * 4; // x y w h | u v uw vh | layer opacity | cut tl tr br bl
const PAD = 4; // transparent gutter between cells: mip level 2 still can't bleed a neighbour in
// Phones: trilinear sampling costs 2x on Mali (Arm's guide), so default to the cheaper mip filter there.
const MOBILE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

// Licence footprint: one console line and a data-opal attribute on <html>. The fingerprint string is used at runtime,
// so it survives minification and shows up in every bundle that ships Opal (searchable in HTTP Archive, grep.app…).
// A commercial licensee names its grant in the page: <meta name="opal-license" content="OPAL-COM-…">.
// Self-contained on purpose (web/opal.js runs on its own); same logic as packages/opal-sprites/src/mark.js.
const OPAL_FP = 'opal-fp-7d1a6e0c';
function opalMark() {
  if (typeof document === 'undefined' || document.documentElement.hasAttribute('data-opal')) return;
  const license = document.querySelector('meta[name="opal-license"]')?.getAttribute('content')?.trim() || '';
  document.documentElement.setAttribute('data-opal', OPAL_FP);
  if (license) document.documentElement.setAttribute('data-opal-license', license);
  console.info(license
    ? `Opal video sprites (${OPAL_FP}) · commercial license ${license}`
    : `Opal video sprites (${OPAL_FP}) · PolyForm Noncommercial license · commercial license from US$1,000, full source access: dilukangelo@gmail.com`);
}

// Shelf-pack cells (tallest first) into size×size pages; sets cell.x/y/layer, returns the page count.
function shelf(cells, size) {
  let x = 0, y = 0, row = 0, layer = 0;
  for (const k of [...cells].sort((a, b) => b.h - a.h)) {
    if (x + k.w > size) { x = 0; y = (y + row + PAD + 3) & ~3; row = 0; }
    if (y + k.h > size) { x = 0; y = 0; row = 0; layer++; }
    Object.assign(k, { x, y, layer });
    x = (x + k.w + PAD + 3) & ~3; row = Math.max(row, k.h); // 4 px aligned: mip levels 1-2 see each cell on its own grid
  }
  return layer + 1;
}

export async function createOpal(canvas, wasmUrl = new URL('opal.wasm', import.meta.url)) {
  opalMark();
  const res = await fetch(wasmUrl);
  const { instance } = await WebAssembly.instantiate(await res.arrayBuffer());
  const w = instance.exports;
  const u8 = (ptr, len) => new Uint8Array(w.memory.buffer, ptr >>> 0, len); // re-view: memory may grow
  const str = (ptr, len) => new TextDecoder().decode(u8(ptr, len));

  const gl = canvas.getContext('webgl2', {
    premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
    powerPreference: 'high-performance', desynchronized: true,
  });
  if (!gl) throw new Error('WebGL2 unavailable');
  if (!('VideoDecoder' in self)) throw new Error('WebCodecs unavailable (needs https + modern browser)');
  const blit = program(gl, VS_BLIT, FS_BLIT, ['srcr', 'dst']);
  const sprite = program(gl, VS_SPRITE, FS_SPRITE, ['res']);
  const scratch = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, scratch);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  const assets = [];
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE), maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);

  // opts.scale: store frames at this fraction of encoded size (0.5 = 1/4 VRAM). Good mobile lever.
  // opts.mipmaps: +33% VRAM, but keep on: sprites drawn smaller than authored are
  //   both crisper and FASTER with mips (no texture-cache thrash). Measured.
  // opts.filter: 'trilinear' (blends two mip levels; the desktop default) or 'bilinear' (nearest mip:
  //   half the sampling cost on phones, the default there; a little shimmer when a sprite scales
  //   through a mip boundary).
  async function load(url, { scale = 1, mipmaps = true, filter = MOBILE ? 'bilinear' : 'trilinear' } = {}) {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const ptr = w.opal_alloc(bytes.length);
    u8(ptr, bytes.length).set(bytes);
    const id = w.opal_load(ptr, bytes.length);
    if (id < 0) throw new Error(`${url}: not a valid .opal file`);
    const aw = w.opal_width(id), ah = w.opal_height(id), n = w.opal_frame_count(id);

    // one cell per (clip, frame) with a visible box, at `scale`; byFrame lists the cells each decoded frame feeds
    const cells = [], byFrame = Array.from({ length: n }, () => []);
    for (let c = 0; c < w.opal_clip_count(id); c++) {
      const first = w.opal_clip_first(id, c), [rx, ry] = [w.opal_clip_rect(id, c, 0), w.opal_clip_rect(id, c, 1)];
      for (let f = 0, count = w.opal_clip_frames(id, c); f < count; f++) {
        const [bx, by, bw, bh] = [0, 1, 2, 3].map((i) => w.opal_clip_frame_box(id, c, f, i));
        if (!bw || !bh) continue; // fully transparent frame: nothing to store
        const k = { c, f, sx: rx + bx, sy: ry + by, sw: bw, sh: bh, w: Math.max(1, Math.round(bw * scale)), h: Math.max(1, Math.round(bh * scale)) };
        cells.push(k); byFrame[first + f].push(k);
      }
    }
    // page size: the candidate that packs these cells into the least memory (small pages waste the
    // gaps around big cells, big pages waste most of the last page), within the GPU's layer limit
    const maxDim = Math.max(1, ...cells.map((k) => Math.max(k.w, k.h)));
    let size = 0, pages = 0, best = Infinity;
    for (const s of [256, 384, 512, 768, 1024, 1536, 2048, 4096].filter((s) => s >= maxDim && s <= maxTex)) {
      const n = shelf(cells, s);
      if (n <= maxLayers && s * s * n < best) { [size, pages, best] = [s, n, s * s * n]; }
    }
    if (!size) throw new Error(`${url}: frames too large for this GPU (${maxDim} px)`);
    pages = shelf(cells, size); // lay out at the chosen size

    const levels = mipmaps ? Math.floor(Math.log2(size)) + 1 : 1;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, size, size, pages); // zero-filled per the WebGL spec

    const config = { codec: str(w.opal_codec_ptr(id), w.opal_codec_len(id)), optimizeForLatency: true };
    if (w.opal_desc_len(id)) config.description = u8(w.opal_desc_ptr(id), w.opal_desc_len(id)).slice();
    if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error(`${url}: codec ${config.codec} unsupported`);

    let got = 0, err = null;
    const dec = new VideoDecoder({
      output(frame) {
        gl.bindTexture(gl.TEXTURE_2D, scratch);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        const fw = frame.displayWidth, fh = frame.displayHeight; // stacked: colour top, alpha below
        frame.close();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.useProgram(blit);
        gl.disable(gl.BLEND);
        for (const k of byFrame[got] ?? []) {
          gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, k.layer);
          gl.viewport(k.x, k.y, k.w, k.h);
          gl.uniform4f(blit.u.dst, k.x, k.y, k.w, k.h);
          gl.uniform4f(blit.u.srcr, k.sx / fw, k.sy / fh, k.sw / fw, k.sh / fh);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        got++;
      },
      error: (e) => (err = e),
    });
    dec.configure(config);
    for (let i = 0; i < n; i++) {
      dec.decode(new EncodedVideoChunk({
        type: w.opal_frame_key(id, i) ? 'key' : 'delta',
        timestamp: i,
        data: u8(w.opal_frame_ptr(id, i), w.opal_frame_size(id, i)),
      }));
    }
    await dec.flush();
    dec.close();
    if (err || got !== n) throw new Error(`${url}: decode failed (${got}/${n}) ${err ?? ''}`);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null); // drop the last frame's scratch storage reference

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    const minFilter = !mipmaps ? gl.LINEAR : filter === 'bilinear' ? gl.LINEAR_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_LINEAR;
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // tell the core where every frame landed; its batches address these cells from now on
    w.opal_set_page(id, size);
    for (const k of cells) w.opal_set_cell(id, k.c, k.f, k.layer, k.x, k.y, k.w, k.h);

    const vao = gl.createVertexArray(), buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    for (const [loc, size, off] of [[0, 4, 0], [1, 4, 16], [2, 2, 32], [3, 4, 40]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE, off);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);

    const clips = {};
    for (let c = 0; c < w.opal_clip_count(id); c++) {
      clips[str(w.opal_clip_name_ptr(id, c), w.opal_clip_name_len(id, c))] = {
        index: c, frames: w.opal_clip_frames(id, c), width: w.opal_clip_w(id, c), height: w.opal_clip_h(id, c),
        // visible part inside the cell (x, y, w, h): e.g. feet = box[1] + box[3] for ground anchoring
        box: [0, 1, 2, 3].map((i) => w.opal_clip_box(id, c, i)),
      };
    }
    const vram = size * size * 4 * pages * (mipmaps ? 4 / 3 : 1);
    const a = { id, tex, vao, buf, cap: 0, clips, frames: n, pages, fps: w.opal_fps(id), atlas: [aw, ah], layer: [size, size], vram, bytes: bytes.length };
    assets.push(a);
    return a;
  }

  const clipIndex = (a, clip) => {
    const c = a.clips[clip];
    if (!c) throw new Error(`unknown clip '${clip}' (have: ${Object.keys(a.clips).join(', ')})`);
    return c.index;
  };

  // Draw every asset in load order. Call once per rAF with dt in seconds.
  function render(dt) {
    w.opal_tick(dt);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(sprite);
    gl.uniform2f(sprite.u.res, canvas.width, canvas.height);
    for (const a of assets) {
      const len = w.opal_batch_len(a.id);
      if (!len) continue;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, a.tex);
      gl.bindVertexArray(a.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, a.buf);
      const batch = new Float32Array(w.memory.buffer, w.opal_batch_ptr(a.id) >>> 0, len);
      if (len > a.cap) {
        a.cap = Math.max(len, a.cap * 2); // grow once, then stream into the same store
        gl.bufferData(gl.ARRAY_BUFFER, a.cap * 4, gl.STREAM_DRAW);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch);
      gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 8, len / 14);
    }
    gl.bindVertexArray(null);
  }

  return {
    gl,
    load,
    render,
    spawn: (a, clip, x, y, scale = 1) => w.opal_spawn(a.id, clipIndex(a, clip), x, y, scale),
    set: (id, x, y, scale = 1, opacity = 1) => w.opal_set(id, x, y, scale, opacity),
    play: (a, id, clip) => w.opal_play(id, clipIndex(a, clip)),
    done: (id) => !!w.opal_done(id),
    speed: (id, s) => w.opal_speed(id, s),
    progress: (id) => w.opal_progress(id),
    kill: (id) => w.opal_kill(id),
  };
}

function program(gl, vs, fs, uniforms) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  p.u = Object.fromEntries(uniforms.map((n) => [n, gl.getUniformLocation(p, n)]));
  return p;
}
