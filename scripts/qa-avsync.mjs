// SRI-95 QA: A/V sync probe at pause / play / seek / rate. Usage: node scripts/qa-avsync.mjs  (needs `npm run build`)
// May need PLAYWRIGHT_BROWSERS_PATH=~/Library/Caches/ms-playwright. Prints one row per pause/play transition (paired by the probe)
// Prints a table of picture-vs-sound offsets (ms, want ~0) for Default then Separate mode.
import path from 'node:path'; import os from 'node:os'; import fs from 'node:fs'; import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const ext = path.join(root, 'dist'); const OUT = process.env.OUT || os.tmpdir();
const URL_ = process.env.URL || 'https://music.youtube.com/watch?v=fJ9rUzIMcZQ';
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'am-qa-')), {
  headless: false, channel: 'chromium', locale: 'en-US', viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = { mode: 'default', masterPct: 100, vocalPct: 100, instrumentalPct: 100, separationQuality: 'auto' };
const page = await ctx.newPage(); const logs = []; page.on('console', (m) => m.text().includes('[All Mixer! avProbe]') && logs.push(m.text()));
await page.addInitScript(() => localStorage.setItem('allMixer.avProbe', '1'));
await page.goto(URL_, { waitUntil: 'domcontentloaded' }); await sleep(3000);
for (const s of ['button[aria-label*="Accept"]', 'button:has-text("Accept all")', 'button:has-text("Reject all")']) { const b = page.locator(s).first(); if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(2000); break; } }
await page.waitForSelector('video', { timeout: 30000 });
const tabId = () => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
const setS = async (s) => { const id = await tabId(); await sw.evaluate(([id, s]) => chrome.tabs.sendMessage(id, { type: 'apply-settings', settings: s }), [id, s]); };
const probe = async () => { const id = await tabId(); return (await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'get-status' }), id)).avProbe; };
const v = (fn, arg) => page.evaluate(fn, arg);
const play = () => v(() => document.querySelector('video').play().catch(() => {}));
const pause = () => v(() => document.querySelector('video').pause());
const f = (x) => (x === undefined || x === null ? '   -  ' : x.toFixed(1).padStart(6));
// Must outlast the widest pairing window (overlay delay + latency + margin, ~5.3 s) or transitions land on the wrong step.
const STEP_WAIT = Number(process.env.STEP_WAIT || 6500);
const rows = []; let seen = 0;
// Collect transitions the probe finished since the last step, tagged with the step label.
async function step(mode, label) {
  await sleep(STEP_WAIT); const p = await probe();
  if (process.env.RAW) console.error(JSON.stringify({ mode, label, probeOn: p?.probeOn, audioAttached: p?.audioAttached, ctxState: p?.ctxState }));
  if (!p) { rows.push({ mode, label, kind: '-', missing: ['avProbe absent (probe off)'] }); return; }
  const all = p.transitions ?? []; const fresh = all.filter((t) => t.at > seen);
  if (!fresh.length) rows.push({ mode, label, kind: '-', missing: [`no transition (probeOn=${p.probeOn} audioAttached=${p.audioAttached} ctx=${p.ctxState})`] });
  for (const t of fresh) { seen = Math.max(seen, t.at); rows.push({ mode, label, kind: t.kind, off: t.kind === 'pause' ? t.pauseOffsetMs : t.playOffsetMs, pipe: t.pipelineMs, level: t.level, missing: t.missing, ctx: p.ctxState }); }
}
// One real gesture (neutral spot, not the player) so the AudioContext may start.
await page.mouse.click(5, 450); await sleep(500);
await play(); await sleep(4000);
// SRI-128: VARIANTS (comma list, default all) bisects the resume lead. Steps per variant: 3x pause/play + 1 seek.
const dbg = async (delayMs) => { const id = await tabId(); await sw.evaluate(([id, d]) => chrome.tabs.sendMessage(id, { type: 'debug-video-delay', delayMs: d }), [id, delayMs]); };
const VARS = {
  default150: { mode: 'default', pct: 150, wait: 2500 },
  'default150+overlay2000': { mode: 'default', pct: 150, wait: 2500, debug: 2000 },
  separate: { mode: 'separate', pct: 100, wait: 8000 },
  'separate+overlay0': { mode: 'separate', pct: 100, wait: 8000, debug: 0 },
  'separate+bypass': { mode: 'separate', pct: 100, wait: 1000 },
};
const want = (process.env.VARIANTS || Object.keys(VARS).join(',')).split(',').map((x) => x.trim()).filter(Boolean);
for (const name of want) {
  const c = VARS[name]; if (!c) { console.error('unknown variant', name); continue; }
  const mode = name; await dbg(null); await sleep(500);
  // 100% Default leaves the page audio untouched (no graph, nothing to probe), so Default runs at 150%.
  await setS({ ...base, mode: c.mode, masterPct: c.pct });
  if (c.debug !== undefined) await dbg(c.debug);
  await sleep(c.wait); await play(); await sleep(1500);
  for (let i = 1; i <= 3; i++) { await pause(); await sleep(2000); await step(mode, `pause ${i}`); await play(); await step(mode, `play ${i}`); }
  await pause(); await sleep(1000);
  await v(() => { const e = document.querySelector('video'); e.currentTime = Math.max(0, e.currentTime + 30); }, 0); await sleep(2000);
  await play(); await step(mode, 'seek +30');
}
await dbg(null);
const st = (a) => (a.length ? `mean ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)} range [${Math.min(...a).toFixed(1)}, ${Math.max(...a).toFixed(1)}] n=${a.length}` : 'n=0');
console.log('variant                 step      kind  offset(ms; sound - picture)  pipeline  missing');
for (const r of rows) console.log(`${r.mode.padEnd(22)} ${r.label.padEnd(9)} ${r.kind.padEnd(5)} ${f(r.off)}  ${f(r.pipe)}  ${(r.missing ?? []).join(',')}${r.level ? ` level rms=${r.level.rms.toFixed(4)} peak=${r.level.peak.toFixed(4)} firstAbove=${r.level.firstAboveMs?.toFixed(0) ?? '-'}` : ''}`);
for (const name of want) { const pl = rows.filter((r) => r.mode === name && r.kind === 'play'); console.log(`${name}: resume playOffsetMs ${st(pl.map((r) => r.off).filter((x) => x != null))}; pipelineMs ${st(pl.map((r) => r.pipe).filter((x) => x != null))}`); }
fs.writeFileSync(path.join(OUT, 'qa-avsync.json'), JSON.stringify({ rows, logs }, null, 1));
console.error(`raw rows + ${logs.length} probe log lines: ${path.join(OUT, 'qa-avsync.json')}`);
await ctx.close();
