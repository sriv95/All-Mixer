// Runs a separator over every clip and writes vocal.wav / instrumental.wav per method.
// Usage: node run_dsp.mjs <method> [jsonOpts]   method: dsp | phase
import fs from 'node:fs';
import path from 'node:path';
import { DspSeparator, phaseCancel } from '../dsp/separator.js';
import { readWav, writeWav } from './wav.js';

const [method = 'dsp', optsJson = '{}', tag = method] = process.argv.slice(2);
const opts = JSON.parse(optsJson);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../clips/wav');
const Q = 128; // AudioWorklet render quantum
let totalSamples = 0, totalMs = 0, sr = 44100;
for (const id of fs.readdirSync(root).sort()) {
  const { sampleRate, channels: [L, R] } = readWav(path.join(root, id, 'mix.wav'));
  sr = sampleRate;
  const n = L.length, out = [0, 1, 2, 3].map(() => new Float32Array(n));
  let latency = 0;
  const t0 = performance.now();
  if (method === 'phase') phaseCancel(L, R, ...out);
  else {
    const s = new DspSeparator(sampleRate, opts);
    latency = s.latency;
    for (let i = 0; i < n; i += Q) {
      const e = Math.min(n, i + Q);
      s.process(L.subarray(i, e), R.subarray(i, e), ...out.map((o) => o.subarray(i, e)));
    }
  }
  totalMs += performance.now() - t0; totalSamples += n;
  // Remove the algorithmic delay so outputs line up with the reference stems.
  const align = (a) => { const b = new Float32Array(n); b.set(a.subarray(latency)); return b; };
  const dir = path.join(root, id, tag);
  fs.mkdirSync(dir, { recursive: true });
  writeWav(path.join(dir, 'vocal.wav'), sampleRate, [align(out[0]), align(out[1])]);
  writeWav(path.join(dir, 'instrumental.wav'), sampleRate, [align(out[2]), align(out[3])]);
}
const audioMs = (totalSamples / sr) * 1000;
console.log(JSON.stringify({ tag, realtimeLoadPct: +((100 * totalMs) / audioMs).toFixed(2),
  latencyMs: method === 'phase' ? 0 : +((new DspSeparator(sr, opts).latency / sr) * 1000).toFixed(1) }));
