// SRI-233: is the www .ytp-error (t=0) after theater pause caused by the extension?
// Usage: MODE=none|bypass|sep RUN=1 OUT=dir node scripts/qa-sri233.mjs
import path from 'node:path'; import os from 'node:os'; import fs from 'node:fs'; import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const MODE = process.env.MODE || 'none'; const RUN = process.env.RUN || '1'; const OUT = process.env.OUT || os.tmpdir(); const N = Number(process.env.N || 5);
const URL_ = process.env.URL || 'https://www.youtube.com/watch?v=fJ9rUzIMcZQ';
const args = ['--autoplay-policy=no-user-gesture-required', '--mute-audio'];
let ext;
if (MODE !== 'none') { ext = fs.mkdtempSync(path.join(os.tmpdir(), 'am-ext-')); for (const f of fs.readdirSync(path.join(root, 'dist'))) { if (f !== 'content.js') fs.symlinkSync(path.join(root, 'dist', f), path.join(ext, f)); } fs.copyFileSync(path.join(root, 'dist/content.js'), path.join(ext, 'content.js')); args.push(`--disable-extensions-except=${ext}`, `--load-extension=${ext}`); }
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'am-qa-')), { headless: false, channel: 'chromium', locale: 'en-US', viewport: { width: 1400, height: 900 }, args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('watchdog'); process.exit(2); }, 240000);
const log = []; const T0 = Date.now(); const L = (s) => { if (process.env.V) console.log(s); log.push(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`); };
let sw = null; if (MODE !== 'none') { sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker'); sw.on?.('console', () => {}); }
const page = await ctx.newPage();
page.on('console', (m) => { const t = m.text(); if (/avProbe|AllMixer|All Mixer|error|Error|fail/i.test(t)) L(`console.${m.type()}: ${t.slice(0, 300)}`); });
page.on('response', (r) => { if (r.status() >= 400 && /googlevideo|videoplayback|youtubei/.test(r.url())) L(`http ${r.status()} ${r.url().slice(0, 140)}`); });
page.on('pageerror', (e) => L(`pageerror: ${String(e).slice(0, 300)}`));
page.on('dialog', (d) => d.accept());
await page.addInitScript(() => { localStorage.setItem('allMixer.avProbe', '1'); window.addEventListener('beforeunload', (e) => e.stopImmediatePropagation(), true); });
await page.goto(URL_, { waitUntil: 'domcontentloaded' }); await sleep(3000);
for (const s of ['button[aria-label*="Accept"]', 'button:has-text("Accept all")', 'button:has-text("Reject all")']) { const b = page.locator(s).first(); if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(2000); break; } }
await page.waitForSelector('video', { timeout: 30000 });
const v = (fn, a) => page.evaluate(fn, a);
const ad = () => v(() => !!document.querySelector('#movie_player.ad-showing'));
const noAd = async () => { for (let i = 0; i < 90 && await ad(); i++) { await v(() => document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern')?.click()); await sleep(2000); } await sleep(1500); };
const snap = () => v(() => { const e = document.querySelector('video'); const er = document.querySelector('.ytp-error'); const vis = er && getComputedStyle(er).display !== 'none'; return { t: +e.currentTime.toFixed(2), paused: e.paused, rs: e.readyState, err: vis ? er.innerText.replace(/\s+/g, ' ').trim() : null, errCls: document.querySelector('#movie_player')?.className.match(/ytp-(?:error|player-error)\S*/)?.[0] ?? null, mediaErr: e.error ? `${e.error.code}:${e.error.message}` : null, ad: !!document.querySelector('#movie_player.ad-showing') }; });
const tabId = () => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
const setS = async (s) => { for (let i = 0; i < 30; i++) { try { const id = await tabId(); await sw.evaluate(([id, s]) => chrome.tabs.sendMessage(id, { type: 'apply-settings', settings: s }), [id, s]); return; } catch (e) { if (i % 10 == 9) console.log("setS err", String(e).slice(0, 200), page.url()); await sleep(2000); } } throw new Error('content script never answered'); };
await page.mouse.click(5, 450); await sleep(500);
await v(() => document.querySelector('video').play().catch(() => {})); await noAd(); await sleep(4000);
if (MODE === 'bypass') { await setS({ mode: 'default', masterPct: 100 }); L('settings: default/master100'); }
if (MODE === 'sep') { await setS({ mode: 'separate', masterPct: 100, vocalPct: 0, instrumentalPct: 100, separationQuality: 'auto' }); L('settings: separate karaoke'); await sleep(15000); }
await sleep(5000);
const rows = []; let errAt = null;
const step = async (label, fn) => { await noAd(); const t = Date.now(); await fn(); const out = []; for (const w of [300, 1000, 2000, 3500]) { await sleep(w - (out.length ? [300, 1000, 2000, 3500][out.length - 1] : 0)); out.push(await snap()); } const s = out[out.length - 1]; const anyErr = out.find((o) => o.err || o.errCls || o.mediaErr); const r = { label, snaps: out, error: !!anyErr, errText: anyErr?.err ?? anyErr?.errCls ?? anyErr?.mediaErr ?? null }; rows.push(r); L(`${label}: ${JSON.stringify(out.map((o) => [o.t, o.paused, o.err]))}`); if (anyErr && !errAt) { errAt = label; L(`ERROR at ${label}: ${JSON.stringify(anyErr)}`); fs.writeFileSync(path.join(OUT, `qa-sri233-${MODE}-${RUN}.json`), JSON.stringify({ MODE, RUN, errAt, rows, log }, null, 1)); console.log(MODE, RUN, 'errorAt:', errAt); process.exit(0); } return r; };
await page.keyboard.press('t'); await sleep(3000); L('theater on');
for (let i = 1; i <= N; i++) { await step(`theater pause #${i}`, () => v(() => document.querySelector('video').pause())); await sleep(3000 - 0); await step(`theater play #${i}`, () => v(() => document.querySelector('video').play().catch(() => {}))); await sleep(5000); if (errAt) break; }
const html = errAt ? await v(() => document.querySelector('.ytp-error')?.outerHTML.slice(0, 1500) ?? null) : null;
fs.writeFileSync(path.join(OUT, `qa-sri233-${MODE}-${RUN}.json`), JSON.stringify({ MODE, RUN, errAt, html, rows, log }, null, 1));
await page.screenshot({ path: path.join(OUT, `qa-sri233-${MODE}-${RUN}.png`) }).catch(() => {});
console.log(MODE, RUN, 'errorAt:', errAt); await Promise.race([ctx.close(), sleep(5000)]); process.exit(0);
