// opal-sprites: transparent video sprites for web games.
//   createOpal  – Opal's own runtime (Rust/wasm + WebGL2, one instanced draw per file)
//   decodeOpal  – decode .opal into RGBA canvas pages for any other renderer
//   parseOpal   – read the container header, clips and frame index
// PixiJS users: import { loadOpal } from 'opal-sprites/pixi'.
export { createOpal } from './runtime.js';
export { decodeOpal, parseOpal } from './decode.js';
