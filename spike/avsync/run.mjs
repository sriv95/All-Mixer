// SRI-14 bench runner. Usage:
//   CLIPS=/path/with/v1080p60.webm,v720p30.webm node spike/avsync/run.mjs [quick]
// Needs `playwright` resolvable (PW env var = path to playwright package).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'playwright');
const here = path.dirname(new URL(import.meta.url).pathname);
const clips = process.env.CLIPS;
const SECS = Number(process.env.SECS || 8);

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const file = u.startsWith('/clips/') ? path.join(clips, u.slice(7)) : path.join(here, u);
  if (!fs.existsSync(file)) return res.writeHead(404).end();
  const size = fs.statSync(file).size;
  const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'video/webm';
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const a = +m[1], b = m[2] ? +m[2] : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file, { start: a, end: b }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

// Own profile dir so the CPU sampler only counts this browser's processes.
const profile = fs.mkdtempSync(path.join(process.env.PAPERCLIP_SCRATCH_DIR || '/tmp', 'avsync-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: process.env.CHANNEL || 'chromium',
  headless: process.env.HEADFUL ? false : true,
  viewport: { width: 1280, height: 720 },
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'],
});
const browser = { close: () => ctx.close() };
const page = ctx.pages()[0] || (await ctx.newPage());
page.on('console', (m) => console.error('[page]', m.text()));
await page.goto(`${base}/bench.html`);
await page.waitForFunction('window.ready');

// CPU seconds of this browser's processes (browser + GPU + renderer); all child
// processes carry --user-data-dir on their command line.
function treeCpu() {
  const out = execSync('ps -axo time=,command=').toString().trim().split('\n');
  let s = 0;
  for (const l of out) {
    if (!l.includes(profile)) continue;
    const parts = l.trim().split(/\s+/)[0].split(':').map(Number);
    s += parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  }
  return s;
}

const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;

function summarize(s, fps) {
  const fd = 1 / fps;
  const steps = s.mediaSteps || [];
  return {
    srcFrames: s.srcFrames, srcDropped: s.srcDropped, vqDropped: s.vq.dropped,
    drawn: s.drawn, skippedInRing: s.skipped,
    visibleSkips: steps.filter((d) => d > 1.5 * fd).length,
    backSteps: steps.filter((d) => d <= 0).length,
    lateP50: r1(pct(s.lateness || [], 0.5)), lateP95: r1(pct(s.lateness || [], 0.95)), lateMax: r1(pct(s.lateness || [], 1)),
    captureP95: r1(pct(s.captureMs || [], 0.95)), drawP95: r1(pct(s.drawMs || [], 0.95)),
    ringMax: s.maxFrames, ringMB: r1((s.maxBytes || 0) / 2 ** 20), errs: s.captureErrors,
  };
}

async function run(clip, fps, opts, secs = SECS, during) {
  await page.evaluate(([c]) => window.bench.load(c), [`/clips/${clip}`]);
  await page.evaluate((o) => window.bench.start(o), opts);
  await page.waitForTimeout(500);
  const c0 = treeCpu(); const t0 = Date.now();
  if (during) await during(); else await page.waitForTimeout(secs * 1000);
  const c1 = treeCpu(); const dt = (Date.now() - t0) / 1000;
  const s = await page.evaluate(() => window.bench.stop());
  return { cpuPct: r1(((c1 - c0) / dt) * 100), ...summarize(s, fps) };
}

const results = [];
if (process.argv.includes('cpu')) {
  for (let rep = 0; rep < 2; rep++) for (const [clip, fps] of [['v1080p60.webm', 60], ['v720p30.webm', 30]]) for (const cfg of [null, { delayMs: 300, capture: 'bitmap' }, null, { delayMs: 300, capture: 'videoframe' }, null, { delayMs: 500, capture: 'bitmap' }]) {
    results.push({ clip, rep, mode: cfg?.capture || 'baseline', D: cfg?.delayMs || 0, ...(await run(clip, fps, cfg)) });
    console.error(JSON.stringify(results.at(-1)));
  }
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
  server.close();
  process.exit(0);
}
const quick = process.argv.includes('quick');
const clipsList = [['v1080p60.webm', 60], ['v720p30.webm', 30]];
const delays = quick ? [300] : [50, 150, 300, 500];
const captures = quick ? ['bitmap'] : ['bitmap', 'videoframe'];
for (const [clip, fps] of clipsList) {
  results.push({ clip, mode: 'baseline', D: 0, ...(await run(clip, fps, null)) });
  console.error(JSON.stringify(results.at(-1)));
  for (const capture of captures) for (const D of delays) {
    results.push({ clip, mode: capture, D, ...(await run(clip, fps, { delayMs: D, capture })) });
    console.error(JSON.stringify(results.at(-1)));
  }
}

// Delay changes, seek, pause on 1080p60 with bitmap capture.
const ev = async (name, opts, fn) => {
  results.push({ clip: 'v1080p60.webm', mode: name, D: opts.delayMs, ...(await run('v1080p60.webm', 60, opts, 0, fn)) });
  console.error(JSON.stringify(results.at(-1)));
};
if (!quick) {
  const trace = async () => { const out = []; for (let i = 0; i < 40; i++) { out.push(await page.evaluate(() => Math.round(window.bench.stats().delay))); await page.waitForTimeout(100); } return out; };
  await ev('change 50->300 slew0.1', { delayMs: 50, capture: 'bitmap', slew: 0.1 }, async () => { await page.waitForTimeout(1000); await page.evaluate(() => window.bench.setDelay(300)); console.error('delay trace', (await trace()).join(',')); });
  await ev('change 300->50 slew0.1', { delayMs: 300, capture: 'bitmap', slew: 0.1 }, async () => { await page.waitForTimeout(1000); await page.evaluate(() => window.bench.setDelay(50)); await page.waitForTimeout(4000); });
  await ev('change 50->300 jump', { delayMs: 50, capture: 'bitmap', slew: Infinity }, async () => { await page.waitForTimeout(1000); await page.evaluate(() => window.bench.setDelay(300)); await page.waitForTimeout(3000); });
  await ev('change 300->50 jump', { delayMs: 300, capture: 'bitmap', slew: Infinity }, async () => { await page.waitForTimeout(1000); await page.evaluate(() => window.bench.setDelay(50)); await page.waitForTimeout(3000); });
  await ev('seek x3', { delayMs: 300, capture: 'bitmap' }, async () => { for (const t of [20, 5, 12]) { await page.waitForTimeout(1500); await page.evaluate((x) => window.bench.seek(x), t); } await page.waitForTimeout(1500); });
  await ev('pause/play', { delayMs: 300, capture: 'bitmap' }, async () => {
    await page.waitForTimeout(1500); await page.evaluate(() => window.bench.pause());
    const after = []; for (let i = 0; i < 6; i++) { after.push(await page.evaluate(() => window.bench.stats().drawn)); await page.waitForTimeout(100); }
    console.error('drawn after pause (100ms steps)', after.join(','));
    await page.waitForTimeout(1000); await page.evaluate(() => window.bench.play()); await page.waitForTimeout(2000);
  });
  await ev('resize 1280->1920 (fullscreen-like)', { delayMs: 300, capture: 'bitmap' }, async () => {
    await page.waitForTimeout(1500);
    await page.evaluate(() => { const w = document.getElementById('wrap'); const v = document.getElementById('v'); for (const el of [w, v]) { el.style.width = '1920px'; el.style.height = '1080px'; } });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(3000);
  });
}
console.log(JSON.stringify(results, null, 1));
await browser.close();
server.close();
