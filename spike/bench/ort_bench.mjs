// ORT Web benchmark: node bench/ort_bench.mjs [--headless] [--runs 30] [--only substr]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const headless = args.includes('--headless');
const runs = +(args[args.indexOf('--runs') + 1] || 30);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : '';
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };

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

const M = '/ml/models/';
const models = [
  { name: 'spleeter-vocals-fp16', url: M + 'sherpa-onnx-spleeter-2stems-fp16/vocals.fp16_dynT.onnx', shape: (T) => [2, 1, T, 1024], Ts: [64, 128], frames: (T) => T * 1024 },
  { name: 'spleeter-accomp-fp16', url: M + 'sherpa-onnx-spleeter-2stems-fp16/accompaniment.fp16_dynT.onnx', shape: (T) => [2, 1, T, 1024], Ts: [64, 128], frames: (T) => T * 1024 },
  { name: 'mdx-9482', url: M + 'UVR_MDXNET_9482_dynT.onnx', shape: (T) => [1, 4, 2048, T], Ts: [32, 64], frames: (T) => T * 1024 },
];
const concurrent = args.includes('--concurrent');
const concSeconds = +(args[args.indexOf('--seconds') + 1] || 60);
const eps = [{ ep: 'webgpu', threads: 1 }, { ep: 'wasm', threads: 4 }, { ep: 'wasm', threads: 1 }];

const browser = await chromium.launch({ headless, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--enable-webgpu-developer-features', '--ignore-gpu-blocklist'] });
const results = { date: new Date().toISOString(), headless, runs, rows: [] };
let page;
async function fresh() {
  if (page) await page.close();
  page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text().slice(0, 200)); });
  await page.goto(base + '/ml/bench.html');
  await page.waitForFunction('window.ready === true');
}
await fresh();
results.crossOriginIsolated = await page.evaluate(() => crossOriginIsolated);
results.userAgent = await page.evaluate(() => navigator.userAgent);
results.gpu = await page.evaluate(() => window.gpuInfo());
console.log('crossOriginIsolated', results.crossOriginIsolated, 'gpu', JSON.stringify(results.gpu));
if (!results.crossOriginIsolated) throw new Error('not crossOriginIsolated');
const g = results.gpu;
const software = !g || g.isFallback || /swiftshader|llvmpipe|software/i.test(JSON.stringify(g));
results.webgpuUsable = !software;
if (software) console.error('!!! WebGPU adapter missing or software (SwiftShader): WebGPU rows will be skipped');

if (concurrent) {
  if (software) throw new Error('concurrent bench needs a hardware WebGPU adapter');
  results.concurrent = [];
  for (const splT of [64, 128]) {
    await fresh();
    const r = await page.evaluate((a) => window.concurrent(a), { ep: 'webgpu', seconds: concSeconds, mdxUrl: models[2].url, mdxShape: models[2].shape(64), splUrl: models[0].url, splShape: models[0].shape(splT) });
    results.concurrent.push({ splT, ...r });
    console.log(`concurrent MDX T=64 + Spleeter vocals T=${splT}`, JSON.stringify(r));
  }
  fs.writeFileSync(path.join(root, 'bench/results/ort_concurrent.json'), JSON.stringify(results, null, 2));
  await browser.close(); server.close(); process.exit(0);
}
for (const m of models) for (const T of m.Ts) for (const e of eps) {
  const label = `${m.name} T=${T} ${e.ep}${e.ep === 'wasm' ? e.threads : ''}`;
  if (only && !label.includes(only)) continue;
  if (e.ep === 'webgpu' && software) continue;
  await fresh();
  const audioSec = m.frames(T) / 44100;
  try {
    const r = await page.evaluate((a) => window.bench(a), { url: m.url, ep: e.ep, threads: e.threads, shape: m.shape(T), runs });
    const row = { model: m.name, T, ep: e.ep, threads: e.ep === 'wasm' ? e.threads : null, audioSec, rtf: r.p50 / 1000 / audioSec, ...r };
    results.rows.push(row);
    console.log(label.padEnd(34), `create ${r.createMs.toFixed(0)}ms first ${r.firstMs.toFixed(0)} p50 ${r.p50.toFixed(1)} p95 ${r.p95.toFixed(1)} RTF ${row.rtf.toFixed(2)}`);
  } catch (err) {
    results.rows.push({ model: m.name, T, ep: e.ep, threads: e.threads, error: String(err.message).slice(0, 300) });
    console.log(label, 'FAILED', String(err.message).slice(0, 200));
  }
}
fs.mkdirSync(path.join(root, 'bench/results'), { recursive: true });
fs.writeFileSync(path.join(root, 'bench/results/ort.json'), JSON.stringify(results, null, 2));
await browser.close();
server.close();
