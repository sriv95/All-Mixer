// Runs the SHIPPED ML worker (dist/ml/ml-worker.js, WebGPU EP) in headed Chromium over one clip,
// block by block through its MessagePort protocol (same as the separator worklet uses); no DSP here.
// Writes <clip>/ml_prod/{vocal,instrumental}.wav (placed by the returned block start, i.e. aligned to
// the input) and results/ml_prod_quality.json (timing). Then: python ml_prod_compare.py
// Usage: PLAYWRIGHT_BROWSERS_PATH=... node ml_prod_quality.mjs [clipId=00]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { readWav, writeWav } from './wav.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const clipId = process.argv[2] ?? '00';
const clipDir = path.resolve(here, '../clips/wav', clipId);
const mlDir = path.resolve(here, '../../dist/ml');
// Snapshot dist/ml: it may be rebuilt while the bench runs.
const files = new Map(fs.readdirSync(mlDir).map((f) => [f, fs.readFileSync(path.join(mlDir, f))]));
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const proto = fs.readFileSync(path.resolve(here, '../../src/worklet/protocol.ts'), 'utf8');
const C = Object.fromEntries(['ML_BLOCK', 'ML_RESULT_OFFSET', 'ML_HEADER_BYTES'].map((k) => [k, Number(proto.match(new RegExp(`${k} = (\\d+)`))[1])]));
const LATENCY = proto.match(/ML_LATENCY_SAMPLES = (\d+) \+ (\d+)/).slice(1).reduce((a, b) => a + Number(b), 0);

const { sampleRate, channels } = readWav(path.join(clipDir, 'mix.wav'));
const n = channels[0].length;
const posted = new Map();
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { posted.set(u, Buffer.concat(chunks)); res.end('ok'); });
    return;
  }
  if (u === '/') { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><meta charset=utf8>'); }
  if (u === '/in') {
    const b = Buffer.concat([Buffer.from(channels[0].buffer, channels[0].byteOffset, n * 4), Buffer.from(channels[1].buffer, channels[1].byteOffset, n * 4)]);
    res.setHeader('content-type', 'application/octet-stream'); return res.end(b);
  }
  if (u.startsWith('/ml/') && files.has(u.slice(4))) {
    res.setHeader('content-type', types[path.extname(u)] ?? 'application/octet-stream');
    return res.end(files.get(u.slice(4)));
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const page = await browser.newPage();
await page.goto(origin + '/');
const r = await page.evaluate(async ({ n, C }) => {
  const { ML_BLOCK: B, ML_RESULT_OFFSET: OFF, ML_HEADER_BYTES: H } = C;
  const inp = new Float32Array(await (await fetch('/in')).arrayBuffer());
  const L = inp.subarray(0, n), R = inp.subarray(n);
  const worker = new Worker('/ml/ml-worker.js', { type: 'module' });
  const { port1, port2 } = new MessageChannel();
  const ready = new Promise((res) => { worker.onmessage = (e) => res(e.data); });
  worker.postMessage({ type: 'init', port: port2, modelUrl: '/ml/vocals.onnx', wasmBase: '/ml/' }, [port2]);
  const msg = await ready;
  if (msg.type !== 'ready') return { msg };
  // Feed ceil(n / B) blocks plus enough zero blocks to flush the pipeline (offset 5120 + 1024 of overlap).
  const nIn = Math.ceil(n / B), nTot = nIn + 3;
  const outL = new Float32Array(n), outR = new Float32Array(n);
  const ms = [];
  const roundTrip = (buf) => new Promise((res) => { port1.onmessage = (e) => res(e.data); port1.postMessage(buf, [buf]); });
  for (let b = 0; b < nTot; b++) {
    const buf = new ArrayBuffer(H + 2 * B * 4);
    const head = new Float64Array(buf, 0, 2), data = new Float32Array(buf, H, 2 * B);
    head[0] = 1; head[1] = b * B;
    if (b < nIn) {
      const len = Math.min(B, n - b * B);
      data.set(L.subarray(b * B, b * B + len), 0); data.set(R.subarray(b * B, b * B + len), B);
    }
    const t0 = performance.now();
    const back = await roundTrip(buf);
    ms.push(performance.now() - t0);
    const hb = new Float64Array(back, 0, 2), d = new Float32Array(back, H, 2 * B);
    const s = hb[1];
    if (s === -1) return { error: `block ${b} returned start=-1 (no result)` };
    for (let i = 0; i < B; i++) {
      const p = s + i;
      if (p >= 0 && p < n) { outL[p] = d[i]; outR[p] = d[B + i]; }
    }
  }
  const post = (name, a) => fetch('/out/' + name, { method: 'POST', body: a });
  const o = new Float32Array(2 * n); o.set(outL, 0); o.set(outR, n);
  await post('vocal', o);
  worker.terminate();
  return { msg, ms, nIn, nTot };
}, { n, C });
await browser.close(); server.close();
if (r.error || r.msg.type !== 'ready') { console.error(JSON.stringify(r)); process.exit(1); }

const v = new Float32Array(posted.get('/out/vocal').buffer.slice(posted.get('/out/vocal').byteOffset));
const vocal = [v.subarray(0, n), v.subarray(n, 2 * n)];
const inst = channels.map((c, k) => c.map((x, i) => x - vocal[k][i]));
const outDir = path.join(clipDir, 'ml_prod');
fs.mkdirSync(outDir, { recursive: true });
writeWav(path.join(outDir, 'vocal.wav'), sampleRate, vocal);
writeWav(path.join(outDir, 'instrumental.wav'), sampleRate, inst);

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const ms = r.ms;
const result = {
  clip: clipId, sampleRate, samples: n, blocksFed: r.nTot, ML_LATENCY_SAMPLES: LATENCY, ML_RESULT_OFFSET: C.ML_RESULT_OFFSET,
  adapter: r.msg.adapter, workerReady: { p50: r.msg.p50, p95: r.msg.p95, createMs: r.msg.createMs },
  // Round trip of one block through the worker port: STFT + WebGPU inference + readback + ISTFT + 2 postMessages.
  blockRoundTripMs: { p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: Math.max(...ms), mean: ms.reduce((a, b) => a + b, 0) / ms.length, blocks: ms.length },
  blockBudgetMs: (C.ML_BLOCK / sampleRate) * 1000,
};
fs.mkdirSync(path.join(here, 'results'), { recursive: true });
fs.writeFileSync(path.join(here, 'results/ml_prod_quality.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result));
