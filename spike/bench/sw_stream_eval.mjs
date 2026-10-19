// RoformerStream (src/ml/roformer.ts, hop 512, six stems) with the real SW core on WebGPU against the torch fp32 one-pass stems
// (sw_ref.py). node bench/sw_stream_eval.mjs [blockSec=5.5] [overlapSec=0.5]. Needs spike/ml/models/sw.onnx + sw-meta.json (copy from models-out).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [blockSec = '5.5', overlapSec = '0.5'] = process.argv.slice(2);
const q128 = (sec) => Math.round((Number(sec) * 44100) / 128) * 128;
const ref = path.resolve(root, '../.cache/sw/ref');
const names = ['bass', 'drums', 'other', 'vocals', 'guitar', 'piano'];
execFileSync('bun', ['build', path.resolve(root, '../src/ml/roformer.ts'), '--outfile', path.resolve(root, 'ml/models/roformer.bundle.js'), '--target=browser'], { stdio: 'ignore' });
execFileSync('bun', ['build', path.resolve(root, '../src/ml/rof-plan.ts'), '--outfile', path.resolve(root, 'ml/models/rof-plan.bundle.js'), '--target=browser'], { stdio: 'ignore' });
fs.copyFileSync(path.resolve(root, '../.cache/sw/ref/input.f32'), path.resolve(root, 'ml/models/gs_in.f32'));
fs.copyFileSync(path.resolve(root, '../models-out/sw.onnx'), path.resolve(root, 'ml/models/sw.onnx'));
fs.copyFileSync(path.resolve(root, '../models-out/sw-meta.json'), path.resolve(root, 'ml/models/sw-meta.json'));
const torch = Object.fromEntries(names.map((n) => [n, new Float32Array(fs.readFileSync(path.join(ref, `${n}.f32`)).buffer.slice(0))]));
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
await page.goto(`http://127.0.0.1:${server.address().port}/ml/bench.html`);
await page.waitForFunction('window.ready === true');
const r = await page.evaluate(async ({ block, overlap, names }) => {
  const { InferenceSession, Tensor, env } = await import('/node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs');
  const { RoformerStream } = await import('/ml/models/roformer.bundle.js');
  const { makeGeometry } = await import('/ml/models/rof-plan.bundle.js');
  env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
  const inp = new Float32Array(await (await fetch('/ml/models/gs_in.f32')).arrayBuffer());
  const meta = await (await fetch('/ml/models/sw-meta.json')).json();
  const model = await (await fetch('/ml/models/sw.onnx')).arrayBuffer();
  const g = makeGeometry(block, overlap, 0, 0, 512);
  const stream = new RoformerStream(meta, g);
  const s = await InferenceSession.create(model, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', freeDimensionOverrides: { frames: g.frames } });
  const t = new Tensor('float32', stream.x, [1, g.frames, stream.x.length / g.frames]);
  const run = async () => { const o = await s.run({ [s.inputNames[0]]: t }); const d = await o[s.outputNames[0]].getData(); o[s.outputNames[0]].dispose(); return d; };
  const N = inp.length / 2;
  const out = names.map(() => [new Float32Array(N + block), new Float32Array(N + block)]);
  const bl = new Float32Array(block), br = new Float32Array(block);
  const bufs = names.map(() => [new Float32Array(block), new Float32Array(block)]);
  let runs = 0;
  const t0 = performance.now();
  // block b of the input → the stems of [b·B − R, (b + 1)·B − R)
  for (let b = 0; (b + 1) * block <= N; b++) {
    bl.set(inp.subarray(b * block, (b + 1) * block));
    br.set(inp.subarray(N + b * block, N + (b + 1) * block));
    await stream.processStems(bl, br, run, bufs);
    runs++;
    for (let k = 0; k < names.length; k++) for (let i = 0; i < block; i++) {
      const u = b * block - overlap + i;
      if (u >= 0) { out[k][0][u] = bufs[k][0][i]; out[k][1][u] = bufs[k][1][i]; }
    }
  }
  const ready = Math.max(0, Math.floor(N / block) * block - overlap);
  const b64 = (a) => { let s = ''; const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  return { frames: g.frames, ready, runs, msPerRun: Math.round((performance.now() - t0) / runs), stems: names.map((n, k) => b64(out[k][0].subarray(0, ready))) };
}, { block: q128(blockSec), overlap: q128(overlapSec), names });
const dec = (s) => new Float32Array(Buffer.from(s, 'base64').buffer.slice(0));
const res = {};
names.forEach((n, k) => {
  const l = dec(r.stems[k]), tr = torch[n];
  const sdr = (f, t) => { let a = 0, e = 0; for (let i = f; i < t; i++) { a += tr[i] ** 2; e += (l[i] - tr[i]) ** 2; } return +(10 * Math.log10(a / (e + 1e-20))).toFixed(1); };
  res[n] = sdr(2 * 44100, r.ready);
});
console.log(JSON.stringify({ blockSec: q128(blockSec) / 44100, overlapSec: q128(overlapSec) / 44100, frames: r.frames, runs: r.runs, msPerRun: r.msPerRun, sdrVsOnePass: res }));
await browser.close(); server.close();
