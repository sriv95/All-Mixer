// DrumStage (src/ml/scnet.ts, bundled with `bun build`) with the real model on WebGPU: drums SDR vs the truth over the final region.
// Build the stage first: bun build src/ml/scnet.ts --outfile=spike/ml/models/scnet.bundle.js --target=browser; inputs: bench/scnet_dump.py.
// Also compares with stage_py.f32 (the same chunks through torch + CPU ORT): diffDbPerSecond ~ -80 dB means the TS stage matches.
// Input: spike/ml/models/{drums.onnx,stage_in.f32,stage_truth.f32} (L then R; accompaniment and drums of a few MUSDB clips back to back)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': mime[path.extname(p)] || 'application/octet-stream', 'Content-Length': fs.statSync(p).size, 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--enable-webgpu-developer-features', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('[page error]', m.text().slice(0, 200)));
await page.goto(`http://127.0.0.1:${server.address().port}/ml/bench.html`);
await page.waitForFunction('window.ready === true');
const r = await page.evaluate(async () => {
  const { InferenceSession, Tensor, env } = await import('/node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs');
  const { DrumStage, SC_BINS, SC_FRAMES, SC_STRIDE } = await import('/ml/models/scnet.bundle.js');
  env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
  const f32 = async (u) => new Float32Array(await (await fetch(u)).arrayBuffer());
  const [inp, truth, model] = await Promise.all([f32('/ml/models/stage_in.f32'), f32('/ml/models/stage_truth.f32'), fetch('/ml/models/drums.onnx').then((r) => r.arrayBuffer())]);
  const s = await InferenceSession.create(model, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
  const run = async (x) => { const o = await s.run({ x: new Tensor('float32', x, [1, 4, SC_BINS, SC_FRAMES]) }); const d = await o.y.getData(); o.y.dispose(); return d; };
  if (!window.__nowarm) { const z = new Float32Array(4 * SC_BINS * SC_FRAMES).map(() => Math.random() * 0.1); for (let i = 0; i < 3; i++) await run(z); }
  const N = inp.length / 2, H = 39680;
  const stage = new DrumStage();
  const t0 = performance.now();
  const oL = new Float32Array(N), oR = new Float32Array(N); // the stage ring is 2^20 samples: read what became final as the stream goes
  let got = 0;
  for (let p = 0; p < N; p += H) {
    const n = Math.min(H, N - p);
    await stage.push(inp.subarray(p, p + n), inp.subarray(N + p, N + p + n), n, run);
    stage.read(got, stage.ready - got, oL.subarray(got), oR.subarray(got));
    got = stage.ready;
  }
  const ms = performance.now() - t0;
  const R = stage.ready;
  const sdr = (a, b, from, to) => { let num = 0, den = 0; for (let i = from; i < to; i++) { num += a[i] ** 2; den += (a[i] - b[i]) ** 2; } return 10 * Math.log10(num / den); };
  const py = await f32('/ml/models/stage_py.f32').catch(() => null);
  const diffs = [];
  if (py) { const Rp = py.length / 2; for (let sec = 0; sec * 44100 < R; sec++) { let e = 0, n = 0; for (let i = sec * 44100; i < Math.min((sec + 1) * 44100, R); i++) { e += (oL[i] - py[i]) ** 2; n += py[i] ** 2; } diffs.push(+(10 * Math.log10(e / n + 1e-12)).toFixed(0)); } }
  const fine = []; if (py) for (let b = 0; b < 12; b++) { let t = 0, q = 0, d = 0; for (let i = b * 11025; i < (b + 1) * 11025; i++) { t += oL[i] ** 2; q += py[i] ** 2; d += (oL[i] - py[i]) ** 2; } fine.push([+Math.sqrt(t / 11025).toFixed(4), +Math.sqrt(q / 11025).toFixed(4), +Math.sqrt(d / 11025).toFixed(4)]); }
  const segs = [];
  const clip = Math.round(N / 4);
  for (let c = 0; c < 4; c++) { const from = c * clip, to = Math.min((c + 1) * clip, R); if (to > from + 44100) segs.push({ clip: c, sdrL: +sdr(truth.subarray(0, N), oL, from, to).toFixed(2), sdrR: +sdr(truth.subarray(N), oR, from, to).toFixed(2) }); }
  return { fine, diffDbPerSecond: diffs, seconds: N / 44100, readySeconds: R / 44100, totalMs: Math.round(ms), runs: Math.round(R / SC_STRIDE), segs, whole: +sdr(truth.subarray(0, N), oL, 0, R).toFixed(2) };
});
console.log(JSON.stringify(r));
await browser.close(); server.close();
