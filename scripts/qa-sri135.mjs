// SRI-135: lyrics vs delayed picture at D=2s. SITE=music|www VID=<id> NEXT=<id> OUT=<dir> node scripts/qa-sri135.mjs
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

if (SITE !== 'music') await sw.evaluate(async () => { const o = (await chrome.storage.local.get('lyricsPrefs')).lyricsPrefs ?? {}; await chrome.storage.local.set({ lyricsPrefs: { ...o, lyricsVisible: true, lyricsDisplayMode: 'window' } }); });
await goto(VID); await page.evaluate(() => document.querySelector('video').play().catch(() => {}));
if (SITE === 'music') { /* ok */ }
// separate mode
await send({ type: 'apply-settings', settings: { mode: 'separate', masterPct: 100, vocalPct: 100, instrumentalPct: 100, separationQuality: 'auto' } });
for (let i = 0; i < 60; i++) { const s = await send({ type: 'get-status' }); if (s.separation?.state === 'on' || s.separation?.state === 'active' || i > 40) { R.sepState = s.separation?.state; break; } await sleep(2000); }
console.error('sep',R.sepState); await openLyrics(); R.nLines = await lines(); console.error('lines',R.nLines);
// reference timetable: D=0, play 0..70 s, record ct at which each line becomes current
await send({ type: 'debug-video-delay', delayMs: 0 }); await sleep(2000);
await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 0; v.play(); }); await sleep(2500); await adwait();
await shot('dbg-pre'); await startLog(); await sleep(8000); await shot('dbg-8s'); await sleep(67000); const refRaw = await stopLog(); console.error('dbg', await page.evaluate(() => { const r = window.__amRoot(); return JSON.stringify({ r: !!r, n: r?.querySelectorAll('.line').length, cur: r?.querySelectorAll('.current').length, cls: [...(r?.querySelectorAll('.line') ?? [])].slice(0, 3).map((e) => e.className), ct: document.querySelector('video').currentTime, url: location.href }); })); console.error('refraw', refRaw.length, JSON.stringify(refRaw.filter((_, k) => k % 200 === 0)), JSON.stringify(await send({ type: 'get-status' })).slice(0, 600)); const ref = flips(refRaw); R.ref = ref.map((x) => ({ i: x.i, ct: x.ct }));
const T = new Map(); for (const x of ref) if (x.i >= 0 && !T.has(x.i)) T.set(x.i, x.ct);
// expected line for a media time t (last line whose start <= t)
const exp = (t) => { let b = -1; for (const [i, s] of T) if (s - 0.15 <= t && i > b) b = i; return b; };
R.refLines = [...T.entries()];
console.error('ref',R.refLines.length);
await send({ type: 'debug-video-delay', delayMs: D }); await sleep(3000);
const seekTo = async (t) => { await page.evaluate((t) => { document.querySelector('video').currentTime = t; }, t); };
// 1 steady
await seekTo(5); await sleep(1500); await play(); await sleep(6000); await startLog(); await sleep(20000);
{ const log = await stopLog(); const errs = log.filter((s) => !s.p && s.i >= 0).map((s) => s.i - exp(s.ct - D / 1000)); const flipsL = flips(log).filter((f) => f.i >= 0).map((f) => ({ i: f.i, ct: f.ct, expectedStartPlusD: (T.get(f.i) ?? NaN) + D / 1000, lead: f.ct - ((T.get(f.i) ?? NaN) + D / 1000) }));
  R.phases.steady = { maxAbsIdxErr: Math.max(...errs.map(Math.abs)), flips: flipsL }; await shot('1-steady'); }
// 2 pause
await startLog(); await sleep(1000); const pw = await pause(); const ctAtPause = await page.evaluate(() => document.querySelector('video').currentTime); await sleep(6000);
{ const log = await stopLog(); const after = log.filter((s) => s.w >= pw); const f = flips(after); const lastFlip = f.at(-1);
  R.phases.pause = { ctAtPause, expIdxAtPauseHeard: exp(ctAtPause), expIdxAtPauseSeenWhenClicked: exp(ctAtPause - D / 1000), idxAtClick: after[0]?.i, flipsAfterClick: f.map((x) => ({ dtMs: x.w - pw, i: x.i })), finalIdx: after.at(-1).i, lastAdvanceMs: lastFlip.w - pw, wentBack: f.some((x, k) => k && x.i < f[k - 1].i) }; await shot('2-paused'); }
// 3 play after pause
await startLog(); await sleep(500); const t3 = await page.evaluate(() => { window.__pl = performance.now(); document.querySelector('video').play(); return window.__pl; }); await sleep(8000);
{ const log = await stopLog(); const after = log.filter((s) => s.w >= t3); const f = flips(after);
  const ctMoved = after.find((s) => s.ct > after[0].ct + 0.05); R.phases.play = { idxAtPlay: after[0].i, flips: f.map((x) => ({ dtMs: x.w - t3, i: x.i, ct: x.ct })), videoCtStartMovedMs: ctMoved ? ctMoved.w - t3 : null, wentBack: f.some((x, k) => k && x.i < f[k - 1].i), finalIdx: after.at(-1).i, finalCt: after.at(-1).ct, expFinal: exp(after.at(-1).ct - D / 1000) }; }
// 4 seeks
const checkSeek = async (name, target, paused, how) => {
  await seekTo(8); await sleep(1500); if (paused) { await pause(); await sleep(4000); } else { await play(); await sleep(4000); }
  await startLog(); await sleep(500);
  const idxBefore = await page.evaluate(() => +(window.__amRoot()?.querySelector('.line.current')?.dataset.index ?? -1));
  const ts = await page.evaluate(async ([target, how]) => { window.__sk = performance.now(); if (how === 'bar') document.querySelector('video').currentTime = target;
    else { const ls = window.__amRoot().querySelectorAll('.line'); const el = ls[target]; el.click(); } return window.__sk; }, [target, how]);
  await sleep(7000); const log = await stopLog(); const after = log.filter((s) => s.w >= ts); const f = flips(after);
  const expIdx = how === 'bar' ? exp(after.at(-1).ct - D / 1000) : null;
  R.phases[name] = { idxBefore, how, target, paused, flips: f.map((x) => ({ dtMs: x.w - ts, i: x.i, ct: x.ct })), finalIdx: after.at(-1).i, finalCt: after.at(-1).ct, expectedFinal: expIdx, targetLineStartCt: how === 'line' ? T.get(target) : null, firstJumpMs: (f.find((x) => x.i !== idxBefore) ?? {}).w - ts };
  await shot('4-' + name);
};
await checkSeek('seek_bar_playing', 40, false, 'bar');
await checkSeek('seek_bar_paused', 40, true, 'bar');
const li = [...T.keys()].filter((i) => i >= 6)[4];
await checkSeek('seek_line_playing', li, false, 'line');
await checkSeek('seek_line_paused', li, true, 'line');
// 5 rate 1.5
await send({ type: 'debug-video-delay', delayMs: D }); await seekTo(5); await play(); await sleep(3000);
await page.evaluate(() => { document.querySelector('video').playbackRate = 1.5; }); await sleep(5000); await startLog(); await sleep(20000);
{ const log = await stopLog(); const f = flips(log).filter((x) => x.i >= 0); const errs = log.filter((s) => s.i >= 0).map((s) => s.i - exp(s.ct - D / 1000));
  R.phases.rate15 = { rate: log.at(-1).r, maxAbsIdxErr: Math.max(...errs.map(Math.abs)), flips: f.map((x) => ({ i: x.i, ct: x.ct, lead: x.ct - ((T.get(x.i) ?? NaN) + D / 1000) })) }; await shot('5-rate'); }
await page.evaluate(() => { document.querySelector('video').playbackRate = 1; });
// 6 SPA nav to NEXT
if (NEXT) {
  R.spa = {};
  if (SITE === 'music') await page.evaluate((n) => { const a = document.createElement('a'); a.href = `/watch?v=${n}`; document.body.appendChild(a); a.click(); }, NEXT);
  else await page.evaluate((n) => { const a = document.querySelector(`a[href*="watch?v="]`); const b = document.createElement('a'); b.href = `/watch?v=${n}`; b.className = 'yt-simple-endpoint'; document.body.appendChild(b); b.click(); }, NEXT);
  await sleep(8000); await adwait(); R.spa.url = page.url(); await openLyrics().catch(() => {}); R.spa.nLines = await lines();
  await send({ type: 'debug-video-delay', delayMs: D }); await sleep(2000);
  await pause().catch(() => {}); await sleep(5000); await page.evaluate(() => document.querySelector('video').currentTime = 20); await sleep(1500);
  await play(); await sleep(3000); await startLog(); await sleep(15000); const l = await stopLog();
  R.spa.flips = flips(l).filter((x) => x.i >= 0).map((x) => ({ i: x.i, ct: x.ct })); R.spa.stuck = flips(l).length <= 1; await shot('6-spa');
}
fs.writeFileSync(path.join(OUT, `qa135-${SITE}.json`), JSON.stringify(R, null, 1)); console.log(JSON.stringify(R.phases, null, 1).slice(0, 6000)); console.log('spa', JSON.stringify(R.spa)); console.log('nLines', R.nLines, 'sep', R.sepState, 'refLines', R.refLines.length);
await ctx.close();
