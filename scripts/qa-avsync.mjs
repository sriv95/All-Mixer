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
const rows = []; let seen = 0;
// Collect transitions the probe finished since the last step, tagged with the step label.
async function step(mode, label) {
  await sleep(2200); const p = await probe();
  if (process.env.RAW) console.error(JSON.stringify({ mode, label, probeOn: p?.probeOn, audioAttached: p?.audioAttached, ctxState: p?.ctxState }));
  if (!p) { rows.push({ mode, label, kind: '-', missing: ['avProbe absent (probe off)'] }); return; }
  const all = p.transitions ?? []; const fresh = all.filter((t) => t.at > seen);
  if (!fresh.length) rows.push({ mode, label, kind: '-', missing: [`no transition (probeOn=${p.probeOn} audioAttached=${p.audioAttached} ctx=${p.ctxState})`] });
  for (const t of fresh) { seen = Math.max(seen, t.at); rows.push({ mode, label, kind: t.kind, off: t.kind === 'pause' ? t.pauseOffsetMs : t.playOffsetMs, pipe: t.pipelineMs, missing: t.missing, ctx: p.ctxState }); }
}
// One real gesture (neutral spot, not the player) so the AudioContext may start.
await page.mouse.click(5, 450); await sleep(500);
await play(); await sleep(4000);
for (const mode of ['default', 'separate']) {
  // 100% Default leaves the page audio untouched (no graph, nothing to probe), so Default runs at 150%.
  await setS({ ...base, mode, masterPct: mode === 'default' ? 150 : 100 }); await sleep(mode === 'separate' ? 8000 : 2500); await play(); await sleep(1500);
  if (mode === 'default') console.error('Default raw avProbe:', JSON.stringify({ ...(await probe()), events: undefined, transitions: undefined }));
  for (let i = 1; i <= 3; i++) { await pause(); await sleep(2000); await step(mode, `pause ${i}`); await play(); await step(mode, `play ${i}`); }
  for (const d of [30, -10]) {
    await pause(); await sleep(1000);
    await v((d) => { const e = document.querySelector('video'); e.currentTime = Math.max(0, e.currentTime + d); }, d); await sleep(2000);
    await play(); await step(mode, `seek ${d > 0 ? '+' : ''}${d}`);
  }
  for (const r of [1.5, 1]) {
    await pause(); await sleep(1000); await v((r) => { document.querySelector('video').playbackRate = r; }, r); await play(); await step(mode, `rate ${r}`);
  }
}
console.log('mode      step      kind  offset(ms; sound - picture)  pipeline  missing');
for (const r of rows) console.log(`${r.mode.padEnd(9)} ${r.label.padEnd(9)} ${r.kind.padEnd(5)} ${f(r.off)}  ${f(r.pipe)}  ${(r.missing ?? []).join(',')}`);
fs.writeFileSync(path.join(OUT, 'qa-avsync.json'), JSON.stringify({ rows, logs }, null, 1));
console.error(`raw rows + ${logs.length} probe log lines: ${path.join(OUT, 'qa-avsync.json')}`);
await ctx.close();
