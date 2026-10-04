// ORT Web vs native onnxruntime parity for the Spleeter vocals model.
// Run `.venv/bin/python spike/bench/parity_dump.py` first. Usage: node bench/ort_parity.mjs [--headless]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const headless = process.argv.includes('--headless');
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, {
    'Content-Type': mime[path.extname(p)] || 'application/octet-stream',
    'Content-Length': fs.statSync(p).size,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const dir = path.join(root, 'bench/ref/parity');
const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
const f32 = (f) => { const b = fs.readFileSync(path.join(dir, f)); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const X = f32('x.f32'), Y = f32('y_native.f32');
const per = man.inputShape.reduce((a, b) => a * b, 1);
const EPS = 1e-8;
const mask = (v, x, i) => Math.min(1, Math.max(0, v / (x + EPS))); // single-model path of separate()
const median = (a) => { const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };

function diff(out, label) {
  const o = { out: { maxAbs: 0, maxRel: 0 }, mask: { maxAbs: 0, maxRel: 0 } };
  const perWinMask = [], allMask = new Float64Array(out.length);
  for (let w = 0; w < man.n; w++) {
    let wm = 0;
    for (let i = w * per; i < (w + 1) * per; i++) {
      const d = Math.abs(out[i] - Y[i]);
      o.out.maxAbs = Math.max(o.out.maxAbs, d);
      o.out.maxRel = Math.max(o.out.maxRel, d / (Math.abs(Y[i]) + 1e-3));
      const mn = mask(Y[i], X[i]), mw = mask(out[i], X[i]);
      const dm = Math.abs(mw - mn);
      allMask[i] = dm; wm = Math.max(wm, dm);
      o.mask.maxAbs = Math.max(o.mask.maxAbs, dm);
      o.mask.maxRel = Math.max(o.mask.maxRel, dm / (mn + 1e-3));
    }
    perWinMask.push(wm);
  }
  o.out.relFloor = 1e-3; o.mask.relFloor = 1e-3;
  o.mask.medianAbs = median(allMask); // median over every mask element
  o.mask.p99Abs = Float64Array.from(allMask).sort()[Math.floor(allMask.length * 0.99)];
  o.mask.perWindowMaxAbs = perWinMask;
  o.mask.errDb = 20 * Math.log10(1 + o.mask.maxAbs);
  console.log(label.padEnd(8), `out maxAbs ${o.out.maxAbs.toExponential(2)} maxRel ${o.out.maxRel.toExponential(2)} | mask maxAbs ${o.mask.maxAbs.toExponential(2)} median ${o.mask.medianAbs.toExponential(2)} p99 ${o.mask.p99Abs.toExponential(2)} maxRel ${o.mask.maxRel.toExponential(2)} err ${o.mask.errDb.toFixed(4)} dB`);
  return o;
}

const browser = await chromium.launch({ headless, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--enable-webgpu-developer-features', '--ignore-gpu-blocklist'] });
const results = { date: new Date().toISOString(), headless, n: man.n, model: man.model, sourceModel: man.sourceModel, clip: man.clip, maskDef: man.mask, rows: {} };
const gpuProbe = await browser.newPage();
await gpuProbe.goto(base + '/ml/parity.html'); await gpuProbe.waitForFunction('window.ready === true');
results.crossOriginIsolated = await gpuProbe.evaluate(() => crossOriginIsolated);
results.gpu = await gpuProbe.evaluate(() => window.gpuInfo());
await gpuProbe.close();
console.log('crossOriginIsolated', results.crossOriginIsolated, 'gpu', JSON.stringify(results.gpu));
const g = results.gpu;
const software = !g || g.isFallback || /swiftshader|llvmpipe|software/i.test(JSON.stringify(g));
results.webgpuUsable = !software;

for (const e of [{ ep: 'webgpu', threads: 1 }, { ep: 'wasm', threads: 4 }]) {
  if (e.ep === 'webgpu' && software) { console.error('WebGPU adapter missing/software: skipped'); results.rows.webgpu = { skipped: true }; continue; }
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text().slice(0, 200)); });
  await page.goto(base + '/ml/parity.html'); await page.waitForFunction('window.ready === true');
  try {
    const t0 = Date.now();
    const b64 = await page.evaluate((a) => window.runParity(a), { ep: e.ep, threads: e.threads, n: man.n, shape: man.inputShape });
    const b = Buffer.from(b64, 'base64');
    const out = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    results.rows[e.ep] = { ...diff(out, e.ep), totalMs: Date.now() - t0, nonFinite: out.some((v) => !Number.isFinite(v)) };
  } catch (err) { results.rows[e.ep] = { error: String(err.message).slice(0, 300) }; console.log(e.ep, 'FAILED', err.message.slice(0, 200)); }
  await page.close();
}
const w = results.rows.webgpu;
results.passBar = { webgpuMaskMaxAbsLe1e2: w?.mask ? w.mask.maxAbs <= 1e-2 : null, webgpuMaskMedianLe1e3: w?.mask ? w.mask.medianAbs <= 1e-3 : null };
console.log('pass bar', JSON.stringify(results.passBar));
fs.mkdirSync(path.join(root, 'bench/results'), { recursive: true });
fs.writeFileSync(path.join(root, 'bench/results/ort_parity.json'), JSON.stringify(results, null, 2));
await browser.close(); server.close();
