# Opal: transparent video sprites for web games

Characters, enemies and effects come from AI or green-screen video, packed into tiny `.opal` files
and played by a ~15 KB WebGL2 runtime (Rust/wasm + WebCodecs), or as PixiJS textures.

- Site and demos: https://dilukangelosl.github.io/opal/
- Making `.opal` files: Opal Studio and the `opal` CLI come with a commercial license (see below)
- Runtime on npm: `npm i opal-sprites` (source in [packages/opal-sprites](packages/opal-sprites))

This repository holds the published site and the runtime package only. The encoder, CLI and Studio
source are not public.

## License

[PolyForm Noncommercial 1.0.0](LICENSE): free for personal, hobby, research and other noncommercial use.
Commercial use (anything that earns money) needs a commercial license. **Commercial licenses start at
US$1,000 and include full source access** (encoder, CLI, Studio, runtime). Contact **dilukangelo@gmail.com**.
