// Opal web runtime glue. Rust/wasm owns the format + sprite state; this file
// only drives WebCodecs (hardware decode) and WebGL2 (one instanced draw per asset).
//
// Model: each asset is decoded ONCE at load into an RGBA texture array
// (one layer per frame, premultiplied). Playback is then just texture lookups.
// Every clip is a sub-rect of the layer (an atlas), so one sheet = one texture.

const VS_BLIT = `#version 300 es
void main(){ vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1) * 4.0 - 1.0; gl_Position = vec4(p, 0, 1); }`;

// Recombine stacked color/alpha into one premultiplied RGBA layer, optionally downscaled.
const FS_BLIT = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 dst;   // layer size in px
uniform vec2 vis;   // visible atlas size / decoded frame size (uv extent of the color half)
out vec4 o;
void main(){
  vec2 uv = gl_FragCoord.xy / dst * vis;
  vec3 c = texture(src, uv).rgb;
  float a = texture(src, uv + vec2(0.0, 0.5)).r;
  a = clamp((a - 0.01) / 0.98, 0.0, 1.0); // eat codec noise around 0 and 1
  o = vec4(c * a, a);
}`;

const VS_SPRITE = `#version 300 es
layout(location=0) in vec4 rect; layout(location=1) in vec4 uvr; layout(location=2) in vec2 lo;
uniform vec2 res;
out vec3 uvw; out float op;
void main(){
  vec2 k = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  vec2 p = (rect.xy + k * rect.zw) / res * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0, 1);
  uvw = vec3(uvr.xy + k * uvr.zw, lo.x); op = lo.y;
}`;

const FS_SPRITE = `#version 300 es
precision mediump float; precision mediump sampler2DArray;
uniform sampler2DArray tex;
in vec3 uvw; in float op; out vec4 o;
void main(){ o = texture(tex, uvw) * op; }`;

const STRIDE = 10 * 4; // x y w h | u v uw vh | layer opacity

export async function createOpal(canvas, wasmUrl = new URL('opal.wasm', import.meta.url)) {
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
  const blit = program(gl, VS_BLIT, FS_BLIT, ['dst', 'vis']);
  const sprite = program(gl, VS_SPRITE, FS_SPRITE, ['res']);
  const scratch = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, scratch);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  const assets = [];

  // opts.scale: store frames at this fraction of encoded size (0.5 = 1/4 VRAM). Good mobile lever.
  // opts.mipmaps: +33% VRAM, but keep on: sprites drawn smaller than authored are
  //   both crisper and FASTER with mips (no texture-cache thrash). Measured.
  async function load(url, { scale = 1, mipmaps = true } = {}) {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const ptr = w.opal_alloc(bytes.length);
    u8(ptr, bytes.length).set(bytes);
    const id = w.opal_load(ptr, bytes.length);
    if (id < 0) throw new Error(`${url}: not a valid .opal file`);

    const aw = w.opal_width(id), ah = w.opal_height(id), n = w.opal_frame_count(id);
    const lw = Math.max(1, Math.round(aw * scale)), lh = Math.max(1, Math.round(ah * scale));
    const max = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
    // ponytail: one texture array per asset; split across arrays if a sheet exceeds this.
    if (n > max) throw new Error(`${url}: ${n} frames > MAX_ARRAY_TEXTURE_LAYERS ${max}`);

    const levels = mipmaps ? Math.floor(Math.log2(Math.max(lw, lh))) + 1 : 1;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, lw, lh, n);

    const config = { codec: str(w.opal_codec_ptr(id), w.opal_codec_len(id)), optimizeForLatency: true };
    if (w.opal_desc_len(id)) config.description = u8(w.opal_desc_ptr(id), w.opal_desc_len(id)).slice();
    if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error(`${url}: codec ${config.codec} unsupported`);

    let layer = 0, err = null;
    const dec = new VideoDecoder({
      output(frame) {
        gl.bindTexture(gl.TEXTURE_2D, scratch);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        const vis = [aw / frame.displayWidth, ah / frame.displayHeight];
        frame.close();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, layer++);
        gl.viewport(0, 0, lw, lh);
        gl.useProgram(blit);
        gl.uniform2f(blit.u.dst, lw, lh);
        gl.uniform2f(blit.u.vis, vis[0], vis[1]);
        gl.disable(gl.BLEND);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
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
    if (err || layer !== n) throw new Error(`${url}: decode failed (${layer}/${n}) ${err ?? ''}`);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null); // drop the last frame's scratch storage reference

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const vao = gl.createVertexArray(), buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    for (const [loc, size, off] of [[0, 4, 0], [1, 4, 16], [2, 2, 32]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE, off);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);

    const clips = {};
    for (let c = 0; c < w.opal_clip_count(id); c++) {
      clips[str(w.opal_clip_name_ptr(id, c), w.opal_clip_name_len(id, c))] = {
        index: c, frames: w.opal_clip_frames(id, c), width: w.opal_clip_w(id, c), height: w.opal_clip_h(id, c),
      };
    }
    const vram = lw * lh * 4 * n * (mipmaps ? 4 / 3 : 1);
    const a = { id, tex, vao, buf, clips, frames: n, atlas: [aw, ah], layer: [lw, lh], vram, bytes: bytes.length };
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
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(w.memory.buffer, w.opal_batch_ptr(a.id) >>> 0, len), gl.STREAM_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, len / 10);
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
