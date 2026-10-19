// GuitarStage (src/ml/guitar-stage.ts, bundled with `bun build`) with the real model on WebGPU, against the torch fp32 estimate of
// the same model on the whole input in one pass (spike/bench/guitar_ref.py: ~27 s of MUSDB accompaniment).
// Usage: node bench/guitar_stage_eval.mjs <guitar> [blockSec=0.9] [overlapSec=0.2]
// Needs: models-out/<id>.onnx + -meta.json copied to spike/ml/models/, and the files of guitar_ref.py in .cache/guitar/ref.
// Prints the SDR (dB) of the stage's guitar against the one-pass reference per 5 s, after a 2 s start-up, the ms per model run
// and the lag (what the stage adds to the delay).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [id, blockSec = '0.9', overlapSec = '0.2'] = process.argv.slice(2);
const torchName = { guitar: 'becruily' }[id];
const ref = path.resolve(root, '../.cache/guitar/ref');
const q128 = (sec) => Math.round((Number(sec) * 44100) / 128) * 128;
execFileSync('bun', ['build', path.resolve(root, '../src/ml/guitar-stage.ts'), '--outfile', path.resolve(root, 'ml/models/guitar-stage.bundle.js'), '--target=browser'], { stdio: 'ignore' });
fs.copyFileSync(path.join(ref, 'input.f32'), path.resolve(root, 'ml/models/gs_in.f32'));
const torch = new Float32Array(fs.readFileSync(path.join(ref, `${torchName}.f32`)).buffer.slice(0));
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
const r = await page.evaluate(async ({ id, block, overlap }) => {
  const { InferenceSession, Tensor, env } = await import('/node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs');
  const { GuitarStage, guitarGeometry } = await import('/ml/models/guitar-stage.bundle.js');
  env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
  const inp = new Float32Array(await (await fetch('/ml/models/gs_in.f32')).arrayBuffer());
  const meta = await (await fetch(`/ml/models/${id}-meta.json`)).json();
  const model = await (await fetch(`/ml/models/${id}.onnx`)).arrayBuffer();
  const stage = new GuitarStage(meta, guitarGeometry(meta.hop, block, overlap));
  const frames = stage.roformer.frames;
  const s = await InferenceSession.create(model, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', freeDimensionOverrides: { frames } });
  const t = new Tensor('float32', stage.roformer.x, [1, frames, stage.roformer.x.length / frames]);
  let runs = 0;
  const run = async () => { runs++; const o = await s.run({ [s.inputNames[0]]: t }); const d = await o[s.outputNames[0]].getData(); o[s.outputNames[0]].dispose(); return d; };
  const N = inp.length / 2, H = 5120; // an engine block
  const oL = new Float32Array(N), oR = new Float32Array(N);
  let got = 0;
  const t0 = performance.now();
  for (let p = 0; p < N; p += H) {
    const n = Math.min(H, N - p);
    await stage.push(inp.subarray(p, p + n), inp.subarray(N + p, N + p + n), n, run);
    const ready = Math.max(0, stage.ready);
    stage.read(got, ready - got, oL.subarray(got), oR.subarray(got));
    got = ready;
  }
  const b64 = (a) => { let s = ''; const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  return { frames, ready: got, runs, totalMs: Math.round(performance.now() - t0), l: b64(oL.subarray(0, got)), r: b64(oR.subarray(0, got)) };
}, { id, block: q128(blockSec), overlap: q128(overlapSec) });
const dec = (s) => new Float32Array(Buffer.from(s, 'base64').buffer.slice(0));
const l = dec(r.l);
const N = torch.length / 2;
const sdr = (f, t) => { let n = 0, e = 0; for (let i = f; i < t; i++) { n += torch[i] ** 2; e += (l[i] - torch[i]) ** 2; } return +(10 * Math.log10(n / (e + 1e-20))).toFixed(1); };
const per = [];
for (let f = 2 * 44100; f + 44100 <= l.length; f += 5 * 44100) per.push(sdr(f, Math.min(l.length, f + 5 * 44100)));
console.log(JSON.stringify({ id, blockSec: q128(blockSec) / 44100, overlapSec: q128(overlapSec) / 44100, lagSec: +((q128(blockSec) + q128(overlapSec)) / 44100).toFixed(2), frames: r.frames, readySeconds: +(r.ready / 44100).toFixed(1), of: +(N / 44100).toFixed(1), runs: r.runs, msPerRun: Math.round(r.totalMs / r.runs), sdrVsOnePassPer5s: per, sdrAll: sdr(2 * 44100, l.length) }));
await browser.close(); server.close();
