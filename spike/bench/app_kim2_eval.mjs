// App-code stream eval of Kim Vocal 2: bundles the repo's src/ml/mdx.ts + mdx-plan.ts, kim2.onnx fp32 I/O.
//   node spike/bench/app_kim2_eval.mjs <T> [clips=5]   appends to results/app_kim2_eval.jsonl
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSpike = process.env.ALLMIXER_MAIN ? path.join(process.env.ALLMIXER_MAIN, 'spike') : '/Users/sriv/Space/Repos/All-Mixer/spike';
const modelsOut = process.env.MODELS_OUT || path.resolve(mainSpike, '../models-out');
const work = path.join(root, 'bench/results/fast_work');
const [Targ, clipsArg = '5'] = process.argv.slice(2); const T = +Targ, name = 'kim2';
// compat/roformer files in models-out; the app's names differ from the row names
const alias = { roformer: ['roformer.onnx', 'roformer-meta.json'], compat: ['compat-mdx.onnx', null] };
const src = path.resolve(root, '../src/ml'); fs.mkdirSync(work, { recursive: true });
for (const f of ['mdx', 'mdx-plan']) execFileSync('bun', ['build', `${src}/${f}.ts`, '--outfile', `${work}/app_${f}.bundle.js`, '--target=browser'], { stdio: 'ignore' });

const find = (u) => {
  const rel = decodeURIComponent(u.split('?')[0]);
  const cands = [];
  if (rel.startsWith('/fast/')) cands.push(path.join(work, rel.slice(6)));
  if (rel.startsWith('/models/')) {
    const f = rel.slice(8), a = alias[f.replace(/\.onnx$|-meta\.json$/, '')];
    cands.push(path.join(root, 'ml/models', f), path.join(modelsOut, f));
    if (a) cands.push(path.join(modelsOut, f.endsWith('.onnx') ? a[0] : a[1] || '-'));
  }
  cands.push(path.join(root, rel), path.join(mainSpike, rel)); // bench.html, node_modules
  return cands.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
};
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const p = find(req.url);
  if (!p) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': mime[path.extname(p)] || 'application/octet-stream', 'Content-Length': fs.statSync(p).size, 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--enable-webgpu-developer-features', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[page error]', m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${server.address().port}/ml/bench.html`);
await page.waitForFunction('window.ready === true');
const r = await page.evaluate(async ({ name, clipsArg, T }) => {
  const { InferenceSession, Tensor, env } = await import('/node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs');
  const { MdxStream } = await import('/fast/app_mdx.bundle.js');
  const { MDX_KIM2 } = await import('/fast/app_mdx-plan.bundle.js');
  env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
  const f32 = async (u) => new Float32Array(await (await fetch(u)).arrayBuffer());
  const idx = await (await fetch('/fast/clips.json')).json();
  const mix = await f32('/fast/clips_mix.f32'), voc = await f32('/fast/clips_voc.f32'), acc = await f32('/fast/clips_acc.f32');
  const N = mix.length / 2;
  const model = await (await fetch(`/models/${name}.onnx`)).arrayBuffer();

  const sessOpts = { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' };
  let block, lag, hop, sess, runModel, estIsInstr = false, info;
  const last = idx.clips[Math.min(+clipsArg, idx.clips.length) - 1];
  const end = last.start + last.len + 2 * 44100;
  const stream = new MdxStream(T, MDX_KIM2); block = stream.block; hop = MDX_KIM2.hop; lag = block;
  sess = await InferenceSession.create(model, { ...sessOpts, freeDimensionOverrides: { frames: T } });
  const tin = new Tensor('float32', stream.x, [1, 4, MDX_KIM2.bins, T]);
  runModel = async () => { const o = await sess.run({ [sess.inputNames[0]]: tin }); const d = await o[sess.outputNames[0]].getData(); o[sess.outputNames[0]].dispose(); return d; };
  info = { frames: T, chunk_s: stream.segment / 44100 };
  const out = [new Float32Array(end + 2 * block + 20000), new Float32Array(end + 2 * block + 20000)];
  const bl = new Float32Array(block), br = new Float32Array(block), ol = new Float32Array(block), or = new Float32Array(block);
  const times = [];
  for (let b = 0; (b - 1) * block < end; b++) {
    bl.fill(0); br.fill(0);
    const a = b * block, n = Math.min(block, N - a);
    if (n > 0) { bl.set(mix.subarray(a, a + n)); br.set(mix.subarray(N + a, N + a + n)); }
    const t0 = performance.now();
    await stream.process(bl, br, runModel, ol, or);
    times.push(performance.now() - t0);
    for (let i = 0; i < block; i++) { const u = b * block - lag + i; if (u >= 0 && u < out[0].length) { out[0][u] = ol[i]; out[1][u] = or[i]; } }
  }
  // score: vocal estimate (or mix - instrumental estimate) vs vocal stem, instrumental = mix - vocal estimate vs acc stem
  const sdr = (ref0, ref1, e0f, e1f, a, n) => {
    let num = 0, den = 0;
    for (let i = a; i < a + n; i++) { const e0 = e0f(i), e1 = e1f(i); num += ref0[i] ** 2 + ref1[i] ** 2; den += (ref0[i] - e0) ** 2 + (ref1[i] - e1) ** 2; }
    return 10 * Math.log10((num + 1e-8) / (den + 1e-8));
  };
  const vocE = [(i) => estIsInstr ? mix[i] - out[0][i] : out[0][i], (i) => estIsInstr ? mix[N + i] - out[1][i] : out[1][i]];
  const insE = [(i) => mix[i] - vocE[0](i), (i) => mix[N + i] - vocE[1](i)];
  const clips = idx.clips.slice(0, +clipsArg).map((c) => ({
    silent: !!c.silent,
    sdr_v: sdr(voc.subarray(0, N), voc.subarray(N), vocE[0], vocE[1], c.start, c.len),
    sdr_i: sdr(acc.subarray(0, N), acc.subarray(N), insE[0], insE[1], c.start, c.len),
  }));
  times.sort((x, y) => x - y);
  await sess.release();
  return { ...info, block, hop, steps: times.length, p50: times[Math.floor(times.length / 2)], p90: times[Math.floor(times.length * 0.9)], clips };
}, { name, clipsArg, T });
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const row = { model: 'kim2_app_T' + T, clips: r.clips.length, frames: r.frames, hop: r.hop, block: r.block, chunk_s: r.chunk_s, step_p50_ms: r.p50, step_p90_ms: r.p90,
  rtf: r.p50 / (r.block / 44.1), sdr_v_mean: mean(r.clips.map((c) => c.sdr_v)), sdr_i_mean: mean(r.clips.map((c) => c.sdr_i)),
  sdr_v: r.clips.map((c) => c.sdr_v), sdr_i: r.clips.map((c) => c.sdr_i), silent: r.clips.map((c) => c.silent), ts: new Date().toISOString() };
fs.mkdirSync(path.join(root, 'bench/results'), { recursive: true });
fs.appendFileSync(path.join(root, 'bench/results/app_kim2_eval.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify({ ...row, sdr_v: undefined, sdr_i: undefined, silent: undefined }));
await browser.close(); server.close();
