// SRI-117 parity: the TypeScript ML pipeline (src/ml/pipeline.ts) against the python references
// (spike/ml/mdx_stream.py separate() for the A cappella stem, spike/ml/hybrid_stream.py H3 p2 g0.8 for Karaoke)
// on bench clips, with the model outputs of python replayed, so only the DSP around the models is compared.
// Skipped unless PARITY_DIR points at the output of scripts/parity-ref.py:
//   python scripts/parity-ref.py $D && PARITY_DIR=$D npx vitest run scripts/parity-mdx.test.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MlPipeline } from '../src/ml/pipeline';
import { ML_BLOCK, ML_RESULT_OFFSET } from '../src/worklet/protocol';

const dir = process.env.PARITY_DIR;
const load = (p) => {
  const b = readFileSync(p);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};
const sdr = (ref, ts, a, b) => {
  let s = 0, e = 0;
  for (let n = a; n < b; n++) { s += ref[n] * ref[n]; e += (ts[n] - ref[n]) ** 2; }
  return 10 * Math.log10(s / (e + 1e-30));
};
const maxAbs = (ref, ts, a, b) => {
  let m = 0;
  for (let n = a; n < b; n++) m = Math.max(m, Math.abs(ts[n] - ref[n]));
  return m;
};

describe.skipIf(!dir)('TS pipeline vs python references', () => {
  const rows = [];
  for (const clip of dir ? readdirSync(dir).sort() : []) {
    it(`clip ${clip}`, async () => {
      const d = join(dir, clip);
      const x = load(join(d, 'x.f32')), n = x.length / 2;
      const [mi, mo, si, so] = ['mdx_in', 'mdx_out', 'spl_in', 'spl_out'].map((f) => load(join(d, `${f}.f32`)));
      const refV = load(join(d, 'ref_v.f32')), refI = load(join(d, 'ref_inst.f32'));
      const mLen = 4 * 2048 * 64, sLen = 2 * 64 * 1024;
      let mc = 0, sc = 0, mIn = 0, sIn = 0, mPeak = 0, sPeak = 0;
      const cmp = (x_, ref, off, len) => {
        let m = 0, p = 0;
        for (let i = 0; i < len; i++) { m = Math.max(m, Math.abs(x_[i] - ref[off + i])); p = Math.max(p, Math.abs(ref[off + i])); }
        return [m, p];
      };
      const models = {
        mdx: (t) => { const [m, p] = cmp(t, mi, mc * mLen, mLen); mIn = Math.max(mIn, m); mPeak = Math.max(mPeak, p); return mo.subarray(mc * mLen, ++mc * mLen); },
        spleeter: (t) => { const [m, p] = cmp(t, si, sc * sLen, sLen); sIn = Math.max(sIn, m); sPeak = Math.max(sPeak, p); return so.subarray(sc * sLen, ++sc * sLen); },
      };
      const nb = n / ML_BLOCK;
      expect(Number.isInteger(nb)).toBe(true);
      const p = new MlPipeline();
      const v = new Float32Array(2 * n), inst = new Float32Array(2 * n);
      const a = new Float32Array(ML_BLOCK), b = new Float32Array(ML_BLOCK), c = new Float32Array(ML_BLOCK), e = new Float32Array(ML_BLOCK);
      for (let k = 0; k < nb; k++) {
        a.set(x.subarray(k * ML_BLOCK, (k + 1) * ML_BLOCK));
        b.set(x.subarray(n + k * ML_BLOCK, n + (k + 1) * ML_BLOCK));
        await p.process(a, b, models, a, b, c, e);
        const start = k * ML_BLOCK - ML_RESULT_OFFSET;
        for (let i = 0; i < ML_BLOCK; i++) {
          const j = start + i;
          if (j < 0) continue;
          v[j] = c[i]; v[n + j] = e[i];
          inst[j] = x[j] - a[i]; inst[n + j] = x[n + j] - b[i];
        }
        await p.catchUp(models.spleeter);
      }
      const end = n - ML_RESULT_OFFSET;
      const row = { clip, samples: end, mdx_in_max_abs: mIn, mdx_in_peak: mPeak, spl_in_max_abs: sIn, spl_in_peak: sPeak };
      for (const ch of [0, 1]) {
        const o = ch * n;
        const vr = refV.subarray(o, o + n), vt = v.subarray(o, o + n), ir = refI.subarray(o, o + n), it_ = inst.subarray(o, o + n);
        row[`vocal_ch${ch}`] = { max_abs: maxAbs(vr, vt, 0, end), sdr_db: sdr(vr, vt, 0, end) };
        row[`inst_ch${ch}_from2048`] = { max_abs: maxAbs(ir, it_, 2048, end), sdr_db: sdr(ir, it_, 2048, end) };
        row[`inst_ch${ch}_first2048`] = { max_abs: maxAbs(ir, it_, 0, 2048), sdr_db: sdr(ir, it_, 0, 2048) };
      }
      rows.push(row);
      console.info(JSON.stringify(row));
      writeFileSync(join(dir, 'parity-result.json'), JSON.stringify(rows, null, 2));
      expect(mIn / mPeak).toBeLessThan(1e-4);
      expect(sIn / sPeak).toBeLessThan(1e-4);
      for (const ch of [0, 1]) {
        expect(row[`vocal_ch${ch}`].sdr_db).toBeGreaterThan(80);
        expect(row[`inst_ch${ch}_from2048`].sdr_db).toBeGreaterThan(60);
      }
    }, 120_000);
  }
});
