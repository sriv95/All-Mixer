// WebGPU vs CPU output of the exported SCNet body on a real STFT input: node bench/scnet_webgpu_parity.mjs
// Inputs: spike/ml/models/{drums.onnx,scnet_in.f32,scnet_ref.f32} from `bun run export-scnet` and bench/scnet_dump.py. Prints the relative error per frame group.
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
await page.goto(`http://127.0.0.1:${server.address().port}/ml/bench.html`);
await page.waitForFunction('window.ready === true');
const r = await page.evaluate(async () => {
  const { InferenceSession, Tensor, env } = await import('/node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs');
  env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
  const f32 = async (u) => new Float32Array(await (await fetch(u)).arrayBuffer());
  const [x, ref, model] = await Promise.all([f32('/ml/models/scnet_in.f32'), f32('/ml/models/scnet_ref.f32'), fetch('/ml/models/drums.onnx').then((r) => r.arrayBuffer())]);
  const s = await InferenceSession.create(model, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
  const out = [];
  for (let i = 0; i < 3; i++) { const t0 = performance.now(); const o = await s.run({ x: new Tensor('float32', x, [1, 4, 2049, 128]) }); const d = await o.y.getData(); out.push({ ms: performance.now() - t0, d }); }
  const d = out[2].d;
  let max = 0, e = 0, n = 0;
  for (let i = 0; i < ref.length; i++) { max = Math.max(max, Math.abs(d[i] - ref[i])); e += (d[i] - ref[i]) ** 2; n += ref[i] ** 2; }
  const perFrame = []; for (let t = 0; t < 128; t += 8) { let e = 0, n = 0; for (let c = 0; c < 4; c++) for (let k = 0; k < 2049; k++) { const i = c * 2049 * 128 + k * 128 + t; e += (d[i] - ref[i]) ** 2; n += ref[i] ** 2; } perFrame.push(+Math.sqrt(e / n).toFixed(4)); }
  return { perFrame, maxAbs: max, relRms: Math.sqrt(e / n), ms: out.map((o) => Math.round(o.ms)), finite: d.every(Number.isFinite) };
});
console.log(JSON.stringify(r));
await browser.close(); server.close();
