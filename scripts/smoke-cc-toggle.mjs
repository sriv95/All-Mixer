// SRI-40/44: CC off at load -> turn CC on -> footer should say "timing aligned to captions".
// Usage: bun run build && node scripts/smoke-cc-toggle.mjs [videoId] [secondVideoId]
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const ext = path.join(root, 'dist');
const V1 = process.argv[2] || 'dQw4w9WgXcQ';
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-cc-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  headless: !process.env.HEADED, channel: 'chromium', locale: 'en-US',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  ignoreDefaultArgs: ['--enable-automation'], viewport: { width: 1500, height: 950 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-blink-features=AutomationControlled'],
});
const page = await ctx.newPage();
page.on('console', (m) => /All Mixer|\[am-diag\]/.test(m.text()) && console.log('console:', m.text()));
page.on('request', (r) => {
  if (r.url().includes('/api/timedtext')) {
    const u = new URL(r.url());
    const q = u.searchParams;
    console.log('timedtext', Math.round(performance.now()%1e6), 'v=' + q.get('v'), 'lang=' + q.get('lang'), 'kind=' + q.get('kind'), 'fmt=' + q.get('fmt'), 'tlang=' + q.get('tlang'), 'pot=' + q.has('pot'), 'potc=' + q.get('potc'), 'name=' + q.get('name'), 'type=' + r.resourceType(), 'at', Date.now() % 1e6);
  }
});
await page.addInitScript(() => {
  window.addEventListener('message', (e) => { const m = e.data; if (m && m['__allmixer'] === 'evt') console.log('[am-diag] bridge event', JSON.stringify(m), Math.round(performance.now())); });
});
const footer = () => page.evaluate(() => {
  const v = document.getElementById('all-mixer-lyrics-panel')?.shadowRoot?.querySelector('[data-am-lyrics]')?.shadowRoot;
  return v?.querySelector('.footer, footer')?.textContent ?? null;
});
async function ccOff() {
  await page.goto(`https://www.youtube.com/watch?v=${V1}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ytp-subtitles-button', { timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.locator('#movie_player').hover();
  if ((await page.locator('.ytp-subtitles-button').getAttribute('aria-pressed')) === 'true') await page.locator('.ytp-subtitles-button').click();
  await page.waitForTimeout(1500);
  console.log('CC prepared off:', await page.locator('.ytp-subtitles-button').getAttribute('aria-pressed'));
}
async function run(id, first) {
  if (first) await page.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: 'domcontentloaded' });
  else await page.evaluate((i) => { const a = document.createElement('a'); a.href = `/watch?v=${i}`; a.className='yt-simple-endpoint'; document.body.append(a); document.querySelector('ytd-app')?.fire?.('yt-navigate', {}) ; location.href = `/watch?v=${i}`; }, id);
  await page.waitForSelector('#movie_player video', { timeout: 30000 });
  await page.evaluate(() => document.querySelector('#movie_player video')?.play().catch(() => {}));
  await page.locator('[data-allmixer-lyrics-btn]').waitFor({ timeout: 20000 });
  if (first) { await page.locator('#movie_player').hover(); await page.locator('[data-allmixer-lyrics-btn]').click(); }
  await page.waitForTimeout(9000);
  console.log(id, 'before CC:', await footer());
  const on = await page.evaluate(() => document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'));
  console.log('CC pressed at start:', on);
  await page.locator('#movie_player').hover();
  if (on !== 'true') await page.locator('.ytp-subtitles-button').click();
  console.log('CC click at', Date.now() % 1e6, 'pressed:', await page.locator('.ytp-subtitles-button').getAttribute('aria-pressed'));
  const s = Date.now();
  let f;
  while (Date.now() - s < 12000) { f = await footer(); if (/aligned/.test(f ?? '')) break; await page.waitForTimeout(500); }
  console.log(id, 'after CC:', f, `(${Date.now() - s} ms)`);
}
if (!process.env.CC_ON) await ccOff();
await run(V1, true);
if (process.argv[3]) { await run(process.argv[3], false); }
await ctx.close();
