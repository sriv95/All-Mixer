// Offline parity run for SRI-237 (skipped unless SRI237_DIR is set): streams a dumped clip through the
// KaraokeCombiner and writes vk.f32 / vz.f32 ([L][R]) next to the inputs. spike/ml/sri237_dump.py makes the inputs,
// spike/ml/sri237_compare.py scores the outputs against sri220_gate.py G2.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { KaraokeCombiner } from './karaoke';
import { BINS, HOP } from './stream';

const dir = process.env.SRI237_DIR;
const f32 = (p: string) => { const b = readFileSync(p); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };

describe.skipIf(!dir)('SRI-237 offline parity', () => {
  it('streams the dumped clip', () => {
    const x = f32(`${dir}/x.f32`), v = f32(`${dir}/v.f32`), m = f32(`${dir}/m.f32`);
    const n = x.length / 2, frames = m.length / (2 * BINS);
    const c = new KaraokeCombiner(0.8, process.env.SRI237_FILL !== '0');
    const vk = new Float32Array(2 * n), vz = new Float32Array(2 * n);
    const B = 4 * HOP; // one Spleeter step of input at a time
    let emitted = 0, pushed = 0;
    for (let pos = 0; pos < n; pos += B) {
      const len = Math.min(B, n - pos);
      c.writeInput(pos, x.subarray(pos, pos + len), x.subarray(n + pos, n + pos + len), len);
      c.writeVocal(pos, v.subarray(pos, pos + len), v.subarray(n + pos, n + pos + len), len);
      // masks up to 40 frames ahead of the combine, as in the stream
      for (; pushed < Math.min(frames, pos / HOP + 40); pushed += 4) c.pushMasks(pushed, m.subarray(pushed * 2 * BINS, (pushed + 4) * 2 * BINS));
      c.advance(pos + len);
      const to = c.completeTo;
      if (to > emitted) {
        const k = to - emitted;
        const a = new Float32Array(k), b = new Float32Array(k), p = new Float32Array(k), q = new Float32Array(k);
        c.emit(emitted, k, a, b);
        c.emitVocal(emitted, k, p, q);
        vk.set(a, emitted); vk.set(b, n + emitted); vz.set(p, emitted); vz.set(q, n + emitted);
        c.release(emitted, k);
        emitted = to;
      }
    }
    console.log('emitted', emitted, 'of', n);
    writeFileSync(`${dir}/vk.f32`, vk);
    writeFileSync(`${dir}/vz.f32`, vz);
  }, 600000);
});
