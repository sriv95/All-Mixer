// Offline app-path eval: RoformerStream (src/ml/roformer.ts) on onnxruntime-web WebGPU in Chrome, whole file, block by block.
// usage: node bench/stream_eval.mjs <model: roformer|deux> 112 <in.wav> <out.wav>   (cwd = spike/; needs bun, playwright + Chrome with WebGPU; models from $MODELS_OUT, default <repo>/models-out)
// Limit: frames is accepted only as 112 (DEFAULT_ROF_GEOMETRY is the only geometry wired; other values throw).
// Output is the vocal stem, delay-compensated (stream emits input [b·H−R,(b+1)·H−R)), same length as the input.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { readWav, writeWav } from './wav.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [model, frames = '112', inWav, outWav] = process.argv.slice(2);
if (+frames !== 112) throw new Error('only DEFAULT_ROF_GEOMETRY (112 frames) wired');
const md = path.join(root, 'ml/models'), mo = process.env.MODELS_OUT || path.resolve(root, '../models-out');
execFileSync('bun', ['build', path.resolve(root, '../src/ml/roformer.ts'), '--outfile', path.join(md, 'roformer.bundle.js'), '--target=browser'], { stdio: 'ignore' });
for (const f of [`${model}.onnx`, `${model}-meta.json`]) fs.copyFileSync(path.join(mo, f), path.join(md, f));
const w = readWav(inWav), N = w.channels[0].length;
const io = fs.mkdtempSync(path.join(root, 'ml/io_'));
fs.writeFileSync(path.join(io, 'in.f32'), Buffer.from(Float32Array.from([...w.channels[0], ...w.channels[1]]).buffer));
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
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text().slice(0, 200)}`));
await page.goto(`http://127.0.0.1:${server.address().port}/ml/bench.html`);
await page.waitForFunction('window.ready === true');
const io_ = '/ml/' + path.basename(io);
const r = await page.evaluate(async ({ model, io_ }) => {
  const ort = await import('/node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs');
  const { RoformerStream, DEFAULT_ROF_GEOMETRY: g } = await import('/ml/models/roformer.bundle.js');
  ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
  ort.env.logLevel = 'warning';
  const inp = new Float32Array(await (await fetch(io_ + '/in.f32')).arrayBuffer());
  const meta = await (await fetch(`/ml/models/${model}-meta.json`)).json();
  const buf = await (await fetch(`/ml/models/${model}.onnx`)).arrayBuffer();
  const s = await ort.InferenceSession.create(buf, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', freeDimensionOverrides: { frames: g.frames } });
  const stream = new RoformerStream(meta, g);
  const t = new ort.Tensor('float32', stream.x, [1, g.frames, stream.x.length / g.frames]);
  const run = async () => { const o = await s.run({ [s.inputNames[0]]: t }); const d = await o[s.outputNames[0]].getData(); o[s.outputNames[0]].dispose(); return d; };
  const N = inp.length / 2, H = g.block, R = g.overlap, nb = Math.ceil((N + R) / H);
  const outL = new Float32Array(N), outR = new Float32Array(N);
  const bl = new Float32Array(H), br = new Float32Array(H), ol = new Float32Array(H), or = new Float32Array(H);
  const t0 = performance.now();
  for (let b = 0; b < nb; b++) {
    bl.fill(0); br.fill(0); // zero-padded tail flushes the stream
    bl.set(inp.subarray(b * H, Math.min(N, (b + 1) * H))); br.set(inp.subarray(N + b * H, N + Math.min(N, (b + 1) * H)));
    await stream.process(bl, br, run, ol, or);
    for (let i = 0; i < H; i++) { const u = b * H - R + i; if (u >= 0 && u < N) { outL[u] = ol[i]; outR[u] = or[i]; } }
  }
  const b64 = (a) => { let x = ''; const u = new Uint8Array(a.buffer); for (let i = 0; i < u.length; i += 0x8000) x += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(x); };
  return { eps: s.handler?.executionProviders ?? 'n/a', H, ov: R, nb, ms: Math.round(performance.now() - t0), L: b64(outL), Rt: b64(outR) };
}, { model, io_ });
const dec = (s) => new Float32Array(Buffer.from(s, 'base64').buffer.slice(0));
writeWav(outWav, w.sampleRate, [dec(r.L), dec(r.Rt)]);
console.log(JSON.stringify({ model, frames: +frames, block: r.H, delayUsed: r.ov, blocks: r.nb, ms: r.ms, eps: r.eps, warnings: logs.filter((l) => /warn|error|fallback|cpu/i.test(l)) }));
fs.rmSync(io, { recursive: true });
await browser.close(); server.close();
