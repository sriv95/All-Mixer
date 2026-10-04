// Renders the BUILT worklet (dist/worklet/separator-worklet.js) in real Chromium over every clip.
// Writes <id>/prod/{vocal,instrumental}.wav (2048-sample delay removed) + results/prod_quality.json.
// Usage: PLAYWRIGHT_BROWSERS_PATH=... node prod_quality.mjs   then: python metrics.py prod
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { readWav, writeWav } from './wav.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../clips/wav');
const workletFile = path.resolve(here, '../../dist/worklet/separator-worklet.js');
const DELAY = 2048;
// Snapshot once: dist/ may be rebuilt (and briefly emptied) while the bench runs.
const workletSrc = fs.readFileSync(workletFile);
const workletSha = crypto.createHash('sha256').update(workletSrc).digest('hex');

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url);
  if (req.method === 'POST' && u.startsWith('/out/')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { posted.set(u.slice(5), Buffer.concat(chunks)); res.end('ok'); });
    return;
  }
  const send = (file, type) => { res.setHeader('content-type', type); res.setHeader('access-control-allow-origin', '*'); res.end(fs.readFileSync(file)); };
  if (u === '/') return send(path.join(here, 'prod_quality.html'), 'text/html');
  if (u === '/worklet.js') { res.setHeader('content-type', 'text/javascript'); return res.end(workletSrc); }
  if (u.startsWith('/in/')) {
    const { sampleRate, channels } = readWav(path.join(root, u.slice(4), 'mix.wav'));
    const b = Buffer.alloc(8 + channels[0].length * 8);
    b.writeUInt32LE(sampleRate, 0); b.writeUInt32LE(channels[0].length, 4);
    Buffer.from(channels[0].buffer).copy(b, 8); Buffer.from(channels[1].buffer).copy(b, 8 + channels[0].length * 4);
    return send2(res, b);
  }
  res.statusCode = 404; res.end();
});
const send2 = (res, b) => { res.setHeader('content-type', 'application/octet-stream'); res.end(b); };
const posted = new Map();

const html = `<!doctype html><meta charset=utf8><script>
async function renderClip(id, gains) {
  const r = new Uint8Array(await (await fetch('/in/' + id)).arrayBuffer()), dv = new DataView(r.buffer);
  const sr = dv.getUint32(0, true), n = dv.getUint32(4, true);
  const L = new Float32Array(r.slice(8, 8 + n * 4).buffer), R = new Float32Array(r.slice(8 + n * 4).buffer);
  const outs = [];
  for (const [vg, ig] of gains) {
    const ctx = new OfflineAudioContext(2, n + ${DELAY}, sr);
    await ctx.audioWorklet.addModule('/worklet.js');
    const buf = ctx.createBuffer(2, n, sr); buf.copyToChannel(L, 0); buf.copyToChannel(R, 1);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const node = new AudioWorkletNode(ctx, 'all-mixer-separator', { outputChannelCount: [2] });
    node.parameters.get('vocalGain').value = vg; node.parameters.get('instrumentalGain').value = ig;
    src.connect(node); node.connect(ctx.destination);
    node.port.postMessage({ type: 'active', on: true });
    await new Promise((s) => setTimeout(s, 100));
    src.start();
    const o = await ctx.startRendering();
    outs.push([o.getChannelData(0).subarray(${DELAY}), o.getChannelData(1).subarray(${DELAY})]);
  }
  const [kar, aca, full] = outs;
  let recon = 0, sumErr = 0;
  for (let c = 0; c < 2; c++) {
    const m = c ? R : L;
    for (let i = 0; i < n; i++) {
      recon = Math.max(recon, Math.abs(full[c][i] - m[i]));
      sumErr = Math.max(sumErr, Math.abs(kar[c][i] + aca[c][i] - full[c][i]));
    }
  }
  // outputs hold n samples (last ${DELAY} come from a longer render than input; they are the delayed tail)
  for (const [name, o] of [['vocal', aca], ['instrumental', kar]]) {
    const b = new Float32Array(n * 2); b.set(o[0].subarray(0, n), 0); b.set(o[1].subarray(0, n), n);
    await fetch('/out/' + id + '/' + name, { method: 'POST', body: b });
  }
  return { id, sr, n, recon, sumErr };
}
</script>`;
fs.writeFileSync(path.join(here, 'prod_quality.html'), html);

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`http://localhost:${port}/`);
const ids = fs.readdirSync(root).sort().filter((d) => fs.existsSync(path.join(root, d, 'mix.wav')));
const per = [];
for (const id of ids) {
  const r = await page.evaluate(([i]) => renderClip(i, [[0, 1], [1, 0], [1, 1]]), [id]);
  // Karaoke output is written to instrumental.wav, A cappella to vocal.wav (same layout as run_dsp.mjs).
  const dir = path.join(root, id, 'prod');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['vocal', 'instrumental']) {
    const f = new Float32Array(posted.get(`${id}/${name}`).buffer.slice(0));
    const n = r.n;
    writeWav(path.join(dir, name + '.wav'), r.sr, [f.subarray(0, n), f.subarray(n)]);
  }
  posted.clear();
  per.push(r);
  process.stdout.write(`${id} recon=${r.recon.toExponential(2)} sum=${r.sumErr.toExponential(2)}\n`);
}
await browser.close(); server.close();
fs.rmSync(path.join(here, 'prod_quality.html'));
const result = {
  workletSha256: workletSha, clips: per.length, sampleRate: per[0].sr, delaySamples: DELAY,
  maxReconstructionError: Math.max(...per.map((p) => p.recon)),
  maxKaraokePlusAcappellaVsFullError: Math.max(...per.map((p) => p.sumErr)),
  perClip: per,
};
fs.mkdirSync(path.join(here, 'results'), { recursive: true });
fs.writeFileSync(path.join(here, 'results/prod_quality.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify({ clips: result.clips, recon: result.maxReconstructionError, sum: result.maxKaraokePlusAcappellaVsFullError }));
