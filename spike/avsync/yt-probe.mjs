// SRI-14: try the delayed canvas on a real YouTube / YT Music watch page.
// Usage: PW=/path/to/playwright node spike/avsync/yt-probe.mjs <watch-url> [delayMs]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'playwright');
const here = path.dirname(new URL(import.meta.url).pathname);
const url = process.argv[2];
const D = Number(process.argv[3] || 300);
const src = fs.readFileSync(path.join(here, 'delayed-video.js'), 'utf8').replace('export class', 'class') + '\nwindow.DelayedVideo = DelayedVideo;';

const browser = await chromium.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' });
const page = await ctx.newPage();
// Inject the prototype like a content script would (init scripts bypass Trusted Types).
await page.addInitScript(src);
// Probe for the look-ahead idea: count MSE appends per SourceBuffer type.
await page.addInitScript(() => {
  window.__mse = { audio: 0, video: 0, audioBytes: 0, types: [] };
  const add = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (type) {
    const sb = add.call(this, type);
    window.__mse.types.push(type);
    const kind = type.startsWith('audio') ? 'audio' : 'video';
    const app = sb.appendBuffer;
    sb.appendBuffer = function (d) { window.__mse[kind]++; if (kind === 'audio') window.__mse.audioBytes += d.byteLength; return app.call(this, d); };
    return sb;
  };
});
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
// Consent wall (EU) — click accept if present.
for (const sel of ['button[aria-label*="Accept"]', 'button:has-text("Accept all")']) {
  const b = page.locator(sel).first();
  if (await b.isVisible().catch(() => false)) { await b.click(); await page.waitForTimeout(2000); }
}
await page.waitForSelector('video', { timeout: 20000 });
await page.waitForTimeout(6000);
const info = await page.evaluate(() => {
  const v = document.querySelector('video');
  const b = v.buffered;
  return {
    src: v.src.slice(0, 20), paused: v.paused, t: v.currentTime, w: v.videoWidth, h: v.videoHeight,
    eme: !!v.mediaKeys, ad: !!document.querySelector('.ad-showing'),
    bufferedAhead: b.length ? b.end(b.length - 1) - v.currentTime : 0,
    mse: window.__mse, container: v.parentElement?.className,
  };
});
console.log('page', JSON.stringify(info));
const res = await page.evaluate(async (D) => {
  const v = document.querySelector('video');
  if (v.paused) await v.play().catch(() => {});
  const dv = new window.DelayedVideo(v, { delayMs: D, capture: 'bitmap' });
  window.__dv = dv;
  await new Promise((r) => setTimeout(r, 8000));
  const s = dv.stats;
  // Is the canvas actually showing picture (not black / tainted)?
  let nonBlack;
  try { const d = dv.ctx.getImageData(0, 0, dv.canvas.width, dv.canvas.height).data; let n = 0; for (let i = 0; i < d.length; i += 4000) if (d[i] + d[i + 1] + d[i + 2] > 30) n++; nonBlack = n; } catch (e) { nonBlack = 'err ' + e.message; }
  const q = v.getVideoPlaybackQuality();
  return { srcFrames: s.srcFrames, srcDropped: s.srcDropped, drawn: s.drawn, skipped: s.skipped, errs: s.captureErrors, ringMax: s.maxFrames, ringMB: Math.round(s.maxBytes / 2 ** 20), canvas: [dv.canvas.width, dv.canvas.height], nonBlack, vqDropped: q.droppedVideoFrames, ad: !!document.querySelector('.ad-showing'), fps: s.srcFrames / 8 };
}, D);
console.log('delayed', JSON.stringify(res));
await page.screenshot({ path: path.join(process.env.OUT || '.', 'yt-' + new URL(url).hostname + '.png') });
// Seek + quality-ish resize via theater toggle (YouTube only).
const after = await page.evaluate(async () => {
  const v = document.querySelector('video');
  const before = window.__dv.stats.drawn;
  v.currentTime = v.currentTime + 30;
  await new Promise((r) => setTimeout(r, 4000));
  return { drawnAfterSeek: window.__dv.stats.drawn - before, seeks: window.__dv.stats.seeks, errs: window.__dv.stats.captureErrors };
});
console.log('seek', JSON.stringify(after));
await browser.close();
