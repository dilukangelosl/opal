// Load the demo pages from the repo root in Chrome, report page/console errors and whether the canvas drew anything.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
for (const url of ['/web/game2/', '/web/game2/?renderer=pixi', '/web/game/', '/web/pixi/', '/web/player.html']) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${port}${url}`);
  await page.waitForTimeout(4000);
  await page.keyboard.press('Space'); await page.keyboard.press('KeyJ'); // start / act
  await page.waitForTimeout(2500);
  const drawn = await page.evaluate(() => {
    const c = document.querySelector('canvas'); if (!c) return 'no canvas';
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    if (!gl) return 'no gl context (2d or pixi-owned)';
    const px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i]) n++;
    return `${n} opaque px of ${px.length / 4}`;
  });
  const shot = `smoke-${url.replace(/[^a-z0-9]+/gi, '_')}.png`;
  await page.screenshot({ path: shot });
  console.log(url.padEnd(28), errors.length ? 'ERRORS ' + JSON.stringify(errors.slice(0, 3)) : 'no errors', '|', drawn, '|', shot);
  await page.close();
}
await browser.close();
server.close();
