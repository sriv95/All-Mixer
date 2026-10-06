// SRI-202: real ML engine (Separate/Karaoke, no debug-video-delay), pause/play/seek events with probe + overlay/engine snapshots.
// Usage: URL=... SITE=music|www OUT=dir node scripts/qa-sri202.mjs   (needs `npm run build`)
import path from 'node:path'; import os from 'node:os'; import fs from 'node:fs'; import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const ext = path.join(root, 'dist'); const OUT = process.env.OUT || os.tmpdir(); const SITE = process.env.SITE || 'music';
const URL_ = process.env.URL || (SITE === 'music' ? 'https://music.youtube.com/watch?v=fJ9rUzIMcZQ' : 'https://www.youtube.com/watch?v=fJ9rUzIMcZQ');
const REPS = Number(process.env.REPS || 3);
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'am-qa-')), {
  headless: false, channel: 'chromium', locale: 'en-US', viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await ctx.newPage(); const logs = []; page.on('console', (m) => m.text().includes('[All Mixer! avProbe]') && !m.text().includes(' trace ') && logs.push(`${Date.now()} ${m.text().replace('[All Mixer! avProbe] ', '')}`));
page.on('dialog', (d) => d.accept());
await page.addInitScript(() => { localStorage.setItem('allMixer.avProbe', '1'); window.addEventListener('beforeunload', (e) => e.stopImmediatePropagation(), true); });
await page.goto(URL_, { waitUntil: 'domcontentloaded' }); await sleep(3000);
for (const s of ['button[aria-label*="Accept"]', 'button:has-text("Accept all")', 'button:has-text("Reject all")']) { const b = page.locator(s).first(); if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(2000); break; } }
await page.waitForSelector('video', { timeout: 30000 });
const tabId = () => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
const status = async () => { const id = await tabId(); return sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'get-status' }), id); };
const setS = async (s) => { const id = await tabId(); await sw.evaluate(([id, s]) => chrome.tabs.sendMessage(id, { type: 'apply-settings', settings: s }), [id, s]); };
const v = (fn, arg) => page.evaluate(fn, arg);
const ad = () => v(() => !!document.querySelector('#movie_player.ad-showing'));
const skip = () => v(() => { const b = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern'); if (b) b.click(); });
const noAd = async () => { for (let i = 0; i < 90 && await ad(); i++) { await skip(); await sleep(2000); } await sleep(1500); };
const dom = () => v(() => { const c = document.querySelector('canvas.all-mixer-delayed-video'); const e = document.querySelector('video'); return { canvas: c ? getComputedStyle(c).display : 'none(absent)', paused: e.paused, t: +e.currentTime.toFixed(2), rs: e.readyState }; });
const play0 = () => v(() => { window.__act = performance.now(); return document.querySelector('video').play().catch(() => {}); });
const pause0 = () => v(() => { window.__act = performance.now(); document.querySelector('video').pause(); });
const seek0 = (d) => v((d) => { const e = document.querySelector('video'); window.__act = performance.now(); e.currentTime = Math.max(0, e.currentTime + d); }, d);
const play = async () => { await noAd(); return play0(); }; const pause = async () => { await noAd(); return pause0(); }; const seek = async (d) => { await noAd(); return seek0(d); };
const events = []; const save = () => fs.writeFileSync(path.join(OUT, `qa-sri202-${SITE}.json`), JSON.stringify({ events, logs }, null, 1));
async function snap(label, settle) { console.error(new Date().toISOString(), label);
  await sleep(settle); const s = await status(); const d = await dom(); const p = s.avProbe ?? {};
  events.push({ label, actAt: await v(() => window.__act), nowAt: await v(() => performance.now()), wall: Date.now(), ad: await ad(), dom: d, overlay: s.videoDelay, latency: s.separation?.latency, sepState: s.separation?.state, choice: s.separation?.choice, audio: s.audio,
    probe: { audioOn: p.audioOn, audioOff: p.audioOff, videoOn: p.videoOn, videoOff: p.videoOff, overlayOn: p.overlayOn, overlayOff: p.overlayOff, playOffsetMs: p.playOffsetMs, pauseOffsetMs: p.pauseOffsetMs, pipelineMs: p.pipelineMs, last: (p.transitions ?? []).slice(-2) } }); save();
}
await page.mouse.click(5, 450); await sleep(500);
await setS({ mode: 'separate', masterPct: 100, vocalPct: 0, instrumentalPct: 100, separationQuality: 'auto' });
await v(() => document.querySelector('video').play().catch(() => {}));
// wait for ML to be ready (status "on" with 1971 ms)
for (let i = 0; i < 60; i++) { const s = await status(); if (s.separation?.latency?.engine === 'ml' || s.separation?.latency?.engine === 'ML') break; await sleep(2000); }
await noAd(); await sleep(8000); await snap('start', 1000);
for (let i = 1; i <= REPS; i++) { await pause(); await sleep(3000); await snap(`pause3 #${i}`, 0); await play(); await snap(`play-after-3s #${i}`, 4500); }
for (let i = 1; i <= REPS; i++) { await pause(); await sleep(20000); await snap(`pause20 #${i}`, 0); await play(); await snap(`play-after-20s #${i}`, 4500); }
for (let i = 1; i <= REPS; i++) { await seek(30); await snap(`seek+30 playing #${i}`, 4500); }
for (let i = 1; i <= REPS; i++) { await pause(); await sleep(2000); await seek(20); await sleep(1500); await play(); await snap(`seek-paused+20 then play #${i}`, 4500); }
for (let i = 1; i <= REPS; i++) { await seek(-25); await snap(`seek-25 playing #${i}`, 4500); }
fs.writeFileSync(path.join(OUT, `qa-sri202-${SITE}.json`), JSON.stringify({ events, logs }, null, 1));
for (const e of events) console.log(e.label.padEnd(34), 'ad', e.ad, 'eng', e.latency?.engine, 'lat', e.latency?.processingMs?.toFixed?.(0), e.latency?.deviceMs?.toFixed?.(0), e.latency?.videoDelayMs?.toFixed?.(0), '| ov', e.overlay?.state, e.overlay?.delayMs?.toFixed?.(0), 'cv', e.dom.canvas, '| play', e.probe.playOffsetMs?.toFixed(0), 'pause', e.probe.pauseOffsetMs?.toFixed(0), 'pipe', e.probe.pipelineMs?.toFixed(0));
await ctx.close();
