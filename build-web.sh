#!/bin/sh
# Rebuild the browser artifacts: runtime wasm (web/opal.wasm) and Studio wasm + bindings (web/studio/pkg).
# Needs: rustup target add wasm32-unknown-unknown; cargo install wasm-bindgen-cli --version 0.2.129
set -e
cargo build --release -p opal-wasm -p opal-studio --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/opal_wasm.wasm web/opal.wasm
wasm-bindgen --target web --no-typescript --out-dir web/studio/pkg target/wasm32-unknown-unknown/release/opal_studio.wasm
