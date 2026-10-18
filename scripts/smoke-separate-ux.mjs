// Separate-mode player UX against real youtube.com: time readout, held end of video, spinner.
// No GPU needed: the QA message `debug-video-delay` forces a 2 s picture delay, which is all these features key on
// (the audio-side spinner timing needs the worklet and is covered by unit tests).
// Usage: bun run build && node scripts/smoke-separate-ux.mjs [videoId]   (HEADED=1 to watch)
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const ext = path.join(root, 'dist');
const ID = process.argv[2] || 'jNQXAC9IVRw'; // 19 s
const DELAY_MS = 2000;
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'am-ux-')), {
  headless: !process.env.HEADED, channel: 'chromium', locale: 'en-US',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  ignoreDefaultArgs: ['--enable-automation'], viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-blink-features=AutomationControlled'],
});
let failed = 0;
const check = (name, ok, info = '') => { console.log(ok ? 'PASS' : 'FAIL', name, info); if (!ok) failed++; };
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const page = await ctx.newPage();
await page.goto(`https://www.youtube.com/watch?v=${ID}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#movie_player video', { timeout: 30000 });
await page.waitForSelector('.ytp-time-current', { timeout: 30000 });
await page.evaluate(() => document.querySelector('#movie_player video').play().catch(() => {}));
await page.waitForTimeout(3000);
await sw.evaluate(async (delayMs) => {
  const [tab] = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
  await chrome.tabs.sendMessage(tab.id, { type: 'debug-video-delay', delayMs });
}, DELAY_MS);
await page.waitForTimeout(3500);

const secs = (s) => s.split(':').reduce((a, x) => a * 60 + Number(x), 0);
const snap = () => page.evaluate(() => {
  const mp = document.querySelector('#movie_player'), v = document.querySelector('video'), sp = mp.querySelector('.ytp-spinner');
  return {
    cur: v.currentTime, dur: v.duration, ended: v.ended, text: mp.querySelector('.ytp-time-current')?.textContent,
    state: mp.getPlayerState?.(), spinner: sp ? getComputedStyle(sp).display : null, label: mp.querySelector('.all-mixer-spinner-label')?.textContent ?? '',
    canvas: !!mp.querySelector('canvas.all-mixer-delayed-video'), url: location.href,
  };
});

let s = await snap();
check('delay overlay is running', s.canvas);
const lag = s.cur - secs(s.text);
check('time text trails currentTime by the delay', lag >= 0.8 && lag <= 3.2, `currentTime ${s.cur.toFixed(1)} text ${s.text} lag ${lag.toFixed(1)} s`);

// Near the end: the real end must not reach the player for one delay.
await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = v.duration - 3; });
const t0 = Date.now();
let endedAt = 0;
while (Date.now() - t0 < 15000) {
  s = await snap();
  if (s.ended && !endedAt) endedAt = Date.now();
  if (endedAt && Date.now() - endedAt > 600) break;
  await page.waitForTimeout(100);
}
check('video ended for real', endedAt > 0);
check('player still "playing" 0.6 s after the real end', s.state === 1, `state ${s.state}`);
check('spinner and label shown while the end is held', s.spinner === 'block' && s.label !== '', `${s.spinner} "${s.label}"`);
await page.waitForTimeout(DELAY_MS + 1500);
s = await snap();
check('end reaches the player after the delay (ended or next clip)', s.state !== 1 || !s.url.includes(ID), `state ${s.state}`);
check('spinner is gone after the end', s.spinner !== 'block' || !s.url.includes(ID), s.spinner);

// A pause click during the held end must not leave the tail running behind a spinner.
await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 0; v.play(); });
await page.waitForTimeout(2000);
await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = v.duration - 2.5; });
while (!(await snap()).ended) await page.waitForTimeout(100);
await page.waitForTimeout(500);
await page.locator('#movie_player').hover();
await page.locator('.ytp-play-button').click();
await page.waitForTimeout(400);
s = await snap();
check('pause click during the held end stops the player (paused or ended screen)', s.state === 2 || s.state === 0, `state ${s.state}`);
check('spinner is gone after the pause click', s.spinner !== 'block', s.spinner);
await ctx.close();
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
