// SRI-238: compact www lyrics pass (<=35 s of playback; www player dies ~40 s in automation). REF=<qa135-music.json> for line start times.
import path from 'node:path'; import os from 'node:os'; import fs from 'node:fs'; import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const ext = path.join(root, 'dist'), SITE = process.env.SITE || 'music', VID = process.env.VID || 'fJ9rUzIMcZQ', NEXT = process.env.NEXT, OUT = process.env.OUT || root + '/scripts';
const D = +(process.env.D || 2000);
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'am-qa-135-')), { headless: false, channel: 'chromium', locale: 'en-US', viewport: { width: 1400, height: 900 }, ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run'] });
if (SITE === 'music') await ctx.route(/doubleclick\.net|googlesyndication|\/pagead\/|\/api\/stats\/ads|\/ptracking|adservice\.google|\/get_midroll_info|ad_break/, (r) => r.abort());
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await ctx.newPage(); await page.addInitScript(() => { let c = null; const all = (root, out) => { if (root.querySelector?.('.line')) out.push(root); for (const e of root.querySelectorAll('*')) if (e.shadowRoot) all(e.shadowRoot, out); return out; };
  window.__amRoot = () => { if (c && c.host?.isConnected && c.querySelector('.line.current')) return c; const rs = all(document, []); c = rs.find((r) => r.querySelector('.line.current')) ?? rs.at(-1) ?? null; return c; }; }); page.on('dialog', (d) => d.accept());
const send = async (m) => { const id = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url()); return sw.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m), [id, m]); };
const R = { site: SITE, D, phases: {} };
const hygiene = () => page.evaluate(() => { window.onbeforeunload = null; addEventListener('beforeunload', (e) => e.stopImmediatePropagation(), true); });
const adwait = async () => { for (let i = 0; i < 45; i++) { const ad = await page.evaluate(() => { document.querySelector('.ytp-skip-ad-button,.ytp-ad-skip-button,.ytp-ad-skip-button-modern')?.click(); return !!document.querySelector('.ad-showing') && !!document.querySelector('.ytp-ad-text,.ytp-ad-preview-text,.ytp-ad-skip-button-container,.ad-interrupting'); }); if (!ad) return; await sleep(2000); } };
const goto = async (vid) => { await page.goto(`https://${SITE === 'music' ? 'music' : 'www'}.youtube.com/watch?v=${vid}`, { waitUntil: 'domcontentloaded' }); await sleep(3000);
  for (const s of ['button:has-text("Accept all")', 'button:has-text("Reject all")']) { const b = page.locator(s).first(); if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(1500); break; } }
  await page.waitForSelector('video', { timeout: 30000 }); await hygiene(); await adwait(); };
async function openLyrics() {
  if (SITE !== 'music' && await page.evaluate(() => { const r = window.__amRoot(); const h = r?.host; return !!h && h.getBoundingClientRect().width > 50 && !!r.querySelector('.line.current'); })) return;
  if (SITE === 'music') await page.locator('tp-yt-paper-tab:has-text("Lyrics")').first().click({ timeout: 8000 }).catch(() => {});
  else await page.locator('[data-allmixer-lyrics-btn]').first().click({ timeout: 8000 }).catch(() => {});
  await sleep(5000);
}
const lines = () => page.evaluate(() => window.__amRoot()?.querySelectorAll('.line').length ?? 0);
// in-page logger: records every change of current line and every 100ms sample

const startLog = () => page.evaluate(() => { window.__log = []; const v = document.querySelector('video'); let last = -2;
  window.__t = setInterval(() => { const cur = window.__amRoot()?.querySelector('.line.current'); const i = cur ? +cur.dataset.index : -1;
    window.__log.push({ w: Math.round(performance.now()), i, ct: +v.currentTime.toFixed(2), p: v.paused, r: v.playbackRate, ad: document.querySelector('#movie_player')?.classList.contains('ad-showing') ? 1 : 0, e: v.error?.code ?? 0, u: location.search }); }, 50); });
const stopLog = async () => { const l = await page.evaluate(() => { clearInterval(window.__t); return window.__log; }); return l; };
const flips = (log) => { const f = []; for (const s of log) if (!f.length || f.at(-1).i !== s.i) f.push(s); return f; };
const play = () => page.evaluate(() => document.querySelector('video').play());
const pause = () => page.evaluate(() => { window.__pw = performance.now(); document.querySelector('video').pause(); return window.__pw; });
const shot = (n) => page.screenshot({ path: path.join(OUT, `qa135-${SITE}-${n}.png`) });
const REF = JSON.parse(fs.readFileSync(process.env.REF, 'utf8')); const T = new Map(REF.refLines); const exp = (t) => { let b = -1; for (const [i, s] of T) if (s - 0.15 <= t && i > b) b = i; return b; };
await sw.evaluate(async () => { const o = (await chrome.storage.local.get('lyricsPrefs')).lyricsPrefs ?? {}; await chrome.storage.local.set({ lyricsPrefs: { ...o, lyricsVisible: true, lyricsDisplayMode: 'window' } }); });
await goto(VID); await page.evaluate(() => document.querySelector('video').pause());
await send({ type: 'apply-settings', settings: { mode: 'separate', masterPct: 100, vocalPct: 100, instrumentalPct: 100, separationQuality: 'auto' } });
for (let i = 0; i < 40; i++) { const s = await send({ type: 'get-status' }); if (s.separation?.state === 'on') { R.sepState = 'on'; break; } await sleep(1500); }
await send({ type: 'debug-video-delay', delayMs: D }); await openLyrics(); R.nLines = await lines(); await sleep(1500);
const t0 = Date.now(); const seekTo = (t) => page.evaluate((t) => { document.querySelector('video').currentTime = t; }, t);
await seekTo(5); await sleep(1000); await startLog(); await play(); await sleep(9000);
{ const log = await stopLog(); const play0 = log.find((s) => !s.p); const errs = log.filter((s) => !s.p && s.i >= 0).map((s) => s.i - exp(s.ct - D / 1000)); const f = flips(log).filter((x) => x.i >= 0).map((x) => ({ i: x.i, ct: x.ct, lead: +(x.ct - ((T.get(x.i) ?? NaN) + D / 1000)).toFixed(2) }));
  R.steady = { maxAbsIdxErr: Math.max(...errs.map(Math.abs)), flips: f }; }
await startLog(); await sleep(500); const pw = await pause(); const ctAtPause = await page.evaluate(() => document.querySelector('video').currentTime); await sleep(4000);
{ const log = await stopLog(); const after = log.filter((s) => s.w >= pw); const f = flips(after);
  R.pause = { ctAtPause, expHeard: exp(ctAtPause), expSeenAtClick: exp(ctAtPause - D / 1000), idxAtClick: after[0]?.i, flipsAfterClick: f.map((x) => ({ dtMs: x.w - pw, i: x.i })), finalIdx: after.at(-1).i, wentBack: f.some((x, k) => k && x.i < f[k - 1].i) }; }
await startLog(); await sleep(300); const t3 = await page.evaluate(() => { window.__pl = performance.now(); document.querySelector('video').play(); return window.__pl; }); await sleep(5000);
{ const log = await stopLog(); const after = log.filter((s) => s.w >= t3); const f = flips(after);
  R.play = { idxAtPlay: after[0].i, flips: f.map((x) => ({ dtMs: x.w - t3, i: x.i, ct: x.ct })), wentBack: f.some((x, k) => k && x.i < f[k - 1].i), finalIdx: after.at(-1).i, expFinal: exp(after.at(-1).ct - D / 1000) }; }
await pause(); await sleep(1000); await startLog(); await sleep(300);
const ts = await page.evaluate(() => { window.__sk = performance.now(); document.querySelector('video').currentTime = 30; return window.__sk; }); await sleep(5000);
{ const log = await stopLog(); const after = log.filter((s) => s.w >= ts); const f = flips(after);
  R.seek_bar_paused = { idxBefore: after[0].i, flips: f.map((x) => ({ dtMs: x.w - ts, i: x.i, ct: x.ct })), finalIdx: after.at(-1).i, expectedFinal: exp(30 - 0) }; }
R.ytpError = await page.evaluate(() => !!document.querySelector('.ytp-error')); R.elapsedS = (Date.now() - t0) / 1000; R.status = (await send({ type: 'get-status' })).separation?.latency;
await shot('short-end'); console.log(JSON.stringify(R, null, 1)); await ctx.close();
