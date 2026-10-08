#!/bin/sh
# Rebuild the browser artifacts: runtime wasm (web/opal.wasm) and Studio wasm + bindings (web/studio/pkg).
# Needs: rustup target add wasm32-unknown-unknown; cargo install wasm-bindgen-cli --version 0.2.129
set -e
cargo build --release -p opal-wasm -p opal-studio --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/opal_wasm.wasm web/opal.wasm
wasm-bindgen --target web --no-typescript --out-dir web/studio/pkg target/wasm32-unknown-unknown/release/opal_studio.wasm
# the npm package ships the same runtime
cp web/opal.js packages/opal-sprites/src/runtime.js
cp web/opal.wasm packages/opal-sprites/src/opal.wasm
# ship the Claude Code skills with the package
mkdir -p packages/opal-sprites/skills && cp -r .claude/skills/opal-sprites .claude/skills/opal-video-sprites packages/opal-sprites/skills/
