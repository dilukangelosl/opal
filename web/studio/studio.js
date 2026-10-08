// Opal Studio: videos in, .opal out. Pixel work (keying, trim, pack, stack,
// container) runs in the same Rust code as the `opal` CLI (wasm). The browser
// decodes via <video> and encodes H.264 via WebCodecs VideoEncoder.
import init, { Project, detect_keys, key_frame } from './pkg/opal_studio.js';
import { createOpal } from '../opal.js';

await init();

const $ = (s) => document.querySelector(s);
const HUES = ['#6ee7c8', '#b69cff', '#6cb8ff', '#ffb38a', '#ff8fb8', '#e8e27a'];
const once = (el, ev) => new Promise((r) => el.addEventListener(ev, r, { once: true }));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
let uid = 0;

const state = {
  sources: [], clips: [],
  srcId: null, clipId: null, frame: 0,
  playing: false, picking: false, showKey: true,
  processed: null, processedSig: '',
  ref: null, // { el, w, h }
  pv: { scale: 1, x: 640, y: 360, w: 1280, h: 720, mode: 'src', t: 0 },
  runtime: null, // { opal, asset, ids }
  exported: null,
};
const src = () => state.sources.find((s) => s.id === state.srcId);
const clip = () => state.clips.find((c) => c.id === state.clipId);

// ---------- frame grabbing (serialised: one <video> per source, seeks must not overlap)
const grabCv = document.createElement('canvas');
const grabCtx = grabCv.getContext('2d', { willReadFrequently: true });
let lock = Promise.resolve();
function grab(s, i) {
  const p = lock.then(async () => {
    const v = s.video, t = (i + 0.5) / s.fps;
    if (Math.abs(v.currentTime - t) > 1e-4) { v.currentTime = t; await once(v, 'seeked'); }
    return snap(s);
  });
  lock = p.catch(() => {});
  return p;
}
function snap(s) {
  if (grabCv.width !== s.w || grabCv.height !== s.h) { grabCv.width = s.w; grabCv.height = s.h; }
  grabCtx.clearRect(0, 0, s.w, s.h);
  grabCtx.drawImage(s.video, 0, 0);
  return grabCtx.getImageData(0, 0, s.w, s.h);
}

function keysOf(s) {
  const k = s.key;
  if (k.mode === 'auto' && k.detected) return k.detected;
  if (k.mode === 'custom' && k.colors.length) return Uint8Array.from(k.colors.flat());
  return null;
}
function applyKey(s, px, w, h) {
  const keys = keysOf(s);
  if (keys) key_frame(px, w, h, keys, s.key.tol, s.key.soft, s.key.despill, s.key.speck);
}

// ---------- sources
async function addSource(file) {
  const url = URL.createObjectURL(file);
  const video = Object.assign(document.createElement('video'), { src: url, muted: true, playsInline: true, preload: 'auto' });
  try {
    await Promise.race([once(video, 'loadeddata'), once(video, 'error').then(() => { throw new Error() })]);
  } catch {
    return setStatus(`${file.name}: this browser can't play that file. Try MP4 (H.264) or WebM.`, true);
  }
  const fps = await detectFps(video);
  const s = {
    id: ++uid, name: file.name.replace(/\.[^.]+$/, ''), video, w: video.videoWidth, h: video.videoHeight, fps,
    frames: Math.max(1, Math.floor(video.duration * fps + 0.01)),
    key: { mode: 'off', colors: [], detected: null, msg: '', tol: 30, soft: 20, despill: 1, speck: 16 },
  };
  state.sources.push(s);
  if (!$('#xFps').value) $('#xFps').value = fps;
  newClip(s, uniqueName(s.name), [0, 0, s.w, s.h], 0, s.frames - 1);
  selectSource(s.id);
}

function detectFps(v) {
  const snapTo = (f) => {
    const near = [12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60].reduce((a, c) => (Math.abs(c - f) < Math.abs(a - f) ? c : a));
    return Math.abs(near - f) / near < 0.03 ? near : Math.round(f);
  };
  if (!('requestVideoFrameCallback' in v)) return Promise.resolve(30);
  return new Promise((res) => {
    const times = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      v.pause();
      const d = times.slice(1).map((t, i) => t - times[i]).filter((x) => x > 0).sort((a, b) => a - b);
      res(d.length ? snapTo(1 / d[d.length >> 1]) : 30);
    };
    const cb = (_, meta) => { times.push(meta.mediaTime); times.length < 14 && !v.ended ? v.requestVideoFrameCallback(cb) : finish(); };
    v.requestVideoFrameCallback(cb);
    v.play().catch(finish);
    setTimeout(finish, 2000);
  }).then(async (fps) => { v.currentTime = 0; await once(v, 'seeked'); return fps; });
}

function selectSource(id) {
  state.srcId = id;
  const s = src();
  state.frame = clamp(state.frame, 0, s.frames - 1);
  $('#scrub').max = s.frames - 1;
  $('#empty').hidden = true;
  $('#frameBox').hidden = $('#timeline').hidden = $('#keyPanel').hidden = $('#exportPanel').hidden = false;
  $('#addClip').disabled = $('#exportTop').disabled = false;
  if (!clip() || clip().sourceId !== id) state.clipId = state.clips.find((c) => c.sourceId === id)?.id ?? null;
  renderAll();
  fitAll();
  showFrame();
}

// ---------- clips
function uniqueName(base) {
  let n = base.slice(0, 60) || 'clip', i = 2;
  while (state.clips.some((c) => c.name === n)) n = `${base}-${i++}`;
  return n;
}
function newClip(s, name, rect, a, b) {
  const c = { id: ++uid, sourceId: s.id, name, rect: rect.map(Math.round), in: a, out: b, loop: true, hue: HUES[state.clips.length % HUES.length] };
  state.clips.push(c);
  state.clipId = c.id;
  return c;
}
function clipFix(c) {
  const s = state.sources.find((x) => x.id === c.sourceId);
  let [x, y, w, h] = c.rect.map((v) => Math.round(+v || 0));
  x = clamp(x, 0, s.w - 1); y = clamp(y, 0, s.h - 1);
  c.rect = [x, y, clamp(w, 1, s.w - x), clamp(h, 1, s.h - y)];
  c.in = clamp(Math.round(c.in), 0, s.frames - 1);
  c.out = clamp(Math.round(c.out), c.in, s.frames - 1);
}

// ---------- rendering UI
function renderAll() { renderLists(); renderOverlay(); renderInspector(); renderRanges(); renderKey(); renderPreviewControls(); }

function renderLists() {
  $('#sources').innerHTML = state.sources.map((s) =>
    `<li data-id="${s.id}" aria-selected="${s.id === state.srcId}"><span class="name">${esc(s.name)}</span><span class="meta">${s.w}×${s.h} · ${s.fps} fps</span></li>`).join('');
  const clips = state.clips;
  $('#clips').innerHTML = clips.length ? clips.map((c) =>
    `<li data-id="${c.id}" aria-selected="${c.id === state.clipId}"><i class="dot" style="background:${c.hue}"></i><span class="name">${esc(c.name)}</span><span class="meta">${c.out - c.in + 1}f${c.loop ? '' : ' once'}</span></li>`).join('')
    : '<li class="empty-note">Drag on the video to cut a clip.</li>';
}
const esc = (t) => t.replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);

function renderOverlay() {
  const s = src(); if (!s) return;
  const svg = $('#overlay');
  svg.setAttribute('viewBox', `0 0 ${s.w} ${s.h}`);
  const hs = Math.max(8, s.w / 60);
  svg.innerHTML = state.clips.filter((c) => c.sourceId === s.id).map((c) => {
    const [x, y, w, h] = c.rect, sel = c.id === state.clipId;
    return `<g class="clip${sel ? ' sel' : ''}" data-id="${c.id}">
      <rect class="box" x="${x}" y="${y}" width="${w}" height="${h}" fill="${c.hue}" stroke="${c.hue}"/>
      <text x="${x + 6}" y="${y + 16}" fill="${c.hue}">${esc(c.name)}</text>
      ${sel ? `<rect class="handle" x="${x + w - hs}" y="${y + h - hs}" width="${hs}" height="${hs}" fill="${c.hue}"/>` : ''}
    </g>`;
  }).join('');
}

function renderRanges() {
  const s = src(); if (!s) return;
  const n = Math.max(1, s.frames - 1);
  $('#ranges').innerHTML = state.clips.filter((c) => c.sourceId === s.id).map((c) =>
    `<span class="${c.id === state.clipId ? 'sel' : ''}" style="left:${(c.in / n) * 100}%;width:${Math.max(0.5, ((c.out - c.in) / n) * 100)}%;background:${c.hue}" title="${esc(c.name)}"></span>`).join('');
  $('#scrub').value = state.frame;
  $('#fnum').textContent = `Frame ${state.frame} of ${s.frames - 1}`;
}

function renderInspector() {
  const c = clip();
  $('#clipPanel').hidden = !c;
  if (!c) return;
  $('#cName').value = c.name;
  [['#cX', c.rect[0]], ['#cY', c.rect[1]], ['#cW', c.rect[2]], ['#cH', c.rect[3]], ['#cIn', c.in], ['#cOut', c.out]].forEach(([q, v]) => ($(q).value = v));
  $('#cLoop').checked = c.loop;
}

function renderKey() {
  const s = src(); if (!s) return;
  const k = s.key;
  document.querySelectorAll('#keyPanel .seg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === k.mode));
  const list = k.mode === 'auto' ? chunk3(k.detected) : k.mode === 'custom' ? k.colors : [];
  $('#swatches').innerHTML = list.map((c, i) =>
    `<span class="swatch"><i style="background:${hex(c)}"></i>${hex(c)}${k.mode === 'custom' ? `<button data-rm="${i}" aria-label="Remove ${hex(c)}">×</button>` : ''}</span>`).join('');
  $('#keyMsg').textContent = k.mode === 'off' ? 'Use this when the video has a solid backdrop (green screen, magenta…).'
    : k.mode === 'custom' && !k.colors.length ? 'Add the backdrop colors: pick them from the video or enter a hex value.' : k.msg;
  $('#customTools').hidden = k.mode !== 'custom';
  $('#keySliders').hidden = k.mode === 'off';
  for (const [id, key] of [['#kTol', 'tol'], ['#kSoft', 'soft'], ['#kDespill', 'despill'], ['#kSpeck', 'speck']]) {
    $(id).value = k[key];
    $(id).nextElementSibling.textContent = key === 'speck' ? `${k[key]} px` : k[key];
  }
}
const chunk3 = (a) => (a ? Array.from({ length: a.length / 3 }, (_, i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]]) : []);

// ---------- viewer
const viewer = $('#viewer'), vctx = viewer.getContext('2d');
let lastRaw = null, drawToken = 0;
async function showFrame() {
  const s = src(); if (!s) return;
  const token = ++drawToken;
  const img = await grab(s, state.frame);
  if (token !== drawToken) return;
  drawImage(s, img);
  renderRanges();
}
function drawImage(s, img) {
  lastRaw = img;
  if (viewer.width !== s.w || viewer.height !== s.h) { viewer.width = s.w; viewer.height = s.h; }
  if (state.showKey && keysOf(s)) {
    const px = new Uint8Array(img.data.length); px.set(img.data);
    applyKey(s, px, s.w, s.h);
    vctx.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), s.w, s.h), 0, 0);
  } else vctx.putImageData(img, 0, 0);
}

function togglePlay() {
  const s = src(); if (!s) return;
  state.playing = !state.playing;
  $('#play').textContent = state.playing ? '❚❚' : '▶';
  $('#play').setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  const v = s.video;
  if (!state.playing) { v.pause(); return; }
  const c = clip()?.sourceId === s.id ? clip() : null;
  const [a, b] = c ? [c.in, c.out] : [0, s.frames - 1];
  lock = lock.then(async () => {
    if (state.frame < a || state.frame >= b) state.frame = a;
    v.currentTime = (state.frame + 0.5) / s.fps;
    await once(v, 'seeked');
    await v.play();
    await new Promise((done) => {
      const step = (_, meta) => {
        if (!state.playing || state.srcId !== s.id) { v.pause(); return done(); }
        state.frame = Math.floor(meta.mediaTime * s.fps);
        if (state.frame > b || v.ended) { state.frame = a; v.currentTime = (a + 0.5) / s.fps; v.play(); }
        drawImage(s, snap(s));
        renderRanges();
        v.requestVideoFrameCallback(step);
      };
      v.requestVideoFrameCallback(step);
    });
  });
}

// overlay interaction: drag empty = new clip, drag box = move, drag handle = resize, picking = eyedropper
const overlay = $('#overlay');
let drag = null;
const toSrc = (e) => {
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(overlay.getScreenCTM().inverse());
  const s = src();
  return [clamp(Math.round(p.x), 0, s.w), clamp(Math.round(p.y), 0, s.h)];
};
overlay.addEventListener('pointerdown', (e) => {
  const s = src(); if (!s) return;
  const [x, y] = toSrc(e);
  if (state.picking) {
    if (lastRaw) {
      const i = (Math.min(y, s.h - 1) * s.w + Math.min(x, s.w - 1)) * 4;
      s.key.colors.push([lastRaw.data[i], lastRaw.data[i + 1], lastRaw.data[i + 2]]);
      keyChanged();
    }
    return setPicking(false);
  }
  const g = e.target.closest('.clip');
  overlay.setPointerCapture(e.pointerId);
  if (g) {
    state.clipId = +g.dataset.id;
    const c = clip();
    drag = { mode: e.target.classList.contains('handle') ? 'size' : 'move', c, x, y, r: [...c.rect] };
  } else {
    drag = { mode: 'new', x, y, c: null };
  }
  renderAll();
});
overlay.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const [x, y] = toSrc(e), s = src();
  if (drag.mode === 'new') {
    if (!drag.c && Math.abs(x - drag.x) + Math.abs(y - drag.y) < 6) return;
    drag.c ??= newClip(s, uniqueName('clip'), [drag.x, drag.y, 1, 1], clip()?.in ?? 0, clip()?.out ?? s.frames - 1);
    drag.c.rect = [Math.min(x, drag.x), Math.min(y, drag.y), Math.abs(x - drag.x), Math.abs(y - drag.y)];
  } else if (drag.mode === 'move') {
    drag.c.rect = [drag.r[0] + x - drag.x, drag.r[1] + y - drag.y, drag.r[2], drag.r[3]];
    drag.c.rect[0] = clamp(drag.c.rect[0], 0, s.w - drag.r[2]);
    drag.c.rect[1] = clamp(drag.c.rect[1], 0, s.h - drag.r[3]);
  } else {
    drag.c.rect = [drag.r[0], drag.r[1], drag.r[2] + x - drag.x, drag.r[3] + y - drag.y];
  }
  clipFix(drag.c ?? clip());
  renderOverlay(); renderInspector();
});
overlay.addEventListener('pointerup', () => { if (drag) { drag = null; changed(); } });

function setPicking(on) {
  state.picking = on;
  document.body.classList.toggle('picking', on);
  $('#eyeHint').hidden = !on;
  $('#eyedrop').textContent = on ? 'Cancel picking' : 'Pick from video';
}

// ---------- inspector wiring
const bindNum = (q, fn) => $(q).addEventListener('change', (e) => { const c = clip(); if (!c) return; fn(c, +e.target.value); clipFix(c); changed(); });
bindNum('#cX', (c, v) => (c.rect[0] = v));
bindNum('#cY', (c, v) => (c.rect[1] = v));
bindNum('#cW', (c, v) => (c.rect[2] = v));
bindNum('#cH', (c, v) => (c.rect[3] = v));
bindNum('#cIn', (c, v) => (c.in = v));
bindNum('#cOut', (c, v) => (c.out = v));
$('#cName').addEventListener('change', (e) => { const c = clip(); c.name = e.target.value.trim() || c.name; changed(); });
$('#cLoop').addEventListener('change', (e) => { clip().loop = e.target.checked; changed(); });
$('#cDel').addEventListener('click', () => {
  state.clips = state.clips.filter((c) => c !== clip());
  state.clipId = state.clips.find((c) => c.sourceId === state.srcId)?.id ?? null;
  changed();
});
$('#addClip').addEventListener('click', () => {
  const s = src();
  newClip(s, uniqueName('clip'), [s.w / 4, s.h / 4, s.w / 2, s.h / 2], 0, s.frames - 1);
  changed();
});
$('#gMake').addEventListener('click', () => {
  const s = src(), base = clip();
  const cols = Math.max(1, +$('#gCols').value | 0), rows = Math.max(1, +$('#gRows').value | 0);
  const names = $('#gNames').value.split(',').map((n) => n.trim());
  const [gw, gh] = [s.w / cols, s.h / rows];
  let made = 0;
  for (let i = 0; i < cols * rows; i++) {
    const n = names.length > 1 || names[0] ? names[i] : `cell${i + 1}`;
    if (!n) continue;
    newClip(s, uniqueName(n), [(i % cols) * gw, Math.floor(i / cols) * gh, gw, gh], base?.in ?? 0, base?.out ?? s.frames - 1);
    made++;
  }
  if (base && base.rect[2] === s.w && base.rect[3] === s.h && made) state.clips = state.clips.filter((c) => c !== base); // replace the whole-frame default clip
  changed();
});
$('#setIn').addEventListener('click', () => { const c = clip(); if (c) { c.in = state.frame; c.out = Math.max(c.out, c.in); changed(); } });
$('#setOut').addEventListener('click', () => { const c = clip(); if (c) { c.out = state.frame; c.in = Math.min(c.in, c.out); changed(); } });
$('#play').addEventListener('click', togglePlay);
$('#scrub').addEventListener('input', (e) => { state.frame = +e.target.value; if (!state.playing) showFrame(); });
$('#showKey').addEventListener('change', (e) => { state.showKey = e.target.checked; showFrame(); });
$('#sources').addEventListener('click', (e) => { const li = e.target.closest('li[data-id]'); if (li) selectSource(+li.dataset.id); });
$('#clips').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]'); if (!li) return;
  state.clipId = +li.dataset.id;
  const c = clip();
  if (c.sourceId !== state.srcId) selectSource(c.sourceId); else renderAll();
  $('#pvClip').value = c.id;
});

// chroma key panel
document.querySelectorAll('#keyPanel .seg button').forEach((b) => b.addEventListener('click', () => {
  const s = src();
  s.key.mode = b.dataset.mode;
  if (s.key.mode === 'auto') return detectBackdrop(s);
  setPicking(false);
  keyChanged();
}));
async function detectBackdrop(s) {
  s.key.msg = 'Looking at the frame edges…';
  renderKey();
  const picks = [...new Set([0, s.frames >> 1, s.frames - 1])];
  const buf = new Uint8Array(s.w * s.h * 4 * picks.length);
  for (const [i, f] of picks.entries()) buf.set((await grab(s, f)).data, i * s.w * s.h * 4);
  try {
    s.key.detected = detect_keys(buf, s.w, s.h, s.key.tol, s.key.soft);
    s.key.msg = `Found ${s.key.detected.length / 3} backdrop color${s.key.detected.length > 3 ? 's' : ''}. Switch to Pick colors to fine-tune.`;
  } catch (e) {
    s.key.detected = null;
    s.key.msg = 'No solid backdrop found at the frame edges. Use Pick colors and click the background.';
  }
  keyChanged();
}
$('#swatches').addEventListener('click', (e) => {
  const i = e.target.dataset.rm; if (i === undefined) return;
  src().key.colors.splice(+i, 1);
  keyChanged();
});
$('#eyedrop').addEventListener('click', () => setPicking(!state.picking));
$('#colorIn').addEventListener('change', (e) => {
  const v = parseInt(e.target.value.slice(1), 16);
  src().key.colors.push([v >> 16, (v >> 8) & 255, v & 255]);
  keyChanged();
});
for (const [id, key] of [['#kTol', 'tol'], ['#kSoft', 'soft'], ['#kDespill', 'despill'], ['#kSpeck', 'speck']]) {
  $(id).addEventListener('input', (e) => { src().key[key] = +e.target.value; e.target.nextElementSibling.textContent = key === 'speck' ? `${e.target.value} px` : e.target.value; });
  $(id).addEventListener('change', keyChanged);
}
function keyChanged() {
  // switching auto -> custom keeps the detected colors as a starting point
  const k = src().key;
  if (k.mode === 'custom' && !k.colors.length && k.detected) k.colors = chunk3(k.detected);
  changed();
  showFrame();
}

function changed() {
  renderAll();
  const stale = signature(previewScale()) !== state.processedSig;
  $('#pvUpdate').hidden = !stale;
}

// ---------- processing: clips -> keyed, cropped, (scaled) frame buffers
const previewScale = () => ($('#xBake').checked ? Math.min(1, state.pv.scale) : 1);
const signature = (scale) => JSON.stringify([scale, state.clips.map((c) => [c.id, c.sourceId, c.rect, c.in, c.out]),
  state.sources.map((s) => [s.id, s.key.mode, s.key.colors, s.key.detected && [...s.key.detected], s.key.tol, s.key.soft, s.key.despill, s.key.speck])]);

async function processAll(scale) {
  const sig = signature(scale);
  if (state.processed && sig === state.processedSig) return state.processed;
  if (state.playing) togglePlay();
  const out = new Map();
  const tmpA = document.createElement('canvas'), tmpB = document.createElement('canvas');
  for (const s of state.sources) {
    const clips = state.clips.filter((c) => c.sourceId === s.id);
    if (!clips.length) continue;
    const lo = Math.min(...clips.map((c) => c.in)), hi = Math.max(...clips.map((c) => c.out));
    for (const c of clips) {
      const [, , w, h] = c.rect, ow = Math.max(1, Math.round(w * scale)), oh = Math.max(1, Math.round(h * scale)), n = c.out - c.in + 1;
      out.set(c.id, { w: ow, h: oh, n, data: new Uint8Array(ow * oh * 4 * n), bitmaps: [] });
    }
    for (let t = lo; t <= hi; t++) {
      const img = await grab(s, t);
      for (const c of clips) {
        if (t < c.in || t > c.out) continue;
        const [x, y, w, h] = c.rect, o = out.get(c.id);
        let px = new Uint8Array(w * h * 4);
        for (let r = 0; r < h; r++) px.set(img.data.subarray(((y + r) * s.w + x) * 4, ((y + r) * s.w + x + w) * 4), r * w * 4);
        applyKey(s, px, w, h);
        if (o.w !== w || o.h !== h) px = resample(px, w, h, o.w, o.h, tmpA, tmpB);
        o.data.set(px, (t - c.in) * o.w * o.h * 4);
      }
      setStatus(`Preparing ${s.name}: frame ${t - lo + 1} of ${hi - lo + 1}`);
    }
  }
  for (const o of out.values()) {
    const fl = o.w * o.h * 4;
    o.bitmaps = await Promise.all(Array.from({ length: o.n }, (_, i) =>
      createImageBitmap(new ImageData(new Uint8ClampedArray(o.data.buffer, i * fl, fl), o.w, o.h), { premultiplyAlpha: 'premultiply' })));
  }
  state.processed = out;
  state.processedSig = sig;
  $('#pvUpdate').hidden = true;
  setStatus('');
  return out;
}
function resample(px, w, h, ow, oh, a, b) {
  a.width = w; a.height = h; b.width = ow; b.height = oh;
  a.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
  const ctx = b.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, ow, oh);
  ctx.drawImage(a, 0, 0, ow, oh);
  return new Uint8Array(ctx.getImageData(0, 0, ow, oh).data.buffer);
}

// ---------- preview with reference background
const pv = $('#pv'), pctx = pv.getContext('2d'), pvGl = $('#pvGl');
function sizePreview() {
  const [w, h] = state.ref ? [state.ref.w, state.ref.h] : [1280, 720];
  if (pv.width === w && pv.height === h) return;
  pv.width = pvGl.width = w; pv.height = pvGl.height = h;
  Object.assign(state.pv, { w, h, x: w / 2, y: h / 2 });
  fitAll();
}
function renderPreviewControls() {
  const sel = $('#pvClip'), cur = sel.value;
  sel.innerHTML = state.clips.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  sel.value = state.clips.some((c) => String(c.id) === cur) ? cur : String(state.clipId ?? '');
  const c = state.clips.find((x) => String(x.id) === sel.value);
  const k = state.pv.scale;
  $('#pvReadout').textContent = c ? `${Math.round(c.rect[2] * k)} × ${Math.round(c.rect[3] * k)} px on a ${state.pv.w} × ${state.pv.h} ${state.ref ? 'reference' : 'canvas'} (${Math.round(k * 100)}% of source)` : '';
  $('#xBakeVal').textContent = `(${Math.round(Math.min(1, k) * 100)}%)`;
}
$('#pvScale').addEventListener('input', (e) => { state.pv.scale = +e.target.value; renderPreviewControls(); respawnRuntime(); changed(); });
$('#xBake').addEventListener('change', changed);
$('#pvClip').addEventListener('change', () => { state.pv.t = 0; renderPreviewControls(); respawnRuntime(); });
$('#pvUpdate').addEventListener('click', () => processAll(previewScale()).catch((e) => setStatus(e.message, true)));
let pvDrag = false;
pv.addEventListener('pointerdown', (e) => { pvDrag = true; pv.setPointerCapture(e.pointerId); movePv(e); });
pv.addEventListener('pointermove', (e) => pvDrag && movePv(e));
pv.addEventListener('pointerup', () => (pvDrag = false));
function movePv(e) {
  const r = pv.getBoundingClientRect();
  state.pv.x = ((e.clientX - r.left) / r.width) * pv.width;
  state.pv.y = ((e.clientY - r.top) / r.height) * pv.height;
  respawnRuntime();
}
$('#refIn').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const url = URL.createObjectURL(f);
  let el;
  if (f.type.startsWith('video/')) {
    el = Object.assign(document.createElement('video'), { src: url, muted: true, loop: true, playsInline: true, autoplay: true });
    await once(el, 'loadeddata');
    el.play();
    state.ref = { el, w: el.videoWidth, h: el.videoHeight };
  } else {
    el = new Image(); el.src = url; await el.decode();
    state.ref = { el, w: el.naturalWidth, h: el.naturalHeight };
  }
  $('#refClear').hidden = false;
  sizePreview(); renderPreviewControls(); respawnRuntime();
  e.target.value = '';
});
$('#refClear').addEventListener('click', () => { state.ref?.el.pause?.(); state.ref = null; $('#refClear').hidden = true; sizePreview(); renderPreviewControls(); respawnRuntime(); });
for (const [id, mode] of [['#pvSrc', 'src'], ['#pvRun', 'run']]) {
  $(id).addEventListener('click', () => {
    state.pv.mode = mode;
    $('#pvSrc').setAttribute('aria-pressed', mode === 'src');
    $('#pvRun').setAttribute('aria-pressed', mode === 'run');
    respawnRuntime();
  });
}

let lastT = performance.now();
function previewLoop(now) {
  const dt = Math.min((now - lastT) / 1000, 0.1); lastT = now;
  sizePreview();
  pctx.clearRect(0, 0, pv.width, pv.height);
  if (state.ref) pctx.drawImage(state.ref.el, 0, 0, pv.width, pv.height);
  const c = state.clips.find((x) => String(x.id) === $('#pvClip').value);
  const fps = +$('#xFps').value || 30;
  if (state.pv.mode === 'src' && c && state.processed?.has(c.id)) {
    const o = state.processed.get(c.id);
    state.pv.t += dt;
    let f = Math.floor(state.pv.t * fps);
    if (c.loop) f %= o.n; else if (f >= o.n + fps) { state.pv.t = 0; f = 0; } // one-shot: hold 1s, replay
    const k = state.pv.scale, w = c.rect[2] * k, h = c.rect[3] * k;
    pctx.drawImage(o.bitmaps[Math.min(f, o.n - 1)], state.pv.x - w / 2, state.pv.y - h / 2, w, h);
  }
  if (state.runtime) {
    for (const id of state.runtime.ids) if (state.runtime.opal.done(id)) state.runtime.opal.play(state.runtime.asset, id, state.runtime.clip);
    state.runtime.opal.render(state.pv.mode === 'run' ? dt : 0);
  }
  requestAnimationFrame(previewLoop);
}
requestAnimationFrame(previewLoop);

function respawnRuntime() {
  const r = state.runtime; if (!r) return;
  r.ids.forEach((id) => r.opal.kill(id));
  r.ids = [];
  const c = state.clips.find((x) => String(x.id) === $('#pvClip').value);
  if (state.pv.mode !== 'run' || !c || !(c.name in r.asset.clips)) return;
  r.clip = c.name;
  // the export may be pre-scaled: runtime scale = preview scale / export scale
  r.ids.push(r.opal.spawn(r.asset, c.name, state.pv.x, state.pv.y, state.pv.scale / r.exportScale));
}

// ---------- export
$('#exportBtn').addEventListener('click', () => exportOpal().catch((e) => { setStatus(e.message, true); console.error(e); }));
$('#exportTop').addEventListener('click', () => $('#exportBtn').click());

async function exportOpal() {
  if (!('VideoEncoder' in self)) throw new Error('This browser has no WebCodecs encoder. Use Chrome, Edge or Safari 26+.');
  if (!state.clips.length) throw new Error('Nothing to export: cut at least one clip.');
  const names = state.clips.map((c) => c.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`Two clips are named "${dup}". Clip names must be unique.`);
  $('#exportBtn').disabled = $('#exportTop').disabled = true;
  try {
    const fps = +$('#xFps').value || 30, scale = previewScale();
    const data = await processAll(scale);
    const project = new Project(fps);
    try {
      for (const c of state.clips) {
        const o = data.get(c.id);
        try { project.add_clip(c.name, c.loop, o.w, o.h, o.data); }
        catch (e) { throw new Error(`${e.message}`); }
      }
      const [aw, ah, cw, ch, n] = project.layout();
      const W = cw, H = ch * 2;
      if (Math.max(W, H) > 2048) setStatus(`Heads up: the packed video is ${W}×${H}; some phones can't decode above 2048 px. Export smaller or split into two files.`);
      const cfg = await pickEncoder(W, H, fps, +$('#xQuality').value);
      const chunks = [];
      let desc = null, codec = cfg.codec, err = null;
      const enc = new VideoEncoder({
        output(chunk, meta) {
          const b = new Uint8Array(chunk.byteLength);
          chunk.copyTo(b);
          chunks.push({ b, key: chunk.type === 'key' });
          const d = meta?.decoderConfig;
          if (d) {
            codec = d.codec || codec;
            if (d.description) desc = ArrayBuffer.isView(d.description) ? new Uint8Array(d.description.buffer, d.description.byteOffset, d.description.byteLength).slice() : new Uint8Array(d.description).slice();
          }
        },
        error: (e) => (err = e),
      });
      enc.configure(cfg);
      for (let t = 0; t < n; t++) {
        if (err) throw err;
        const vf = new VideoFrame(project.frame(t), { format: 'RGBX', codedWidth: W, codedHeight: H, timestamp: Math.round((t * 1e6) / fps), duration: Math.round(1e6 / fps) });
        enc.encode(vf, { keyFrame: t === 0 });
        vf.close();
        while (enc.encodeQueueSize > 2) await once(enc, 'dequeue');
        setStatus(`Encoding frame ${t + 1} of ${n}`);
      }
      await enc.flush();
      enc.close();
      if (err) throw err;
      if (!desc) throw new Error('The encoder returned no H.264 configuration.');
      if (chunks.length !== n) throw new Error(`The encoder produced ${chunks.length} frames, expected ${n}.`);
      const all = new Uint8Array(chunks.reduce((a, c) => a + c.b.length, 0));
      let off = 0;
      for (const c of chunks) { all.set(c.b, off); off += c.b.length; }
      const bytes = project.finish(codec, desc, Uint32Array.from(chunks, (c) => c.b.length), Uint8Array.from(chunks, (c) => +c.key), all);
      const name = `${state.sources[0].name}.opal`;
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      state.exported = { bytes, url, name };
      const a = $('#download');
      a.href = url; a.download = name; a.hidden = false;
      a.click();
      const vram = aw * ah * 4 * n * (4 / 3);
      setStatus(`Exported ${name}: ${(bytes.length / 1024).toFixed(0)} KB, ${state.clips.length} clips, ${n} frames, atlas ${aw}×${ah}, about ${(vram / 1e6).toFixed(1)} MB GPU memory once loaded.`);
      await loadRuntime(url, scale);
    } finally {
      project.free();
    }
  } finally {
    $('#exportBtn').disabled = $('#exportTop').disabled = false;
  }
}

async function pickEncoder(width, height, framerate, bpp) {
  const bitrate = Math.round(Math.max(200_000, width * height * framerate * bpp));
  for (const codec of ['avc1.640034', 'avc1.640033', 'avc1.64002a', 'avc1.640028', 'avc1.4d0034', 'avc1.42e034']) {
    const cfg = { codec, width, height, framerate, bitrate, latencyMode: 'quality', avc: { format: 'avc' } };
    const ok = await VideoEncoder.isConfigSupported(cfg).then((r) => r.supported, () => false);
    if (ok) return cfg;
  }
  throw new Error(`This browser can't encode ${width}×${height} H.264. Export smaller or cut fewer clips per file.`);
}

async function loadRuntime(url, exportScale) {
  state.runtime ??= { opal: await createOpal(pvGl), ids: [] };
  state.runtime.asset = await state.runtime.opal.load(url);
  state.runtime.exportScale = exportScale;
  $('#pvRun').disabled = false;
  $('#pvRun').title = '';
  $('#pvRun').click();
}

function setStatus(msg, isErr = false) {
  $('#status').textContent = msg;
  $('#status').classList.toggle('err', isErr);
  if (isErr || msg) $('#hint').textContent = msg || 'Drop videos anywhere to add them.';
}

// ---------- file input, drag & drop, keys
$('#fileIn').addEventListener('change', async (e) => { for (const f of e.target.files) await addSource(f); e.target.value = ''; });
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#drop').hidden = false; } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#drop').hidden = true;
  for (const f of e.dataTransfer.files) if (f.type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(f.name)) await addSource(f);
});
addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || !src()) return;
  const s = src(), step = e.shiftKey ? 10 : 1;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    state.frame = clamp(state.frame + (e.key === 'ArrowRight' ? step : -step), 0, s.frames - 1);
    showFrame(); e.preventDefault();
  } else if (e.key === ' ') { togglePlay(); e.preventDefault(); }
  else if (e.key === 'i') $('#setIn').click();
  else if (e.key === 'o') $('#setOut').click();
  else if (e.key === 'Escape') setPicking(false);
  else if ((e.key === 'Delete' || e.key === 'Backspace') && clip()) $('#cDel').click();
});

// fit media boxes to their panels at the media's aspect ratio
function fit(panel, box, w, h, pad = 16) {
  const r = panel.getBoundingClientRect();
  const k = Math.max(0.01, Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h));
  box.style.width = `${w * k}px`;
  box.style.height = `${h * k}px`;
}
function fitAll() {
  const s = src();
  if (s) fit($('#viewerWrap'), $('#frameBox'), s.w, s.h);
  fit($('#pvStage'), $('#pvBox'), pv.width, pv.height, 0);
}
new ResizeObserver(fitAll).observe($('#viewerWrap'));
new ResizeObserver(fitAll).observe($('#pvStage'));

sizePreview();
renderAll();
window.__studio = { state, addSource, exportOpal, processAll, detectBackdrop }; // for scripted tests
