// SW core on WebGPU (ORT Web) against the torch fp32 output (sw_parity_dump.py). node bench/sw_parity.mjs
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
  const ort = await import('/node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs');
  ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
  const x = new Float32Array(await (await fetch('/ml/models/sw_x.f32')).arrayBuffer());
  const y = new Float32Array(await (await fetch('/ml/models/sw_y.f32')).arrayBuffer());
  const s = await ort.InferenceSession.create(await (await fetch('/ml/models/sw.onnx')).arrayBuffer(), { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
  const o = await s.run({ x: new ort.Tensor('float32', x, [1, 200, 4100]) });
  const g = o[s.outputNames[0]].data;
  let maxAbs = 0, sumAbs = 0, ref = 0, zeros = 0, nan = 0;
  for (let i = 0; i < y.length; i++) { const d = Math.abs(g[i] - y[i]); maxAbs = Math.max(maxAbs, d); sumAbs += d; ref += Math.abs(y[i]); if (g[i] === 0) zeros++; if (Number.isNaN(g[i])) nan++; }
  return { n: y.length, maxAbs, meanAbs: sumAbs / y.length, meanRef: ref / y.length, zeroShare: zeros / y.length, nan };
});
console.log(JSON.stringify(r));
await browser.close(); server.close();
