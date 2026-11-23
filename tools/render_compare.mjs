#!/usr/bin/env node
// Render a side-by-side comparison video: original recording | marionette,
// with the original soundtrack. Frames of the marionette are rendered by the
// running app at exact media times (seek -> screenshot), so the result is
// frame-accurate and independent of real-time performance.
//
// Usage (with `npm run dev` running):
//   node tools/render_compare.mjs [start=0] [end=58.8] [fps=30] [out=compare.mp4] [url]
// Requires Playwright (`npm i -D playwright` or a global install) and ffmpeg.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const [start = '0', end = '58.8', fps = '30', out = 'compare.mp4', url = 'http://localhost:5173/'] = process.argv.slice(2);
const t0 = Number(start);
const t1 = Number(end);
const FPS = Number(fps);
const dir = mkdtempSync(join(tmpdir(), 'dp-frames-'));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.dancingPuppet !== undefined);
const n = Math.round((t1 - t0) * FPS);
for (let i = 0; i < n; i++) {
  const t = t0 + i / FPS;
  await page.evaluate((t) => window.dancingPuppet.seek(t), t);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.locator('.stage-panel').screenshot({ path: join(dir, `f${String(i).padStart(5, '0')}.png`) });
  if (i % 60 === 0) process.stdout.write(`\rframe ${i}/${n}`);
}
await browser.close();
process.stdout.write('\n');

execFileSync('ffmpeg', [
  '-v', 'error', '-y',
  '-ss', String(t0), '-t', String(t1 - t0), '-i', 'public/ref/reference.mp4',
  '-framerate', String(FPS), '-i', join(dir, 'f%05d.png'),
  '-ss', String(t0), '-t', String(t1 - t0), '-i', 'public/audio/music.wav',
  '-filter_complex',
  `[0:v]fps=${FPS},scale=-2:600,setsar=1[a];[1:v]scale=-2:600,setsar=1[b];[a][b]hstack=inputs=2,format=yuv420p[v]`,
  '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-crf', '22', '-preset', 'medium', '-c:a', 'aac', '-b:a', '128k',
  '-shortest', out,
], { stdio: 'inherit' });
rmSync(dir, { recursive: true, force: true });
console.log(`wrote ${out}`);
