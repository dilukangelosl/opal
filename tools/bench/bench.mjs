// A/B benchmark for web/compare.html. usage: node bench.mjs <root dir> <label> [n,n,...] [extra query]
// Serves <root> over http, drives installed Google Chrome (headed: real GPU + hardware H.264),
// opens /web/compare.html?mode=opal&n=N, collects window.__stats samples, prints medians as JSON lines.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [root, label, ns = '2000,5000,20000', extra = ''] = process.argv.slice(2);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.opal': 'application/octet-stream', '.webm': 'video/webm' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--disable-frame-rate-limit'.slice(0, 0) || '--enable-gpu-rasterization'] });
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const out = [];
for (const n of ns.split(',').map(Number)) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/web/compare.html?mode=opal&n=${n}${extra}`);
  // warm up 3 s, then collect 8 one-second samples
  const t0 = Date.now();
  let st; const cpus = [];
  while (Date.now() - t0 < 40000) {
    await page.waitForTimeout(500);
    st = await page.evaluate(() => window.__stats);
    if (st?.error) break;
    if (st && st.samples.length > 6) cpus.push(st.cpuMs);
    if (st && st.samples.length >= 16) break;
  }
  const samples = (st?.samples ?? []).slice(6);
  const row = { label, n, fps: median(samples), fpsMin: Math.min(...samples), cpuMs: median(cpus), loadMs: st?.loadMs, error: st?.error ?? errors[0], samples };
  out.push(row);
  console.log(JSON.stringify(row));
  await ctx.close();
}
await browser.close();
server.close();
