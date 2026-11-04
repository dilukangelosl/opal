// Pixel diff of vis.html rendered by two runtime roots. usage: node vis.mjs <rootA> <rootB> [frames] [extraQueryForB]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [rootA, rootB, frames = '0,17,44', extraB = ''] = process.argv.slice(2);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const serve = (root) => new Promise((r) => {
  const s = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  });
  s.listen(0, '127.0.0.1', () => r(s));
});
const sa = await serve(rootA), sb = await serve(rootB);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 900, height: 400 }, deviceScaleFactor: 1 });

async function grab(server, k, extra, shot) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror', String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}/web/vis.html?frame=${k}${extra}`);
  await page.waitForFunction(() => window.__pixels, null, { timeout: 30000 });
  const b64 = await page.evaluate(() => window.__pixels);
  await page.screenshot({ path: shot });
  await page.close();
  return Buffer.from(b64, 'base64');
}

for (const k of frames.split(',').map(Number)) {
  const a = await grab(sa, k, '', `shot-a-${k}.png`), b = await grab(sb, k, extraB, `shot-b-${k}.png`);
  let diff = 0, max = 0, visA = 0, visB = 0, big = 0;
  const W = 900, spots = [];
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3]) visA++;
    if (b[i + 3]) visB++;
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
    if (d) diff++;
    if (d > 8) { big++; if (spots.length < 12) spots.push([(i / 4) % W, 400 - 1 - Math.floor(i / 4 / W), 'a', [...a.subarray(i, i + 4)], 'b', [...b.subarray(i, i + 4)]]); }
    max = Math.max(max, d);
  }
  console.log(JSON.stringify({ frame: k, pixels: a.length / 4, visibleA: visA, visibleB: visB, differing: diff, differingOver8: big, maxDiff: max }));
  if (spots.length) console.log('  first >8 diffs (x, y from top):', JSON.stringify(spots));
}
await browser.close();
sa.close(); sb.close();
