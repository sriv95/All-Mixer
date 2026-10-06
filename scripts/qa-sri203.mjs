// SRI-169: numeric audio-capture check. Taps the engine output (limiter -> ctx.destination) inside the extension's
// isolated world via CDP (patches AudioNode.prototype.connect there; no product change). usage: node qa-sri169.mjs <site> <videoId> <label> [startSec] [capSec]
import path from 'node:path'; import os from 'node:os'; import fs from 'node:fs'; import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const [site, vid, label, startS = '50', capS = '60', onlyMode = 'reference'] = process.argv.slice(2);
const ext = process.env.QA_EXT ?? path.join(root, 'dist');
const url = site === 'music' ? `https://music.youtube.com/watch?v=${vid}` : `https://www.youtube.com/watch?v=${vid}`;
const sel = site === 'music' ? 'video' : '#movie_player video';
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'am-169-')), { headless: false, channel: 'chromium', locale: 'en-US', viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
let mlLog = []; ctx.on('console', (m) => { if (/all-mixer ml/.test(m.text())) mlLog.push([Date.now(), m.text()]); });
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sw.evaluate(() => chrome.storage.local.set({ 'debug.mlTiming': true }));
const page = await ctx.newPage(); page.on('dialog', (d) => d.accept());
await page.addInitScript(() => { window.onbeforeunload = null; window.addEventListener('beforeunload', (e) => e.stopImmediatePropagation(), true); });
const cdp = await ctx.newCDPSession(page); const iso = [];
cdp.on('Runtime.executionContextCreated', (e) => { if (e.context.auxData?.type === 'isolated') iso.push(e.context); });
await cdp.send('Runtime.enable');
await page.goto(url); await sleep(5000);
for (const s of ['button:has-text("Accept all")', 'button:has-text("Reject all")']) { const b = page.locator(s).first(); if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(2000); break; } }
const isAd = () => page.evaluate(() => { const p = document.querySelector('#movie_player'); document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-container button')?.click(); return !!p?.classList.contains('ad-showing') || !!document.querySelector('.ad-showing'); });
const clear = async () => { for (let k = 0, ok = 0; k < 60 && ok < 3; k++) { if (await isAd()) ok = 0; else ok++; await sleep(ok ? 1000 : 2000); } };
await clear();
await page.screenshot({ path: path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(), `qa169-${label}-pre.png`) }); await page.mouse.click(5, 400); await sleep(300);
const id = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => /youtube.com\/watch/.test(t.url))?.id);
const set = (s) => sw.evaluate(([id, s]) => chrome.tabs.sendMessage(id, { type: 'apply-settings', settings: s }), [id, s]);
const status = () => sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'get-status' }), id);
// pick the isolated world that belongs to the extension content script
let wid = null;
for (const c of iso) { const r = await cdp.send('Runtime.evaluate', { contextId: c.id, expression: 'typeof chrome!=="undefined" && !!chrome.runtime && !!chrome.runtime.id' }).catch(() => null); if (r?.result?.value) { wid = c.id; break; } }
if (wid == null) { console.error('no isolated world', iso.map((c) => c.name)); process.exit(2); }
const ev = (expression) => cdp.send('Runtime.evaluate', { contextId: wid, expression, returnByValue: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; });
await ev(`(() => { if (window.__tap) return; const T = window.__tap = { chunks: [], wl: [], sr: 0, ready: false }; const AWN = window.AudioWorkletNode; window.AudioWorkletNode = class extends AWN { constructor(...a) { super(...a); this.port.addEventListener('message', (e) => { if (e.data && e.data.type === 'qa-w') T.wl.push(e.data); }); } }; const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dst, ...a) { const r = orig.call(this, dst, ...a);
    if (dst instanceof AudioDestinationNode && !this.__tapped && !this.__tap) { this.__tapped = true; const c = this.context; T.sr = c.sampleRate; const src = this;
      c.audioWorklet.addModule(chrome.runtime.getURL('worklet/qa-tap.js')).then(() => { const n = new AWN(c, 'qa-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' }); n.__tap = true; T.node = n;
        n.port.onmessage = (e) => { T.chunks.push(e.data); }; orig.call(src, n); T.ready = true; }); } return r; }; })()`);
await page.evaluate(([s, sec]) => { const v = document.querySelector(s); (document.querySelector('#movie_player')?.seekTo ? document.querySelector('#movie_player').seekTo(+sec, true) : (v.currentTime = +sec)); return v.play().catch(() => {}); }, [sel, startS]); await sleep(1500);
const base = { mode: 'default', masterPct: 101, vocalPct: 100, instrumentalPct: 100, separationQuality: 'auto' };
const MODES = { reference: base, karaoke: { ...base, mode: 'separate', masterPct: 100, vocalPct: 0 }, acappella: { ...base, mode: 'separate', masterPct: 100, instrumentalPct: 0 } };
const out = { label, site, vid, startS: +startS, modes: {}, load: os.loadavg() };
for (const [name, s] of Object.entries(MODES).filter(([k]) => k === onlyMode)) {
  await page.evaluate(([sel, sec]) => { const v = document.querySelector(sel); (document.querySelector('#movie_player')?.seekTo ? document.querySelector('#movie_player').seekTo(+sec, true) : (v.currentTime = +sec)); v.play().catch(() => {}); }, [sel, startS]);
  await set(s); let st, t0 = Date.now();
  while (Date.now() - t0 < 120000) { await sleep(2000); st = (await status()).separation ?? (await status()).sep; if (name === 'reference' || ['on', 'unavailable'].includes(st?.choice?.state)) break; }
  const sep = (await status()).separation; if (name !== 'reference' && sep?.latency?.engine !== 'ml') console.error(name, 'engine not ml', JSON.stringify(sep?.latency), JSON.stringify(sep?.choice));
  // wait until the delayed pipeline is steady and ad-free
  await sleep(6000); await clear();
  await page.evaluate(([sel, sec]) => { const v = document.querySelector(sel); if (Math.abs(v.currentTime - sec) > 20) (document.querySelector('#movie_player')?.seekTo ? document.querySelector('#movie_player').seekTo(+sec, true) : (v.currentTime = +sec)); v.play().catch(() => {}); }, [sel, startS]); await sleep(5000); await clear();
  const sec0 = await page.evaluate((s) => (document.querySelector('#movie_player')?.getCurrentTime?.() ?? document.querySelector(s).currentTime), sel);
  const vt = () => page.evaluate((s) => (document.querySelector('#movie_player')?.getCurrentTime?.() ?? document.querySelector(s).currentTime), sel);
  for (let tr = 0; tr < 6; tr++) { const a = await vt(); await sleep(2500); const b = await vt(); if (b - a > 2) break; console.error('video stalled', a, b, 'retry'); await page.evaluate(([sel, sec]) => { const v = document.querySelector(sel); (document.querySelector('#movie_player')?.seekTo ? document.querySelector('#movie_player').seekTo(+sec, true) : (v.currentTime = +sec)); v.play().catch(() => {}); }, [sel, startS]); await sleep(6000); await clear(); }
  while (!(await ev('window.__tap.ready'))) await sleep(200);
  const sec0r = await vt(); await ev('window.__tap.chunks=[]; window.__tap.wl=[]; window.__tap.node.port.postMessage({ rec: true })'); const wall0 = Date.now(); await sleep(+capS * 1000); await ev('window.__tap.node.port.postMessage({ rec: false })'); await sleep(500);
  console.error('vid', JSON.stringify(await page.evaluate((s) => [...document.querySelectorAll('video')].map((v) => ({ t: v.currentTime, p: v.paused, rs: v.readyState, d: v.duration, e: v.error?.code, s: v.src.slice(0, 30) })), sel)));
  const ad = await isAd(); const sec1 = await page.evaluate((s) => (document.querySelector('#movie_player')?.getCurrentTime?.() ?? document.querySelector(s).currentTime), sel);
  const b64 = await ev(`(() => { const T = window.__tap; const C = T.chunks.sort((a, b) => a.f0 - b.f0); const f0 = C[0].f0; const last = C[C.length - 1]; const n = last.f0 + last.d.length / 2 - f0; const m = new Float32Array(n); let gaps = 0; let cur = 0; for (const c of C) { if (c.f0 - f0 !== cur) gaps++; for (let i = 0; i < c.d.length / 2; i++) m[c.f0 - f0 + i] = (c.d[2 * i] + c.d[2 * i + 1]) / 2; cur = c.f0 - f0 + c.d.length / 2; } T.f0 = f0; T.gaps = gaps; const u = new Uint8Array(m.buffer); let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); })()`);
  const stb = await ev(`(() => { const T = window.__tap; const C = T.chunks; const f0 = T.f0; const n = C[C.length - 1].f0 + C[C.length - 1].d.length / 2 - f0; const m = new Float32Array(2 * n); for (const c of C) for (let i = 0; i < c.d.length / 2; i++) { m[c.f0 - f0 + i] = c.d[2 * i]; m[n + c.f0 - f0 + i] = c.d[2 * i + 1]; } const u = new Uint8Array(m.buffer); let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); })()`);
  fs.writeFileSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(), `qa203-${label}-${name}.st.f32`), Buffer.from(stb, 'base64'));
  const f0 = await ev('window.__tap.f0'); const gaps = await ev('window.__tap.gaps'); console.error('tap f0', f0, 'gaps', gaps);
  const buf = Buffer.from(b64, 'base64'); fs.writeFileSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(), `qa203-${label}-${name}.f32`), buf);
  const wl = await ev('JSON.stringify(window.__tap.wl)'); fs.writeFileSync(path.join(root, 'scripts', `qa-sri203-${label}-${name}-wl.json`), JSON.stringify({ wl: JSON.parse(wl), bt: [f0 / (await ev('window.__tap.sr'))], gaps, mlLog, wall0, sec0: sec0r, sec1 }));
  out.modes[name] = { sr: await ev('window.__tap.sr'), n: buf.length / 4, adDuring: ad, videoSec: [sec0, sec1], sep: sep && { state: sep.state, choice: sep.choice?.state, engine: sep.latency?.engine, procMs: sep.latency?.processingMs } };
  console.error(name, JSON.stringify(out.modes[name]));
}
fs.writeFileSync(path.join(root, 'scripts', `qa-sri203-${label}-${onlyMode}.json`), JSON.stringify(out, null, 1));
await ctx.close(); process.exit(0);
