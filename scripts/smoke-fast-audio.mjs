// The fast audio path against real youtube.com: the page bridge keeps a copy of the audio the player appends; this checks that
// the copy decodes to the same sound the player plays (same timeline, no holes), and that Preload through the extension is faster
// with it than with the real-time recording. The popup page is opened as a tab whose "active tab" is the video tab (as smoke-preload.mjs).
// Usage: bun run build && node scripts/smoke-fast-audio.mjs [videoId] [out dir]
//   env: HEADED=1 to watch, ONLY_TAP=1 skips the Preload part, COMPARE=1 also preloads with the real-time recording to time it,
//        TOO_LONG=1 for a video over FAST_MAX_S: the tap part is skipped and Preload must record (and is cancelled after 20 s).
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const ext = path.join(root, 'dist');
const ID = process.argv[2] || 'dQw4w9WgXcQ'; // 3:33
const out = process.argv[3] || path.join(root, 'docs/screenshots/fast-audio');
fs.mkdirSync(out, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const check = (name, ok, info = '') => { console.log(ok ? 'PASS' : 'FAIL', name, info); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'am-fast-')), {
  headless: !process.env.HEADED, channel: 'chromium', locale: 'en-US',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  ignoreDefaultArgs: ['--enable-automation'], viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-blink-features=AutomationControlled', '--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const open = async () => {
  const page = await ctx.newPage();
  page.on('console', (m) => /All Mixer|preload|export/i.test(m.text()) && log('console:', m.text().slice(0, 240)));
  await page.goto(`https://www.youtube.com/watch?v=${ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#movie_player video', { timeout: 30000 });
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2 && Number.isFinite(v.duration); }, null, { timeout: 60000 });
  // an ad is not the video: wait it out (skip it when YouTube lets us)
  for (let i = 0; i < 90 && (await page.evaluate(() => !!document.querySelector('#movie_player.ad-showing'))); i++) {
    if (i === 0) log('an ad plays; waiting for it');
    await page.locator('.ytp-skip-ad-button, .ytp-ad-skip-button-modern').first().click({ timeout: 500 }).catch(() => {});
    await page.waitForTimeout(1000);
  }
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2 && Number.isFinite(v.duration) && !document.querySelector('#movie_player.ad-showing'); }, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  return page;
};

if (!process.env.TOO_LONG) {
// ---- A. the tap, through the page bridge (main world), against what the player plays
const page = await open();
const A = await page.evaluate(async () => {
  const TAG = '__allMixer';
  let id = 1;
  const ask = (req, ms = 30000) => new Promise((resolve) => {
    const my = id++;
    const on = (e) => { if (e.source === window && e.data?.[TAG] === 'res' && e.data.id === my) { removeEventListener('message', on); resolve(e.data.data); } };
    addEventListener('message', on);
    window.postMessage({ [TAG]: 'req', id: my, req }, location.origin);
    setTimeout(() => resolve(null), ms);
  });
  const v = document.querySelector('video');
  const url = v.currentSrc;
  const dur = v.duration;
  // scrub the way src/export/fast-audio.ts does
  const t0 = performance.now();
  v.pause(); v.muted = true;
  let st = await ask({ kind: 'audio-tap', op: 'status', url });
  const hole = (s) => { let t = 0; for (const [a, b] of s.covered) { if (a > t + 0.4) break; t = Math.max(t, b); } const e = t >= dur - 0.4 ? null : t; const c = s.incomplete[0]; return c === undefined ? e : e === null ? c : Math.min(e, c); };
  let steps = 0;
  for (let h; st?.usable && (h = hole(st)) !== null && steps < 100; steps++) {
    v.currentTime = Math.max(0, Math.min(h - 0.3, dur - 1));
    for (const s0 = Date.now(); Date.now() - s0 < 8000; ) { await new Promise((r) => setTimeout(r, 100)); st = await ask({ kind: 'audio-tap', op: 'status', url }); const n = hole(st); if (n === null || Math.abs(n - h) >= 0.4) break; }
  }
  const scrubMs = Math.round(performance.now() - t0);
  const file = await ask({ kind: 'audio-tap', op: 'take', url });
  if (!file) return { error: 'no file', st };
  const td = performance.now();
  const dec = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(file.data.slice(0));
  const decodeMs = Math.round(performance.now() - td);
  // play from `from` and record what the player outputs (the way the export engine records), then find where 4 s of it sit in the decoded sound
  const ref = dec.getChannelData(0);
  const D = 8;
  const dec8 = (a) => { const o = new Float32Array(Math.floor(a.length / D)); for (let i = 0; i < o.length; i++) { let x = 0; for (let k = 0; k < D; k++) x += Math.abs(a[i * D + k]); o[i] = x / D; } return o; };
  const ncc = (x, y, xo, yo, n) => { let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += x[xo + i]; my += y[yo + i]; } mx /= n; my /= n; let c = 0, ex = 0, ey = 0; for (let i = 0; i < n; i++) { const p = x[xo + i] - mx, q = y[yo + i] - my; c += p * q; ex += p * p; ey += q * q; } return c / (Math.sqrt(ex * ey) || 1); };
  const ac = new AudioContext({ sampleRate: 44100 });
  const rec = ac.createMediaStreamSource(v.captureStream());
  const sp = ac.createScriptProcessor(4096, 2, 2); const mute = ac.createGain(); mute.gain.value = 0;
  let got = []; sp.onaudioprocess = (e) => got.push(Float32Array.from(e.inputBuffer.getChannelData(0)));
  rec.connect(sp); sp.connect(mute); mute.connect(ac.destination);
  const probe = async (from) => {
    v.pause(); v.currentTime = from; await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    got = []; await v.play(); await new Promise((r) => setTimeout(r, 11000)); v.pause();
    const played = new Float32Array(got.length * 4096); got.forEach((g, i) => played.set(g, i * 4096));
    const N = 44100 * 4, P = 44100 * 5, seg = played.subarray(P, P + N);
    const expect = Math.round((from + 5) * 44100);
    const lo = Math.max(0, expect - 44100), s8 = dec8(seg), r8 = dec8(ref.subarray(lo, lo + 44100 * 2 + N));
    let best = -2, at8 = 0;
    for (let b = 0; b + s8.length <= r8.length; b++) { const c = ncc(s8, r8, 0, b, s8.length); if (c > best) { best = c; at8 = b; } }
    const bestIdx = lo + at8 * D;
    return { from, lagMs: +((bestIdx - expect) / 44.1).toFixed(2), corr: +best.toFixed(3) };
  };
  const probes = [await probe(0), await probe(Math.max(0, Math.floor(dur * 0.7)))];
  return { dur, decodedDur: dec.duration, sr: dec.sampleRate, ch: dec.numberOfChannels, scrubMs, steps, decodeMs, status: { usable: st.usable, bytes: st.bytes, covered: st.covered, incomplete: st.incomplete }, probes };
});
log('A', JSON.stringify(A));
check('tap usable', A?.status?.usable === true, JSON.stringify(A?.status?.covered));
check('whole video covered', A?.status?.covered?.length === 1 && A.status.covered[0][0] <= 0.4 && A.status.covered[0][1] >= A.dur - 0.4);
check('decoded length matches the video', Math.abs(A.decodedDur - A.dur) <= 1, `${A.decodedDur} vs ${A.dur}`);
check('read the whole video in seconds, not minutes', A.scrubMs < 15000, `${A.scrubMs} ms, ${A.steps} seeks`);
for (const p of A.probes) check(`decoded sound sits on the played sound at ${p.from} s (|lag| <= 120 ms; the start of a capture after a seek is not exact)`, Math.abs(p.lagMs) <= 120 && p.corr > 0.3, `lag ${p.lagMs} ms, corr ${p.corr}`);
await page.close();
}

// ---- B. Preload through the extension: fast path, then (COMPARE=1) the real-time recording for the time it saves
const until0 = async (fn, ms) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(200); } };
const preload = async (label, noFast, { stopAfterMs = 0 } = {}) => {
  await sw.evaluate((v) => chrome.storage.local.set({ 'debug.noFastAudio': v }), noFast);
  const page = await open();
  const url0 = page.url();
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: '*://www.youtube.com/*' }))[0].id);
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 900 });
  await popup.addInitScript(({ tabId, url }) => { chrome.tabs.query = async () => [{ id: tabId, url }]; }, { tabId, url: page.url() });
  await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup/popup.html`);
  await popup.waitForSelector('#tab-separate');
  const status = () => sw.evaluate(async (id) => chrome.tabs.sendMessage(id, { type: 'get-status' }), tabId);
  await page.evaluate(() => document.querySelector('video').play().catch(() => {}));
  await popup.click('#tab-separate');
  await sleep(800);
  if ((await popup.locator('#advanced-toggle').getAttribute('aria-expanded')) !== 'true') await popup.locator('#advanced-toggle').click();
  await sleep(500);
  const t0 = Date.now();
  await popup.click('#processing-preload');
  const stages = [];
  let st;
  for (;;) {
    st = await status();
    const p = st?.preload;
    const stage = p?.progress?.stage;
    if (stage && stages.at(-1)?.[0] !== stage) { stages.push([stage, Date.now() - t0]); log(label, 'stage', stage, p.progress.detail); }
    if (p?.state === 'ready' || p?.state === 'error') break;
    if (stopAfterMs && Date.now() - t0 > stopAfterMs) {
      await popup.click('#preload-cancel');
      await until0(async () => (await status())?.preload?.state === 'cancelled', 10000);
      check(`${label}: Cancel stops it`, true);
      await page.close(); await popup.close();
      return { ms: Date.now() - t0, dur: 0, stages, fast: stages.some(([s]) => s === 'fetching') };
    }
    if (Date.now() - t0 > 20 * 60000) throw new Error('timeout');
    await sleep(150);
  }
  const ms = Date.now() - t0;
  await sleep(600);
  await popup.screenshot({ path: path.join(out, `${label}-ready.png`), fullPage: true });
  check(`${label}: preload ready`, st.preload.state === 'ready', st.preload.progress?.error ?? `${(st.preload.bytes / 1e6).toFixed(1)} MB in ${(ms / 1000).toFixed(1)} s, stages ${JSON.stringify(stages)}`);
  check(`${label}: the page stayed on the video`, page.url() === url0, page.url());
  const dur = await page.evaluate(() => document.querySelector('video').duration);
  await page.evaluate(() => { const v = document.querySelector('video'); v.muted = false; v.currentTime = 20; return v.play(); });
  const peaks = [];
  for (let i = 0; i < 40; i++) { const pl = (await status()).preload.playing; if (pl) peaks.push(pl); await sleep(120); }
  check(`${label}: the cache sounds and is in step`, peaks.length > 5 && Math.max(...peaks.map((p) => p.level)) > 0.005 && peaks.every((p) => p.driftMs === null || Math.abs(p.driftMs) < 120), `peak ${Math.max(0, ...peaks.map((p) => p.level)).toFixed(3)}, drift ${peaks.slice(-4).map((p) => p.driftMs?.toFixed(0)).join(',')}`);
  await page.close(); await popup.close();
  return { ms, dur, stages, fast: stages.some(([s]) => s === 'fetching') };
};
if (process.env.TOO_LONG) {
  // a video over FAST_MAX_S is recorded: no `fetching` stage, a `recording` one, and Cancel works
  const r = await preload('long', false, { stopAfterMs: 20000 });
  check('long: recorded, not read from the player', !r.fast && r.stages.some(([s]) => s === 'recording'), JSON.stringify(r.stages));
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  await ctx.close();
  process.exit(failed ? 1 : 0);
}
if (process.env.ONLY_TAP) {
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  await ctx.close();
  process.exit(failed ? 1 : 0);
}
const fast = await preload('fast', false);
check('fast: the audio was read from the player, not recorded', fast.fast, JSON.stringify(fast.stages));
check('fast: far quicker than the video is long', fast.ms < fast.dur * 1000 * 0.5, `${(fast.ms / 1000).toFixed(1)} s for ${fast.dur.toFixed(0)} s of video`);
if (process.env.COMPARE) {
  const slow = await preload('recorded', true);
  check('recorded: really recorded', !slow.fast, JSON.stringify(slow.stages));
  log(`fast ${(fast.ms / 1000).toFixed(1)} s vs recorded ${(slow.ms / 1000).toFixed(1)} s`);
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
await ctx.close();
process.exit(failed ? 1 : 0);
