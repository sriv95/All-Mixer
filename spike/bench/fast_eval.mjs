// Streaming eval of one model on the clip set (fast_prep.py), Chrome WebGPU + ORT-web, the app's own stream code. See fast_README.md.
//   node spike/bench/fast_eval.mjs <roformer|compat|name> [clips=144] [tag]     appends one row to results/fast_bench.jsonl
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
const [name, clipsArg = '144', tag = ''] = process.argv.slice(2);
// compat/roformer files in models-out; the app's names differ from the row names
const alias = { roformer: ['roformer.onnx', 'roformer-meta.json'], compat: ['compat-mdx.onnx', null] };
const src = path.resolve(root, '../src/ml');
for (const f of ['roformer', 'rof-plan', 'mdx', 'fft']) execFileSync('bun', ['build', `${src}/${f}.${f === 'fft' ? 'js' : 'ts'}`, '--outfile', `${work}/${f}.bundle.js`, '--target=browser'], { stdio: 'ignore' });

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
const r = await page.evaluate(async ({ name, clipsArg }) => {
  const { InferenceSession, Tensor, env } = await import('/node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs');
  const { RoformerStream } = await import('/fast/roformer.bundle.js');
  const { makeGeometry, framesFor } = await import('/fast/rof-plan.bundle.js');
  const { MdxStream } = await import('/fast/mdx.bundle.js');
  const { FFT } = await import('/fast/fft.bundle.js');
  env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
  const f32 = async (u) => new Float32Array(await (await fetch(u)).arrayBuffer());
  const idx = await (await fetch('/fast/clips.json')).json();
  const mix = await f32('/fast/clips_mix.f32'), voc = await f32('/fast/clips_voc.f32'), acc = await f32('/fast/clips_acc.f32');
  const N = mix.length / 2;
  const model = await (await fetch(`/models/${name}.onnx`)).arrayBuffer();
  const metaRes = await fetch(`/models/${name}-meta.json`);
  const meta = metaRes.ok ? await metaRes.json() : null;

  // f16 helpers (Float16Array may be missing)
  const toF16 = (a) => { const o = new Uint16Array(a.length), v = new DataView(new ArrayBuffer(4));
    for (let i = 0; i < a.length; i++) { v.setFloat32(0, a[i]); const b = v.getUint32(0), s = (b >>> 16) & 0x8000; let e = ((b >>> 23) & 0xff) - 112, m = b & 0x7fffff;
      o[i] = e <= 0 ? s : e >= 31 ? s | 0x7c00 : s | (e << 10) | (m >>> 13); } return o; };
  const fromF16 = (a) => { const o = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) { const h = a[i], s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; o[i] = e === 0 ? s * m * 2 ** -24 : e === 31 ? s * Infinity : s * (1 + m / 1024) * 2 ** (e - 15); } return o; };

  // any-size FFT: radix-2 when n is a power of two, else Bluestein (kim2 n_fft 7680); same transform(re, im, inverse) contract as src/ml/fft.js
  class AnyFFT {
    constructor(n) {
      this.n = n; if (!(n & (n - 1))) { this.f = new FFT(n); return; }
      let M = 1; while (M < 2 * n - 1) M <<= 1;
      this.M = M; this.f = new FFT(M); this.wr = new Float64Array(n); this.wi = new Float64Array(n);
      for (let i = 0; i < n; i++) { const a = Math.PI * ((i * i) % (2 * n)) / n; this.wr[i] = Math.cos(a); this.wi[i] = -Math.sin(a); }
      this.ar = new Float64Array(M); this.ai = new Float64Array(M); this.br = new Float64Array(M); this.bi = new Float64Array(M);
      this.br[0] = this.wr[0]; this.bi[0] = -this.wi[0];
      for (let i = 1; i < n; i++) { this.br[i] = this.br[M - i] = this.wr[i]; this.bi[i] = this.bi[M - i] = -this.wi[i]; }
      this.f.transform(this.br, this.bi);
    }
    transform(re, im, inverse = false) {
      if (!this.M) return this.f.transform(re, im, inverse);
      const { n, M, wr, wi, ar, ai, br, bi } = this;
      if (inverse) for (let i = 0; i < n; i++) im[i] = -im[i];
      ar.fill(0); ai.fill(0);
      for (let i = 0; i < n; i++) { ar[i] = re[i] * wr[i] - im[i] * wi[i]; ai[i] = re[i] * wi[i] + im[i] * wr[i]; }
      this.f.transform(ar, ai);
      for (let i = 0; i < M; i++) { const x = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = x; }
      this.f.transform(ar, ai, true);
      for (let i = 0; i < n; i++) { re[i] = (ar[i] * wr[i] - ai[i] * wi[i]) / M; im[i] = (ar[i] * wi[i] + ai[i] * wr[i]) / M; }
      if (inverse) for (let i = 0; i < n; i++) im[i] = -im[i];
    }
  }

  // generic "STFT outside graph" stream = MdxStream generalised by meta (fast_README.md)
  class GenericStream {
    constructor(m) {
      this.m = m; const T = m.frames, nF = m.n_fft, hop = m.hop, B = m.bins;
      this.frames = T; this.segment = (T - 1) * hop + nF; if (this.segment % 2) throw new Error('chunk length must be even');
      this.block = this.segment / 2; const Nn = this.segment;
      this.inIdx = this.layoutIdx(m.layout, B, T); this.outIdx = this.layoutIdx(m.out_layout || m.layout, B, T);
      this.size = 4 * B * T; this.x = new Float32Array(this.size);
      this.fft = new AnyFFT(nF); this.re = new Float64Array(nF); this.im = new Float64Array(nF);
      this.win = new Float64Array(nF);
      for (let i = 0; i < nF; i++) { const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nF); this.win[i] = m.win === 'rect' ? 1 : m.win === 'sqrt_hann' ? Math.sqrt(h) : h; }
      this.seg = new Float32Array(2 * Nn); this.acc = new Float64Array(2 * Nn); this.norm = new Float64Array(Nn); this.cw = new Float64Array(Nn); this.tail = new Float32Array(Nn);
      const env = new Float64Array(Nn);
      for (let t = 0; t < T; t++) for (let n = 0; n < nF; n++) env[t * hop + n] += this.win[n] ** 2;
      for (let i = 0; i < Nn; i++) { this.norm[i] = env[i] > 1e-10 ? 1 / env[i] : 1; this.cw[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Nn); }
    }
    // (c: 0 ReL 1 ImL 2 ReR 3 ImR, k, t) -> flat index
    layoutIdx(layout, B, T) {
      if (layout === 'mdx') return (c, k, t) => c * B * T + k * T + t;
      if (layout === 'ch_bins_t_ri') return (c, k, t) => (((c >> 1) * B + k) * T + t) * 2 + (c & 1);
      throw new Error('unknown layout ' + layout);
    }
    get tensorShape() { const { bins: B, frames: T } = this.m; return this.m.layout === 'mdx' ? [1, 4, B, T] : [1, 2, B, T, 2]; }
    analyze(inL, inR) {
      const { frames: T, segment: Nn, block: H } = this, { n_fft: nF, hop, bins: B } = this.m, { x, re, im, win, fft, seg } = this;
      seg.copyWithin(0, H, Nn); seg.copyWithin(Nn, Nn + H, 2 * Nn); seg.set(inL.subarray(0, H), H); seg.set(inR.subarray(0, H), Nn + H);
      for (let t = 0; t < T; t++) {
        const s = t * hop;
        for (let n = 0; n < nF; n++) { re[n] = seg[s + n] * win[n]; im[n] = seg[Nn + s + n] * win[n]; }
        fft.transform(re, im);
        for (let k = 0; k < B; k++) {
          const nk = (nF - k) % nF, I = this.inIdx, q = this.m.normalized ? 1 / Math.sqrt(nF) : 1; // normalized = torch.stft(normalized=True)
          x[I(0, k, t)] = q * 0.5 * (re[k] + re[nk]); x[I(1, k, t)] = q * 0.5 * (im[k] - im[nk]);
          x[I(2, k, t)] = q * 0.5 * (im[k] + im[nk]); x[I(3, k, t)] = q * -0.5 * (re[k] - re[nk]);
        }
      }
    }
    synthesize(v, outL, outR) {
      const { frames: T, segment: Nn, block: H } = this, { n_fft: nF, hop, bins: B } = this.m, { re, im, win, fft, acc, norm, cw, tail, x } = this;
      const comp = (this.m.compensate ?? 1) * (this.m.normalized ? Math.sqrt(nF) : 1), mask = this.m.out_kind === 'mask', O = this.outIdx, I = this.inIdx;
      acc.fill(0);
      for (let t = 0; t < T; t++) {
        re.fill(0); im.fill(0);
        for (let k = 0; k < B; k++) {
          const g = (c) => mask ? v[O(c, k, t)] * x[I(c, k, t)] * comp : v[O(c, k, t)] * comp;
          const a = g(0), b = k > 0 ? g(1) : 0, c = g(2), d = k > 0 ? g(3) : 0; // DC is real
          re[k] = a - d; im[k] = b + c;
          if (k > 0) { re[nF - k] = a + d; im[nF - k] = c - b; }
        }
        fft.transform(re, im, true);
        const s = t * hop;
        for (let n = 0; n < nF; n++) { acc[s + n] += (re[n] * win[n]) / nF; acc[Nn + s + n] += (im[n] * win[n]) / nF; }
      }
      for (let i = 0; i < H; i++) {
        const a = i, b = H + i;
        outL[i] = tail[i] + acc[a] * norm[a] * cw[a]; outR[i] = tail[H + i] + acc[Nn + a] * norm[a] * cw[a];
        tail[i] = acc[b] * norm[b] * cw[b]; tail[H + i] = acc[Nn + b] * norm[b] * cw[b];
      }
    }
    async process(inL, inR, run, outL, outR) { this.analyze(inL, inR); const v = await run(this.x); this.synthesize(v, outL, outR); }
  }

  const sessOpts = { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' };
  let stream, block, lag, hop, sess, runModel, estIsInstr = false, info;
  const last = idx.clips[Math.min(+clipsArg, idx.clips.length) - 1];
  const end = last.start + last.len + 2 * 44100;
  if (name === 'roformer') {
    const frames = 112, overlap = 8832; hop = meta.hop;
    block = Math.floor(((frames - 1) * hop - overlap - 439) / 128) * 128;
    while (framesFor(block, overlap, hop) > frames) block -= 128;
    const g = makeGeometry(block, overlap, 0, 0, hop);
    stream = new RoformerStream(meta, g); lag = overlap; // block b emits input [b*block - overlap, ...)
    sess = await InferenceSession.create(model, { ...sessOpts, freeDimensionOverrides: { frames: g.frames } });
    const t = new Tensor('float32', stream.x, [1, g.frames, stream.x.length / g.frames]);
    runModel = async () => { const o = await sess.run({ [sess.inputNames[0]]: t }); const d = await o[sess.outputNames[0]].getData(); o[sess.outputNames[0]].dispose(); return d; };
    info = { frames: g.frames, chunk_s: (g.frames - 1) * hop / 44100 };
  } else {
    // compat = the app's MdxStream (T 64, fp32, [1,4,2048,64]); anything else = GenericStream from its meta
    const m = name === 'compat' ? null : meta;
    if (m && m.sr !== 44100) throw new Error('sr must be 44100');
    stream = m ? new GenericStream(m) : new MdxStream(64);
    block = stream.block; hop = m ? m.hop : 1024; lag = block; // output of block b = input [(b-1)*block, b*block)
    const f16 = m && m.dtype === 'fp16', shape = m ? stream.tensorShape : [1, 4, 2048, 64];
    sess = await InferenceSession.create(model, sessOpts);
    const iname = m?.input_name || sess.inputNames[0], oname = m?.output_name || sess.outputNames[0];
    runModel = async (x) => {
      const t = f16 ? new Tensor('float16', toF16(x), shape) : new Tensor('float32', x, shape);
      const o = await sess.run({ [iname]: t }); const d = await o[oname].getData(); o[oname].dispose();
      return f16 ? fromF16(d instanceof Uint16Array ? d : new Uint16Array(d.buffer, d.byteOffset, d.length)) : d;
    };
    estIsInstr = !!m && m.out_stem === 'instrumental';
    info = { frames: stream.frames, chunk_s: stream.segment / 44100 };
  }
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
}, { name, clipsArg });
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const row = { model: name + tag, clips: r.clips.length, frames: r.frames, hop: r.hop, block: r.block, chunk_s: r.chunk_s, step_p50_ms: r.p50, step_p90_ms: r.p90,
  rtf: r.p50 / (r.block / 44.1), sdr_v_mean: mean(r.clips.map((c) => c.sdr_v)), sdr_i_mean: mean(r.clips.map((c) => c.sdr_i)),
  sdr_v: r.clips.map((c) => c.sdr_v), sdr_i: r.clips.map((c) => c.sdr_i), silent: r.clips.map((c) => c.silent), ts: new Date().toISOString() };
fs.mkdirSync(path.join(root, 'bench/results'), { recursive: true });
fs.appendFileSync(path.join(root, 'bench/results/fast_bench.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify({ ...row, sdr_v: undefined, sdr_i: undefined, silent: undefined }));
await browser.close(); server.close();
