// SRI-217: measure the real audio output edge (analyser tapped on whatever connects to ctx.destination) after pause/play/seek, plus element-side edge and avProbe 'hold' trace rows.
// Usage: SITE=music|www OUT=dir REPS=3 node scripts/qa-sri217.mjs   (needs `npm run build`)
import path from 'node:path'; import os from 'node:os'; import fs from 'node:fs'; import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'am-ext-')); // dist copy whose content.js is prefixed with the output-tap patch (the isolated world cannot be patched from the page)
for (const f of fs.readdirSync(path.join(root, 'dist'))) { if (f !== 'content.js') fs.symlinkSync(path.join(root, 'dist', f), path.join(ext, f)); }
fs.writeFileSync(path.join(ext, 'content.js'), fs.readFileSync(path.join(root, 'scripts/qa-sri217-tap.js'), 'utf8') + fs.readFileSync(path.join(root, 'dist/content.js'), 'utf8')); const OUT = process.env.OUT || os.tmpdir(); const SITE = process.env.SITE || 'music'; const REPS = Number(process.env.REPS || 3);
const URL_ = process.env.URL || (SITE === 'music' ? 'https://music.youtube.com/watch?v=fJ9rUzIMcZQ' : 'https://www.youtube.com/watch?v=fJ9rUzIMcZQ');
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'am-qa-')), {
  headless: false, channel: 'chromium', locale: 'en-US', viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await ctx.newPage(); const traces = [];
page.on('console', (m) => { const t = m.text(); if (t.includes('[All Mixer! avProbe]') && /trace/.test(t) && /hold/.test(t)) traces.push(t.replace('[All Mixer! avProbe] ', '')); });
page.on('dialog', (d) => d.accept());
await page.addInitScript(() => {
  localStorage.setItem('allMixer.avProbe', '1'); window.addEventListener('beforeunload', (e) => e.stopImmediatePropagation(), true);
});
await page.goto(URL_, { waitUntil: 'domcontentloaded' }); await sleep(3000);
for (const s of ['button[aria-label*="Accept"]', 'button:has-text("Accept all")', 'button:has-text("Reject all")']) { const b = page.locator(s).first(); if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(2000); break; } }
await page.waitForSelector('video', { timeout: 30000 });
const tabId = () => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
const status = async () => { const id = await tabId(); return sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'get-status' }), id); };
const setS = async (s) => { const id = await tabId(); await sw.evaluate(([id, s]) => chrome.tabs.sendMessage(id, { type: 'apply-settings', settings: s }), [id, s]); };
const v = (fn, a) => page.evaluate(fn, a);
const ad = () => v(() => !!document.querySelector('#movie_player.ad-showing'));
const skip = () => v(() => { const b = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern'); if (b) b.click(); });
const noAd = async () => { for (let i = 0; i < 90 && await ad(); i++) { await skip(); await sleep(2000); } await sleep(1500); };
const act = (kind, d = 0) => v(([kind, d]) => { const e = document.querySelector('video'); window.__act = performance.now(); if (kind === 'pause') e.pause(); else if (kind === 'play') e.play().catch(() => {}); else e.currentTime = Math.max(0, e.currentTime + d); }, [kind, d]);
const results = [];
async function measure(label, kind, d, settle = Number(process.env.SETTLE || 3500)) {
  await noAd(); const t0 = await act(kind, d); await sleep(settle);
  const r = await v(async () => { document.dispatchEvent(new CustomEvent('am-dump')); await new Promise((r) => setTimeout(r, 100)); const D = JSON.parse(document.documentElement.getAttribute('data-am-dump') || '{"out":[],"el":[]}'); window.__out = D.out; window.__el = D.el; const a = window.__act; const edge = (arr, kindv) => { const w = arr.filter((p) => p[0] >= a - 300 && p[0] <= a + 3200); if (!w.length) return null;
      if (kindv === 'off') { for (let i = 0; i < w.length - 6; i++) if (w[i][0] >= a - 20 && w.slice(i, i + 6).every((p) => p[1] < 2e-4)) return +(w[i][0] - a).toFixed(0); return null; }
      for (let i = 0; i < w.length; i++) if (w[i][0] >= a && w[i][1] > 2e-3) return +(w[i][0] - a).toFixed(0); return null; };
    const before = window.__out.filter((p) => p[0] < a && p[0] > a - 500).map((p) => p[1]); return { outBefore: +(before.reduce((x, y) => x + y, 0) / (before.length || 1)).toFixed(4), outOff: edge(window.__out, 'off'), outOn: edge(window.__out, 'on'), elOff: edge(window.__el, 'off'), elOn: edge(window.__el, 'on'), nOut: window.__out.length, paused: document.querySelector('video').paused }; });
  const st = await status().catch(() => ({})); const rec = { label, kind, ...r, ad: await ad(), t: await v(() => +document.querySelector('video').currentTime.toFixed(1)), state: st.separation?.state, audio: st.audio }; results.push(rec); console.log(JSON.stringify(rec)); fs.writeFileSync(path.join(OUT, `qa-sri217-${SITE}.json`), JSON.stringify({ results, traces }, null, 1));
}
await page.mouse.click(5, 450); await sleep(500);
await setS({ mode: 'separate', masterPct: 100, vocalPct: 0, instrumentalPct: 100, separationQuality: 'auto' });
await v(() => document.querySelector('video').play().catch(() => {}));
for (let i = 0; i < 60; i++) { const s = await status(); if (s.separation?.latency?.engine === 'ml') break; await sleep(2000); }
await noAd(); await sleep(1500);
await measure('pause 1.5s after ML ready (early)', 'pause'); await measure('play after early pause', 'play');
await sleep(Number(process.env.GAP || 8000));
if (process.env.DIAG) { for (let i = 1; i <= 2; i++) { await measure(`pause #${i}`, 'pause'); await sleep(Number(process.env.GAP3 || 2500)); await measure(`play #${i}`, 'play');
  for (let k = 0; k < 12; k++) { await sleep(1000); console.log('diag', JSON.stringify(await v(() => { const e = document.querySelector('video'); return { t: +e.currentTime.toFixed(2), src: e.src.slice(-30), dur: e.duration, ended: e.ended, paused: e.paused, rs: e.readyState, ad: !!document.querySelector('#movie_player.ad-showing'), n: document.querySelectorAll('video').length, title: document.title.slice(0, 40) }; }))); }
  await page.screenshot({ path: path.join(OUT, `qa-sri217-diag-${i}.png`) }); } await ctx.close(); process.exit(0); }
for (let i = 1; i <= REPS; i++) { await measure(`pause #${i}`, 'pause'); await sleep(Number(process.env.GAP3 || 2500)); await measure(`play #${i}`, 'play'); await sleep(Number(process.env.GAP2 || 5000)); }
for (let i = 1; i <= REPS; i++) { await measure(`pause-seek-play #${i}: pause`, 'pause'); await act('seek', 20); await sleep(1500); await measure(`pause-seek-play #${i}: play`, 'play'); await sleep(Number(process.env.GAP2 || 5000)); }
const s = await status(); console.log('latency', JSON.stringify(s.separation?.latency)); fs.writeFileSync(path.join(OUT, `qa-sri217-${SITE}.json`), JSON.stringify({ results, traces, latency: s.separation?.latency }, null, 1));
await ctx.close();
