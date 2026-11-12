// usage (cwd = work dir, or BENCH_DIR=dir): bun <repo>/spike/bench/kit/plan_table.ts [gpu_steps.json]   needs table.md, results_compat.log, results_sw.log in the work dir
// Imports the app's planners; mirrors src/ml/ml-worker.ts:157 (planMdx, baseMs at 64 frames) and :292 (planRof, baseMs at BASE_FRAMES=112, stages=[]).
import { existsSync, readFileSync } from 'fs';
import { planRof, stepMs, BASE_FRAMES } from '../../../src/ml/rof-plan';
import { planMdx, mdxSegment, MDX_T_MIN } from '../../../src/ml/mdx-plan';
const D = (process.env.BENCH_DIR ?? '.') + '/', SR = 44100, DELAYS = [2, 3, 4, 6, 10, 15];
const rd = (f: string) => (existsSync(D + f) ? readFileSync(D + f, 'utf8') : ''); // missing CPU logs: that SDR column stays empty
const path = process.argv[2] ?? D + 'gpu_steps.json';
const J = JSON.parse(readFileSync(path, 'utf8'));
const HOP: Record<string, number> = { roformer: 441, deux: 441, sw: 512 };
// SDR (vs vocals.wav, sdr.py): table.md "SDR median" col; compat log "SDR x dB"; sw log "voc=".
const sdr: Record<string, Map<number, number>> = { roformer: new Map(), deux: new Map(), sw: new Map(), compat: new Map() };
for (const l of rd('table.md').split('\n')) {
  const c = l.split('|').map((s) => s.trim());
  if (c[1] in sdr && /^\d+$/.test(c[2])) sdr[c[1]].set(+c[2], +c[8]);
}
const avg = (m: Map<number, number[]>) => new Map([...m].map(([k, v]) => [k, v.reduce((a, b) => a + b) / v.length] as [number, number]));
for (const [file, model, re, fre] of [['results_compat.log', 'compat', /SDR (-?[\d.]+) dB/, /frames=(\d+)/], ['results_sw.log', 'sw', /voc=(-?[\d.]+)/, /frames=(\d+)/]] as const) {
  const acc = new Map<number, number[]>();
  for (const l of rd(file).split('\n')) {
    const a = l.match(re), f = l.match(fre);
    if (a && f) acc.set(+f[1], [...(acc.get(+f[1]) ?? []), +a[1]]);
  }
  sdr[model] = avg(acc);
}
const near = (m: Map<number, number>, f: number) => { if (!m.size) return 'n/a'; const k = [...m.keys()].reduce((b, x) => (Math.abs(x - f) < Math.abs(b - f) ? x : b)); return `${m.get(k)!.toFixed(2)} dB (nearest-match, frames ${k})`; };
const base = (model: string, frames: number) => { const e = J[model]?.[String(frames)]; return e && e.p95 != null ? e.p95 : null; }; // p90 not measured: p95 used

console.log(`Input: ${path}${J._FAKE ? '  **FAKE DATA**' : ''}\nbaseMs = p95 (p90 not in file) at ${BASE_FRAMES} frames (RoFormers) / ${MDX_T_MIN} frames (compat). Latency = planner geometry.latency (samples)/44100: block+overlap+extra+slack+quantum (MDX: segment+tail+slack+quantum). Keeps up = planner returned non-null.\n`);
console.log('## 1. Plan\n| model | delay s | frames | chunk s | latency s | keeps up | SDR vocal (CPU) |\n|---|---|---|---|---|---|---|');
for (const model of ['roformer', 'deux', 'sw', 'compat']) {
  const b = base(model, model === 'compat' ? MDX_T_MIN : BASE_FRAMES);
  for (const d of DELAYS) {
    if (b == null) { console.log(`| ${model} | ${d} | n/a (no measurement) | | | | |`); continue; }
    if (model === 'compat') {
      const p = planMdx(d * SR, b);
      console.log(p ? `| ${model} | ${d} | ${p.frames} | ${(mdxSegment(p.frames) / SR).toFixed(2)} | ${(p.geometry.latency / SR).toFixed(2)} | yes | ${near(sdr.compat, p.frames)} |` : `| ${model} | ${d} | null | - | - | no | - |`);
    } else {
      const p = planRof(d * SR, b, [], HOP[model]);
      console.log(p ? `| ${model} | ${d} | ${p.frames} | ${(((p.frames - 1) * HOP[model]) / SR).toFixed(2)} | ${(p.latency / SR).toFixed(2)} | yes | ${near(sdr[model], p.frames)} |` : `| ${model} | ${d} | null | - | - | no | - |`);
    }
  }
}
console.log('\n## 2. Planner check (predicted from the base step vs measured)\n| model | frames | predicted ms | p50 | ratio pred/p50 | p95 | ratio pred/p95 |\n|---|---|---|---|---|---|---|');
for (const model of Object.keys(HOP).concat('compat')) {
  const b = base(model, model === 'compat' ? MDX_T_MIN : BASE_FRAMES);
  for (const [f, e] of Object.entries<any>(J[model] ?? {})) {
    if (e.skipped || b == null) continue;
    const pred = model === 'compat' ? b * (+f / MDX_T_MIN) : stepMs(+f, b); // mdx-plan.ts mdxSlack: linear in frames
    console.log(`| ${model} | ${f} | ${pred.toFixed(0)} | ${e.p50} | ${(pred / e.p50).toFixed(2)} | ${e.p95} | ${(pred / e.p95).toFixed(2)} |`);
  }
}
