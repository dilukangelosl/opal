# Runtime benchmarks (A/B against a previous build)

Needs installed Google Chrome (hardware H.264) and `npm i playwright` in this folder.

```sh
# <root> serves web/compare.html; keep a copy of the old web/opal.js + opal.wasm + assets as the baseline root
node bench.mjs <root> <label> 20000,50000 "&file=game2/assets/skeleton.opal"   # fps / script ms per sprite count
node vis.mjs <rootA> <rootB> 0,17,44        # pixel diff of vis.html (copy it into each root's web/) between two runtimes
node smoke.mjs <repo root>                  # load the demo pages, report errors, screenshot
```
The display refresh caps fps, so compare at sprite counts that are GPU-bound, and interleave baseline/new runs (machine noise is large).
