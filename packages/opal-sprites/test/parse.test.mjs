// The JS parser (used by decodeOpal / the Pixi adapter) must agree with the Rust parser
// inside opal.wasm on real files, and must reject damaged ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseOpal } from '../src/decode.js';

const root = new URL('../../../', import.meta.url);
const files = ['web/game2/assets', 'web/game/assets', 'examples']
  .flatMap((d) => readdirSync(new URL(d, root)).filter((f) => f.endsWith('.opal')).map((f) => new URL(`${d}/${f}`, root)));
const { instance } = await WebAssembly.instantiate(readFileSync(new URL('src/opal.wasm', new URL('../', import.meta.url))));
const w = instance.exports;
const str = (p, n) => new TextDecoder().decode(new Uint8Array(w.memory.buffer, p, n));

for (const url of files) {
  test(`matches the Rust parser: ${url.pathname.split('/').slice(-2).join('/')}`, () => {
    const bytes = readFileSync(url);
    const o = parseOpal(bytes);
    const ptr = w.opal_alloc(bytes.length);
    new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
    const id = w.opal_load(ptr, bytes.length);
    assert.ok(id >= 0);
    assert.equal(o.width, w.opal_width(id));
    assert.equal(o.height, w.opal_height(id));
    assert.equal(o.codedHeight, w.opal_coded_height(id));
    assert.equal(o.codec, str(w.opal_codec_ptr(id), w.opal_codec_len(id)));
    assert.equal(o.description.length, w.opal_desc_len(id));
    assert.equal(o.frames.length, w.opal_frame_count(id));
    assert.ok(Math.abs(o.fps - w.opal_fps(id)) < 1e-6);
    o.frames.forEach((f, i) => { assert.equal(f.size, w.opal_frame_size(id, i)); assert.equal(+f.key, w.opal_frame_key(id, i)); });
    assert.equal(o.clips.length, w.opal_clip_count(id));
    o.clips.forEach((c, i) => {
      assert.equal(c.name, str(w.opal_clip_name_ptr(id, i), w.opal_clip_name_len(id, i)));
      assert.equal(c.count, w.opal_clip_frames(id, i));
      assert.deepEqual([c.origin[0], c.origin[1], c.rect[2], c.rect[3]], [0, 1, 2, 3].map((k) => w.opal_clip_box(id, i, k)));
      assert.deepEqual(c.src, [w.opal_clip_w(id, i), w.opal_clip_h(id, i)]);
    });
  });
}

test('rejects damaged files', () => {
  const bytes = readFileSync(files[0]);
  for (const cut of [0, 3, 10, 40, 200]) assert.throws(() => parseOpal(bytes.subarray(0, cut)));
  const bad = new Uint8Array(bytes); bad[0] = 0x58;
  assert.throws(() => parseOpal(bad), /not an .opal/);
});
