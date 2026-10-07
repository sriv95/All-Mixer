// SRI-213: real ML engine, real output-tap (qa-sri217-tap.js) + probe overlay edges + lyrics line, per scenario.
// Usage: SITE=music|www SCEN=basic,seek,rate,pending,default,layout,nav,stall OUT=dir REPS=3 node scripts/qa-sri213.mjs  (needs `npm run build`)
import path from 'node:path'; import os from 'node:os'; import fs from 'node:fs'; import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'am-ext-'));
for (const f of fs.readdirSync(path.join(root, 'dist'))) { if (f !== 'content.js') fs.symlinkSync(path.join(root, 'dist', f), path.join(ext, f)); }
fs.writeFileSync(path.join(ext, 'content.js'), fs.readFileSync(path.join(root, 'scripts/qa-sri217-tap.js'), 'utf8') + fs.readFileSync(path.join(root, 'dist/content.js'), 'utf8'));
const OUT = process.env.OUT || os.tmpdir(); const SITE = process.env.SITE || 'music'; const REPS = Number(process.env.REPS || 3);
const SCEN = (process.env.SCEN || 'basic,seek,rate,pending,default,layout,nav,stall').split(',');
const URL_ = process.env.URL || (SITE === 'music' ? 'https://music.youtube.com/watch?v=fJ9rUzIMcZQ' : 'https://www.youtube.com/watch?v=fJ9rUzIMcZQ');
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'am-qa-')), {
  headless: false, channel: 'chromium', locale: 'en-US', viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await ctx.newPage(); const probe = []; const traceLog = [];
page.on('console', (m) => { const t = m.text(); const k = t.match(/avProbe\] (overlayOn|overlayOff|videoOn|videoOff) (\{.*\})/); if (k) probe.push({ kind: k[1], ...JSON.parse(k[2]) }); const tr = t.match(/avProbe\] trace (\{.*\})/); if (tr) { const j = JSON.parse(tr[1]); if (['hold', 'flush', 'engine', 'video'].includes(j.kind)) traceLog.push(j); } });
page.on('dialog', (d) => d.accept());
await page.addInitScript(() => { localStorage.setItem('allMixer.avProbe', '1'); window.addEventListener('beforeunload', (e) => e.stopImmediatePropagation(), true); });
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
const lyr = () => v(() => { const find = (root) => { const c = root.querySelector('.line.current, .current[data-index]'); if (c) return c; for (const e of root.querySelectorAll('*')) { if (e.shadowRoot) { const r = find(e.shadowRoot); if (r) return r; } } return null; }; const c = find(document); return c ? Number(c.dataset.index ?? 0) : null; });
const results = []; const SEP = { mode: 'separate', masterPct: 100, vocalPct: 0, instrumentalPct: 100, separationQuality: 'auto' };
const save = () => fs.writeFileSync(path.join(OUT, `qa-sri213-${SITE}.json`), JSON.stringify({ results }, null, 1));
async function measure(scen, label, kind, d = 0, settle = 3500) {
  await noAd(); const lyBefore = await lyr(); await act(kind, d); const a = await v(() => window.__act); const lyAt = []; for (const w of [600, 1500, 2600]) { await sleep(w - (lyAt.length ? [600, 1500, 2600][lyAt.length - 1] : 0)); lyAt.push(await lyr()); } await sleep(Math.max(0, settle - 2600));
  const r = await v(async () => { document.dispatchEvent(new CustomEvent('am-dump')); await new Promise((r) => setTimeout(r, 100)); const D = JSON.parse(document.documentElement.getAttribute('data-am-dump') || '{"out":[],"el":[]}'); const a = window.__act;
    const edge = (arr, kv) => { const w = arr.filter((p) => p[0] >= a - 300 && p[0] <= a + 3600); if (!w.length) return null;
      if (kv === 'off') { for (let i = 0; i < w.length - 6; i++) if (w[i][0] >= a - 20 && w.slice(i, i + 6).every((p) => p[1] < 2e-4)) return +(w[i][0] - a).toFixed(0); return null; }
      for (let i = 0; i < w.length; i++) if (w[i][0] >= a && w[i][1] > 2e-3) return +(w[i][0] - a).toFixed(0); return null; };
    const before = D.out.filter((p) => p[0] < a && p[0] > a - 500).map((p) => p[1]); const e = document.querySelector('video'); const cv = document.querySelector('canvas.all-mixer-delayed-video');
    // silence run (for seek): first off edge then first on edge after it
    const w = D.out.filter((p) => p[0] >= a - 20 && p[0] <= a + 4000); let sOff = null, sOn = null; for (let i = 0; i < w.length - 6; i++) if (w.slice(i, i + 6).every((p) => p[1] < 2e-4)) { sOff = w[i][0] - a; for (let j = i; j < w.length; j++) if (w[j][1] > 2e-3) { sOn = w[j][0] - a; break; } break; }
    return { outBefore: +(before.reduce((x, y) => x + y, 0) / (before.length || 1)).toFixed(4), outOff: edge(D.out, 'off'), outOn: edge(D.out, 'on'), elOff: edge(D.el, 'off'), elOn: edge(D.el, 'on'), silStart: sOff && +sOff.toFixed(0), silEnd: sOn && +sOn.toFixed(0), paused: e.paused, canvas: cv ? getComputedStyle(cv).display : 'absent', t: +e.currentTime.toFixed(1), rate: e.playbackRate }; });
  const pe = (k) => { const x = probe.filter((p) => p.kind === k && p.at >= a - 50 && p.at <= a + 3600).sort((p, q) => p.at - q.at)[0]; return x ? +(x.at - a).toFixed(0) : null; };
  const st = await status().catch(() => ({})); const traces = traceLog.filter((x) => x.now >= a - 300 && x.now <= a + 3600).map((x) => { const { kind: tk, now, ...rest } = x; return { kind: tk, at: +(now - a).toFixed(0), ...rest }; }); const rec = { scen, label, kind, ...r, quietBefore: r.outBefore < 0.01, ...(kind === 'play' ? { elQuiet: r.elOn == null || r.elOn > 300 } : {}), reason: st.separation?.latency?.reason, choice: st.separation?.choice, traces, ovOn: pe('overlayOn'), ovOff: pe('overlayOff'), vidOn: pe('videoOn'), vidOff: pe('videoOff'), lyric: { before: lyBefore, at600: lyAt[0], at1500: lyAt[1], at2600: lyAt[2], after: await lyr() }, ad: await ad(), ytError: await v(() => !!document.querySelector('.ytp-error')), ov: st.videoDelay?.state, delayMs: st.videoDelay?.delayMs, sep: st.separation?.state, eng: st.separation?.latency?.engine, vdelay: st.separation?.latency?.videoDelayMs, audio: st.audio };
  rec.AO = rec.kind === 'play' && rec.outOn != null && rec.ovOn != null ? rec.outOn - rec.ovOn : null; results.push(rec); console.log(JSON.stringify(rec)); save(); return rec;
}
const mlReady = async () => { for (let i = 0; i < 60; i++) { const s = await status(); if (s.separation?.latency?.engine === 'ml') return true; await sleep(2000); } return false; };
const cycle = async (scen, tag, gap = 3000, n = REPS) => { for (let i = 1; i <= n; i++) { await measure(scen, `${tag} pause #${i}`, 'pause'); await sleep(gap); await measure(scen, `${tag} play #${i}`, 'play'); await sleep(5000); } };
await page.mouse.click(5, 450); await sleep(500);
await setS(SEP); await v(() => document.querySelector('video').play().catch(() => {}));
if (SITE === 'music') { await v(() => { const t = [...document.querySelectorAll('tp-yt-paper-tab')].find((x) => /lyrics/i.test(x.textContent)); t?.click(); }); await sleep(1500); }
console.log('ml ready', await mlReady()); await noAd(); await sleep(9000);
const has = (s) => SCEN.includes(s);
if (has('basic')) { await cycle('basic', 'short3s'); await measure('basic', 'pause 20s', 'pause'); await sleep(20000); await measure('basic', 'play after 20s', 'play'); await sleep(5000); await measure('basic', 'pause 20s', 'pause'); await sleep(20000); await measure('basic', 'play after 20s', 'play'); await sleep(5000); }
if (has('seek')) {
  for (let i = 1; i <= REPS; i++) { await measure('seek', `seek+30 playing #${i}`, 'seek', 30, 5000); await sleep(3000); }
  for (let i = 1; i <= REPS; i++) { await measure('seek', `seek-25 playing #${i}`, 'seek', -25, 5000); await sleep(3000); }
  for (let i = 1; i <= REPS; i++) { await measure('seek', `paused: pause #${i}`, 'pause'); await sleep(1500); await measure('seek', `paused: seek+20 #${i}`, 'seek', 20, 2500); await measure('seek', `paused: play after seek #${i}`, 'play', 0, 5000); await sleep(3000); }
}
if (has('rate')) { for (const r of [1.5, 0.5]) { await v((r) => { document.querySelector('video').playbackRate = r; }, r); await sleep(6000); const s = await status(); console.log('rate', r, JSON.stringify(s.videoDelay), JSON.stringify(s.separation?.latency)); results.push({ scen: 'rate', label: `rate ${r} status`, ov: s.videoDelay, lat: s.separation?.latency }); await cycle('rate', `rate${r}`, 3000, 2); }
  await v(() => { document.querySelector('video').playbackRate = 1; }); await sleep(5000); }
if (has('pending')) {
  // pause, change mode/preset while paused, play: change must apply
  await measure('pending', 'pause then switch Default', 'pause'); await setS({ mode: 'default', masterPct: 100 }); await sleep(2500); let s = await status(); results.push({ scen: 'pending', label: 'while paused after Default', ov: s.videoDelay, lat: s.separation?.latency, sep: s.separation?.state }); console.log('pending default', JSON.stringify(s.videoDelay), JSON.stringify(s.separation?.latency));
  await measure('pending', 'play after pending Default', 'play', 0, 5000); s = await status(); results.push({ scen: 'pending', label: 'after play (Default)', ov: s.videoDelay, lat: s.separation?.latency }); console.log('after play default', JSON.stringify(s.videoDelay), JSON.stringify(s.separation?.latency));
  await measure('pending', 'pause then switch Separate', 'pause'); await setS(SEP); await sleep(3000); s = await status(); console.log('pending sep', JSON.stringify(s.videoDelay), JSON.stringify(s.separation?.latency));
  await measure('pending', 'play after pending Separate', 'play', 0, 6000); s = await status(); results.push({ scen: 'pending', label: 'after play (Separate)', ov: s.videoDelay, lat: s.separation?.latency }); console.log('after play sep', JSON.stringify(s.videoDelay), JSON.stringify(s.separation?.latency));
  await measure('pending', 'pause then A cappella preset', 'pause'); await setS({ ...SEP, vocalPct: 100, instrumentalPct: 0 }); await sleep(2500); await measure('pending', 'play after preset change', 'play', 0, 5000); await setS(SEP); await sleep(3000);
}
if (has('default')) { await setS({ mode: 'default', masterPct: 100 }); await sleep(3500); await cycle('default', 'default', 3000, REPS); const s = await status(); results.push({ scen: 'default', label: 'status', ov: s.videoDelay, lat: s.separation?.latency }); await setS(SEP); await sleep(4000); await mlReady(); await sleep(6000); }
if (has('layout')) {
  if (SITE === 'www') {
    await page.keyboard.press('t');
    for (const [ms, lab] of [[500, '0.5s'], [2500, '3s'], [3000, '6s']]) { await sleep(ms); const s = await status().catch(() => ({})); const e = { scen: 'layout', label: `theater engine @${lab}`, eng: s.separation?.latency?.engine, reason: s.separation?.latency?.reason, choice: s.separation?.choice }; results.push(e); console.log(JSON.stringify(e)); }
    await cycle('layout', 'theater', 3000, 2); await page.keyboard.press('t'); await sleep(2000);
    await v(() => document.querySelector('#movie_player').requestFullscreen?.().catch(() => {})); await page.keyboard.press('f').catch(() => {}); await sleep(3000); console.log('fs', await v(() => !!document.fullscreenElement)); await cycle('layout', 'fullscreen', 3000, 2);
    await v(() => document.exitFullscreen?.().catch(() => {})); await sleep(1500);
  } else {
    const clicked = await v(() => { const t = document.querySelector('ytmusic-av-toggle'); const b = t && [...t.querySelectorAll('[role=button], button, .video-button, .song-button, tp-yt-paper-button')].find((x) => /video/i.test(x.textContent + x.className + (x.getAttribute('aria-label') || ''))); if (b) b.click(); return !!b; });
    console.log('video mode click', clicked); await sleep(4000);
    // SRI-228: start the cycle well inside a track, never in the quiet first seconds or near the end.
    const pos = () => v(() => { const e = document.querySelector('video'); return { t: +e.currentTime.toFixed(1), duration: +e.duration.toFixed(1) }; });
    const SEEKTO = Number(process.env.SEEKTO || 60);
    let p0 = await pos(); await act('seek', SEEKTO - p0.t); await sleep(8000);
    console.log('music-video-mode cycle start', JSON.stringify(p0 = await pos()));
    if (p0.t > p0.duration - 30) { await act('seek', SEEKTO - p0.t); await sleep(8000); console.log('too close to end, re-seeked', JSON.stringify(await pos())); }
    await cycle('layout', 'music-video-mode', 3000, 2);
    await v(() => document.querySelector('#movie_player')?.requestFullscreen?.().catch(() => {})); await sleep(2500); console.log('fs', await v(() => !!document.fullscreenElement)); { const q = await v(() => { const e = document.querySelector('video'); return { t: +e.currentTime.toFixed(1), duration: +e.duration.toFixed(1) }; }); console.log('music-fullscreen cycle start', JSON.stringify(q)); if (q.t > q.duration - 30) { await act('seek', SEEKTO - q.t); await sleep(8000); } } await cycle('layout', 'music-fullscreen', 3000, 2); await v(() => document.exitFullscreen?.().catch(() => {})); await sleep(1500);
  }
}
if (has('stall')) {
  await noAd(); await ctx.setOffline(true); await act('seek', 600); await sleep(6000); const s1 = await status().catch(() => ({})); const d1 = await v(() => { const e = document.querySelector('video'); return { rs: e.readyState, paused: e.paused, t: +e.currentTime.toFixed(1) }; });
  results.push({ scen: 'stall', label: 'offline stall', d1, ov: s1.videoDelay, audio: s1.audio }); console.log('stall', JSON.stringify(d1), JSON.stringify(s1.videoDelay));
  await ctx.setOffline(false); await sleep(12000); await measure('stall', 'after stall: pause', 'pause'); await sleep(2500); await measure('stall', 'after stall: play', 'play', 0, 6000);
}
if (has('lyrics')) {
  console.log('lyrics btn', await v(() => { const b = document.querySelector('[data-allmixer-lyrics-btn]'); return b ? [b.getAttribute('aria-pressed'), b.getBoundingClientRect().x] : null; })); await page.locator('[data-allmixer-lyrics-btn]').first().click({ timeout: 4000 }).catch((e) => console.log('btn click fail')); await sleep(7000); await page.screenshot({ path: path.join(OUT, `qa-sri213-${SITE}-lyrics.png`) });
  const dom = await v(() => ({ lyr: !!document.querySelector('[data-am-lyrics]'), cur: [...document.querySelectorAll('[data-am-lyrics] [data-index]')].length, curCls: document.querySelector('[data-am-lyrics] .current')?.className, kar: !!document.querySelector('.am-k-line'), tabs: [...document.querySelectorAll('tp-yt-paper-tab')].map((x) => x.textContent.trim()) }));
  console.log('lyrics dom', JSON.stringify(dom)); results.push({ scen: 'lyrics', label: 'dom', dom });
  const sample = async (tag, ms) => { const out = []; const t0 = Date.now(); while (Date.now() - t0 < ms) { out.push([Date.now() - t0, await lyr(), await v(() => +document.querySelector('video').currentTime.toFixed(2))]); await sleep(250); } results.push({ scen: 'lyrics', label: tag, samples: out }); console.log('lyrics', tag, JSON.stringify(out.map((x) => x[1]))); };
  await sample('playing 4s', 4000); await act('pause'); await sample('paused 5s (freeze)', 5000); await act('play'); await sample('resumed 6s', 6000);
  await act('seek', 30); await sample('after seek+30 6s', 6000);
}
if (has('nav')) {
  await noAd(); const before = await v(() => location.href);
  const nav = SITE === 'music' ? (await page.keyboard.press('Shift+N'), true) : await v(() => { const a = document.querySelector('#related a[href^="/watch?v="], ytd-watch-next-secondary-results-renderer a[href^="/watch?v="]'); if (a) { a.click(); return true; } return false; });
  console.log('nav click', nav); await sleep(9000); const after = await v(() => location.href); console.log('nav', before, '->', after);
  await noAd(); await sleep(4000); const s = await status().catch(() => ({})); results.push({ scen: 'nav', label: 'after navigation', before, after, ov: s.videoDelay, lat: s.separation?.latency, sep: s.separation?.state }); await mlReady(); await sleep(8000);
  await measure('nav', 'after nav: pause', 'pause'); await sleep(2500); await measure('nav', 'after nav: play', 'play', 0, 6000);
}
save(); await page.screenshot({ path: path.join(OUT, `qa-sri213-${SITE}-end.png`) }).catch(() => {}); await ctx.close();
