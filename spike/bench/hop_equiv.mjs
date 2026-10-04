// Equivalence + hop timing: reference DspSeparator (pre-SRI-15) vs current.
// Usage: node spike/bench/hop_equiv.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from './wav.js';
import { DspSeparator as New } from '../dsp/separator.js';
import { DspSeparator as Ref } from './ref/separator_ref.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOL = 1e-6, WARM = 500, HOPS = 3000;

function run(Cls, sr, L, R, opts = {}) {
  const s = new Cls(sr, opts), n = L.length, blk = 128;
  const out = [0, 1, 2, 3].map(() => new Float32Array(n));
  const hopUs = [];
  const orig = s.hopFrame.bind(s);
  s.hopFrame = () => { const t = process.hrtime.bigint(); orig(); hopUs.push(Number(process.hrtime.bigint() - t) / 1e3); };
  for (let i = 0; i + blk <= n; i += blk)
    s.process(L.subarray(i, i + blk), R.subarray(i, i + blk), out[0].subarray(i, i + blk), out[1].subarray(i, i + blk), out[2].subarray(i, i + blk), out[3].subarray(i, i + blk));
  return { out, hopUs };
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const stat = (h) => { const t = h.slice(WARM, WARM + HOPS); return { hops: t.length, p50_us: +q(t, .5).toFixed(1), p99_us: +q(t, .99).toFixed(1), max_us: +Math.max(...t).toFixed(1) }; };
const maxDiff = (a, b) => { let m = 0; for (let c = 0; c < 4; c++) for (let i = 0; i < a[c].length; i++) m = Math.max(m, Math.abs(a[c][i] - b[c][i])); return m; };

const wav = readWav(path.join(root, 'clips/wav/00/mix.wav'));
const sr = 44100, nn = 10 * sr; let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 * 2 - 1; };
const noise = [new Float32Array(nn).map(() => 0.3 * rnd()), new Float32Array(nn).map(() => 0.3 * rnd())];
// Tile a clip so it yields >= WARM+HOPS hops for the timing window.
const tile = (x, n) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = x[i % x.length]; return o; };
const need = (WARM + HOPS + 8) * 512;
const mixL = tile(wav.channels[0], need), mixR = tile(wav.channels[1 % wav.channels.length], need);
const cases = [
  { name: 'mix.wav(tiled)', sr: wav.sampleRate, L: mixL, R: mixR, opts: {} },
  { name: 'noise10s', sr, L: tile(noise[0], need), R: tile(noise[1], need), opts: {} },
  { name: 'noise10s_noperc', sr, L: tile(noise[0], need), R: tile(noise[1], need), opts: { usePerc: false } },
];
const results = []; let ok = true;
for (const c of cases) {
  run(Ref, c.sr, c.L, c.R, c.opts); run(New, c.sr, c.L, c.R, c.opts); // JIT warm
  const a = run(Ref, c.sr, c.L, c.R, c.opts), b = run(New, c.sr, c.L, c.R, c.opts);
  const diff = maxDiff(a.out, b.out);
  const r = { name: c.name, samples: c.L.length, max_abs_diff: diff, pass: diff <= TOL, ref: stat(a.hopUs), new: stat(b.hopUs) };
  if (!r.pass) ok = false;
  results.push(r); console.log(JSON.stringify(r));
}
const main = results.find(r => r.name === 'mix.wav(tiled)');
const timingPass = main.new.p50_us <= 150 && main.new.p99_us <= 300;
fs.writeFileSync(path.join(root, 'bench/results/hop_equiv.json'), JSON.stringify({ date: new Date().toISOString(), node: process.version, tol: TOL, equivPass: ok, timingTargetPass: timingPass, results }, null, 2));
console.log(ok ? 'EQUIV PASS' : 'EQUIV FAIL', timingPass ? 'TIMING PASS' : 'TIMING FAIL');
process.exit(ok ? 0 : 1);
