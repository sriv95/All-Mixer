// Real-time load test of DspSeparator inside an AudioWorklet (Chromium via Playwright).
// Usage: node spike/bench/worklet_bench.mjs [--secs 60] [--modes headless,headed]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SECS = +arg('secs', 60);
const MODES = arg('modes', 'headless,headed').split(',');
const BUDGET_US = 128 / 44100 * 1e6; // 2902.5 (page requests a 44.1 kHz context)

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wav': 'audio/wav' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end(); }
  const buf = fs.readFileSync(p); // full read: wav is small; avoids range handling
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  res.end(buf);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}`;

// --- process CPU via ps cputime deltas over the browser's process tree ---
const parseTime = (s) => { const [m, rest] = s.split(':'); return (+m) * 60 + parseFloat(rest); }; // mm:ss.xx (hh not expected in <1h)
function psTable() {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const rows = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d:.]+)\s+(.*)$/); if (!m) continue;
    let t; const parts = m[3].split(':'); t = parts.length === 3 ? (+parts[0]) * 3600 + (+parts[1]) * 60 + parseFloat(parts[2]) : parseTime(m[3]);
    rows.set(+m[1], { pid: +m[1], ppid: +m[2], cpu: t, cmd: m[4] });
  }
  return rows;
}
function tree(rows, rootPid) {
  const out = new Map(); const stack = [rootPid];
  while (stack.length) { const p = stack.pop(); const r = rows.get(p); if (r) out.set(p, r); for (const c of rows.values()) if (c.ppid === p) stack.push(c.pid); }
  return out;
}
const kind = (cmd) => /--type=renderer/.test(cmd) ? 'renderer' : /--type=gpu/.test(cmd) ? 'gpu' : /audio/.test(cmd) && /--type=utility/.test(cmd) ? 'audio-service' : /--type=utility/.test(cmd) ? 'utility' : /--type=/.test(cmd) ? 'other' : 'browser';
function cpuDelta(a, b, wall) {
  const per = {};
  for (const [pid, r1] of b) { const r0 = a.get(pid); if (!r0) continue; const k = kind(r1.cmd); per[k] = (per[k] || 0) + (r1.cpu - r0.cpu) / wall * 100; }
  per.total = Object.values(per).reduce((s, v) => s + v, 0);
  return per;
}

const pct = (hist, q) => { const n = hist.reduce((s, v) => s + v, 0); let a = 0; for (let b = 0; b < hist.length; b++) { a += hist[b]; if (a >= q * n) return b; } return hist.length - 1; };

async function run({ headless, throttle, timing, bypass = false }) {
  const marker = 'wb' + process.pid + '_' + Date.now();
  const browser = await chromium.launch({ headless, args: ['--autoplay-policy=no-user-gesture-required', `--bench-marker=${marker}`] });
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.goto(`${base}/worklet/index.html?timing=${timing ? 1 : 0}&bypass=${bypass ? 1 : 0}`);
  const init = await page.evaluate(() => window.start());
  await new Promise(r => setTimeout(r, 3000)); // settle
  const rootPid = [...psTable().values()].find(r => r.cmd.includes(marker) && !r.cmd.includes('--type=')).pid;
  const t0 = Date.now(), ps0 = tree(psTable(), rootPid), s0 = await page.evaluate(() => window.snapshot());
  const nStats0 = await page.evaluate(() => window.stats.length);
  await new Promise(r => setTimeout(r, SECS * 1000));
  const wall = (Date.now() - t0) / 1000, ps1 = tree(psTable(), rootPid), s1 = await page.evaluate(() => window.snapshot());
  const stats = (await page.evaluate(() => window.stats)).slice(nStats0);
  await browser.close();
  const hist = new Array(16384).fill(0); let maxw = 0, p99w = [];
  for (const s of stats) { for (let i = 0; i < s.hist.length; i += 2) hist[s.hist[i]] += s.hist[i + 1]; maxw = Math.max(maxw, s.max); p99w.push(s.p99); }
  const quanta = hist.reduce((s, v) => s + v, 0);
  const over = hist.slice(Math.ceil(BUDGET_US)).reduce((s, v) => s + v, 0);
  const ps = s1.playbackStats, p0 = s0.playbackStats;
  const d = (k) => ps && p0 ? ps[k] - p0[k] : null;
  return {
    config: { headless, throttle, timing, bypass, secs: SECS }, init, wallSec: wall,
    timing: timing ? { quanta, p50_us: pct(hist, .5), p99_us: pct(hist, .99), p999_us: pct(hist, .999), max_us: maxw,
      mean_us: stats.reduce((s, x) => s + x.mean * x.n, 0) / Math.max(quanta, 1),
      worst_window_p99_us: Math.max(...p99w), max_deadline_lag_us: Math.max(...stats.map(x => x.maxLag)), windows_with_overrun: stats.filter(x => x.over).length,
      windows: stats.map(x => ({ q: x.quanta, p99: x.p99, max: Math.round(x.max), over: x.over })), budget_us: BUDGET_US, quanta_over_budget: over,
      pct_budget_p50: pct(hist, .5) / BUDGET_US * 100, pct_budget_p99: pct(hist, .99) / BUDGET_US * 100, pct_budget_max: maxw / BUDGET_US * 100 } : null,
    ctxAudioSec: s1.currentTime - s0.currentTime, mediaSec: s1.mediaTime,
    latency: { baseLatency_s: s1.baseLatency, outputLatency_s: s1.outputLatency },
    playbackStats: { before: p0, after: ps, underrunEvents_delta: d('underrunEvents'), underrunDuration_delta_s: d('underrunDuration') },
    cpu_percent_of_one_core: cpuDelta(ps0, ps1, wall),
  };
}

const results = [];
// timing=true runs carry the clock-spinner Worker (extra CPU), timing=false runs give clean CPU %.
// bypass=true measures the timer noise floor (copy-only worklet).
const CONFIGS = [{ throttle: 1, timing: true }, { throttle: 1, timing: false }, { throttle: 1, timing: true, bypass: true },
  { throttle: 4, timing: true }, { throttle: 4, timing: false }, { throttle: 4, timing: true, bypass: true }];
for (const mode of MODES) for (const c of CONFIGS) {
  process.stderr.write(`run ${mode} ${JSON.stringify(c)} ...\n`);
  try { results.push(await run({ headless: mode === 'headless', ...c })); }
  catch (e) { results.push({ config: { mode, ...c }, error: String(e) }); }
}
server.close();
const outp = path.join(root, 'bench/results/worklet.json');
fs.writeFileSync(outp, JSON.stringify({ date: new Date().toISOString(), budget_us: BUDGET_US, chromium: chromium.name(), results }, null, 2));
console.log('wrote', outp);
