// Preload Audio against real youtube.com: forces a missed deadline in the live engine, takes the "Switch to Preload Audio" button
// of the popup, waits for the preload, checks that the cache plays, goes back to Live and to Preload through the Advanced switch,
// and looks at the Export section. The popup page is opened as a tab of the browser with chrome.tabs.query pointed at the video tab.
// Usage: bun run build && node scripts/smoke-preload.mjs [videoId] [out dir]   (HEADED=1 to watch; NOSTALL=1 skips the forced stall)
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const ext = path.join(root, 'dist');
const ID = process.argv[2] || 'jNQXAC9IVRw'; // 19 s
const out = process.argv[3] || path.join(root, 'docs/screenshots/preload');
fs.mkdirSync(out, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const check = (name, ok, info = '') => { console.log(ok ? 'PASS' : 'FAIL', name, info); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'am-preload-')), {
  headless: !process.env.HEADED, channel: 'chromium', locale: 'en-US',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  ignoreDefaultArgs: ['--enable-automation'], viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-blink-features=AutomationControlled', '--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
if (!process.env.NOSTALL) await sw.evaluate((ms) => chrome.storage.local.set({ 'debug.mlStallMs': ms, 'debug.mlStallAfterMs': 2000 }), Number(process.env.STALL_MS || 400));

const page = await ctx.newPage();
page.on('console', (m) => /All Mixer|preload|export/i.test(m.text()) && log('console:', m.text().slice(0, 240)));
await page.goto(`https://www.youtube.com/watch?v=${ID}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#movie_player video', { timeout: 30000 });
await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2 && Number.isFinite(v.duration); }, null, { timeout: 60000 });
await page.waitForTimeout(2500);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: '*://www.youtube.com/*' }))[0].id);

// The popup, as a page whose "active tab" is the video tab.
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 380, height: 900 });
await popup.addInitScript(({ tabId, url }) => {
  chrome.tabs.query = async () => [{ id: tabId, url }];
}, { tabId, url: page.url() });
await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup/popup.html`);
await popup.waitForSelector('#tab-separate');
const shot = async (name, el = null) => { await (el ? popup.locator(el) : popup).screenshot({ path: path.join(out, `${name}.png`), ...(el ? {} : { fullPage: true }) }); log('shot', name); };
const status = () => sw.evaluate(async (id) => chrome.tabs.sendMessage(id, { type: 'get-status' }), tabId);
const until = async (what, fn, ms = 120000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what + ' ' + JSON.stringify((await status())?.preload)); await sleep(400); } };

// 1. Live Separate, forced to miss its deadline
await page.evaluate(() => document.querySelector('video').play().catch(() => {}));
await popup.click('#tab-separate');
log('separate on; waiting for the engine to stop');
await until('stopped banner', async () => (await popup.locator('#separation-banner[data-kind="stopped"]').count()) > 0 || (process.env.NOSTALL && (await popup.locator('#separation-banner').count()) > 0), 180000);
await sleep(600);
await shot('1-missed-deadline');
check('missed deadline shows the Preload button', (await popup.locator('#act-preload').count()) === 1, await popup.locator('#separation-banner h2').innerText());

// 2. Switch to Preload Audio
await popup.click('#act-preload');
await until('loading', async () => (await status())?.preload?.state === 'loading', 30000);
await sleep(1500);
let st = await status();
await popup.click('#tab-separate').catch(() => {}); // refresh
await sleep(700);
await shot('2-preload-starting');
await until('recording progress', async () => { st = await status(); return st.preload?.progress?.stage === 'recording'; }, 120000);
await sleep(2500);
await shot('3-preload-recording');
check('progress detail text', /Chunk 1\/\d+/.test((await status()).preload.progress.detail), (await status()).preload.progress.detail);
check('progress bar shown in the popup', (await popup.locator('#preload-progress').count()) === 1);
check('cancel button shown', (await popup.locator('#preload-cancel').count()) === 1);
check('live engine is off while preloading', (await status()).separation.choice.state === 'off', JSON.stringify((await status()).separation.choice));
check('video muted while recording', await page.evaluate(() => document.querySelector('video').muted));

// 3. Ready
let lastLog = 0;
await until('ready', async () => { const p = (await status())?.preload; if (Date.now() - lastLog > 20000) { lastLog = Date.now(); log('preload:', p?.state, p?.progress?.detail, page.url(), await page.evaluate(() => { const v = document.querySelector('video'); return `t=${v.currentTime.toFixed(1)} dur=${v.duration} paused=${v.paused} muted=${v.muted}`; })); } return p?.state === 'ready'; }, 30 * 60000);
await sleep(800);
st = await status();
await shot('4-preload-ready');
check('state ready', st.preload.state === 'ready', `${(st.preload.bytes / 1e6).toFixed(1)} MB`);
check('video restored (not muted, back at the start region)', await page.evaluate(() => !document.querySelector('video').muted));
await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 1; return v.play(); });
const peaks = [];
await until('cache playing', async () => { const p = (await status()).preload.playing; if (p) peaks.push(p); return p; }, 20000);
for (let i = 0; i < 12; i++) { const p = (await status()).preload.playing; if (p) peaks.push(p); await sleep(120); }
check('the cache sounds (peak level)', Math.max(...peaks.map((p) => p.level)) > 0.005, `max peak ${Math.max(...peaks.map((p) => p.level)).toFixed(3)}`);
const drift = peaks.map((p) => p.driftMs).filter((d) => d !== null);
check('cache in step with the picture', drift.length > 0 && drift.every((d) => Math.abs(d) < 120), `drift ms ${drift.map((d) => d.toFixed(0)).join(',')}`);
// levels act on the cache live: vocal 0 + instrumental 100 vs the reverse
const level = async (patch) => {
  await popup.evaluate(async ({ id, patch }) => { const cur = await chrome.runtime.sendMessage({ type: 'get-tab-settings', tabId: id }); await chrome.runtime.sendMessage({ type: 'set-tab-settings', tabId: id, settings: { ...cur, ...patch } }); }, { id: tabId, patch });
  await sleep(500);
  let m = 0;
  for (let i = 0; i < 20; i++) { m = Math.max(m, (await status()).preload.playing?.level ?? 0); await sleep(80); }
  return m;
};
const both = await level({ vocalPct: 100, instrumentalPct: 100 });
const none = await level({ vocalPct: 0, instrumentalPct: 0 });
const back = await level({ vocalPct: 100, instrumentalPct: 100 });
check('sliders change the cached stems live', none < 0.002 && both > 0.005 && back > 0.005, `both ${both.toFixed(3)} none ${none.toFixed(3)} back ${back.toFixed(3)}`);
// seek
await page.evaluate(() => { document.querySelector('video').currentTime = 8; });
await sleep(1500);
const d2 = (await status()).preload.playing;
check('after a seek the cache plays on in step', !!d2 && Math.abs(d2.driftMs ?? 999) < 120, JSON.stringify(d2));
await page.evaluate(() => document.querySelector('video').pause());
await sleep(700);
check('pause stops the cache', (await status()).preload.playing === undefined);
await page.evaluate(() => document.querySelector('video').play());

// 4. Export section in preload mode
await popup.locator('#export').scrollIntoViewIfNeeded().catch(() => {});
await sleep(600);
check('Export section visible and open in preload mode', (await popup.locator('#export-start').isVisible()));
await shot('5-export-section-in-preload-mode');

// 5. Advanced: back to Live
await popup.evaluate(() => { const d = document.querySelector('#advanced'); d?.scrollIntoView(); });
if ((await popup.locator('#advanced-toggle').getAttribute('aria-expanded')) !== 'true') await popup.locator('#advanced-toggle').click();
await sleep(500);
await shot('6-advanced-processing-preload');
await popup.click('#processing-live');
await sleep(1500);
st = await status();
check('Live again: cache does not play', st.preload.playing === undefined, `preload ${st.preload.state}`);
check('Live again: live engine runs', ['warming', 'on', 'stopped'].includes(st.separation.choice.state), st.separation.choice.state);
await shot('7-back-to-live');
// 6. and to Preload again: the cache is still there, no new preload
await popup.click('#processing-preload');
await sleep(1500);
st = await status();
check('Preload again uses the cache, no new recording', st.preload.state === 'ready', st.preload.state);
await until('cache playing again', async () => (await status()).preload.playing, 15000);
check('cache plays again', true);
await shot('8-preload-again');


// 7. A fresh page load (a new video does the same): Preload mode is remembered, there is no cache, nothing starts by itself
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2 && Number.isFinite(v.duration); }, null, { timeout: 60000 });
await sleep(2500);
await popup.reload();
await popup.waitForSelector('#tab-separate');
await sleep(1200);
st = await status();
check('new page: Preload mode kept, not preloaded, nothing running', st.preload.state === 'idle', st.preload.state);
check('new page: Preload audio button offered', (await popup.locator('#preload-start').count()) === 1);
await shot('9-not-preloaded-yet');

// 8. Cancel
await popup.click('#preload-start');
await until('loading', async () => (await status())?.preload?.state === 'loading', 30000);
await until('recording', async () => (await status())?.preload?.progress?.stage === 'recording', 120000);
await sleep(1500);
await popup.click('#preload-cancel');
await until('cancelled', async () => (await status())?.preload?.state === 'cancelled', 30000);
await sleep(900);
await shot('10-cancelled');
check('cancel: state cancelled, banner offers Preload audio again', (await popup.locator('#preload-banner[data-state="cancelled"] ~ div #preload-start, #preload-start').count()) >= 1);
check('cancel: video back to sound (not muted)', await page.evaluate(() => !document.querySelector('video').muted));
check('cancel: no cache plays', (await status()).preload.playing === undefined);

// 9. Error: the RoFormer model is not downloaded, so the model cannot start
await popup.evaluate(async (id) => { const cur = await chrome.runtime.sendMessage({ type: 'get-tab-settings', tabId: id }); await chrome.runtime.sendMessage({ type: 'set-tab-settings', tabId: id, settings: { ...cur, mlModel: 'roformer' } }); }, tabId);
await sleep(500);
await popup.click('#preload-start');
await until('error', async () => (await status())?.preload?.state === 'error', 90000);
await sleep(900);
st = await status();
await shot('11-error');
check('error: reason shown in the popup', (await popup.locator('#preload-text').innerText()).length > 20, st.preload.progress.error);
check('error: Try again and Use Live mode offered', (await popup.locator('#preload-retry').count()) === 1 && (await popup.locator('#preload-live').count()) === 1);
check('error: video back to sound', await page.evaluate(() => !document.querySelector('video').muted));

// 10. Switching to Live while it loads stops the preload
await popup.evaluate(async (id) => { const cur = await chrome.runtime.sendMessage({ type: 'get-tab-settings', tabId: id }); await chrome.runtime.sendMessage({ type: 'set-tab-settings', tabId: id, settings: { ...cur, mlModel: 'mdx' } }); }, tabId);
await popup.reload();
await popup.waitForSelector('#tab-separate');
await sleep(1000);
await popup.click('#preload-retry').catch(() => popup.click('#preload-start'));
await until('loading again', async () => (await status())?.preload?.state === 'loading', 30000);
await until('recording again', async () => (await status())?.preload?.progress?.stage === 'recording', 120000);
await popup.evaluate(async (id) => { const cur = await chrome.runtime.sendMessage({ type: 'get-tab-settings', tabId: id }); await chrome.runtime.sendMessage({ type: 'set-tab-settings', tabId: id, settings: { ...cur, preload: false } }); }, tabId);
await until('stopped by the switch', async () => (await status())?.preload?.state !== 'loading', 30000);
check('Live while loading cancels the preload and gives the sound back', (await status()).preload.state === 'cancelled' && (await page.evaluate(() => !document.querySelector('video').muted)), (await status()).preload.state);
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
await ctx.close();
process.exit(failed ? 1 : 0);
