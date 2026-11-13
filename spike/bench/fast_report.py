"""Table from spike/bench/results/fast_bench.jsonl (last row per model; clips with a silent vocal reference are dropped): step p50, RTF, mean SDRs,
paired delta vs the reference row (default roformer) with a 95 % bootstrap CI (same method as vocal_report.py: 2000 resamples, seed 0), and
the planner's least Delay limit per model from the measured step.
  .venv/bin/python -I spike/bench/fast_report.py [--ref roformer]
Planner: every row but compat uses vocal_plan.min_delay (port of src/ml/rof-plan.ts, gitignored, read from the main repo if absent here) at the row's hop and frames,
since a candidate would replace High quality; compat stays on an approximation of src/ml/mdx-plan.ts mdxGeometry (chunk + align128(1.5 * step p50) + 128, labelled approx).
"""
import importlib.util, json, math, os, pathlib, sys
import numpy as np
HERE = pathlib.Path(__file__).resolve().parent
MAIN = pathlib.Path(os.environ.get('ALLMIXER_MAIN', '/Users/sriv/Space/Repos/All-Mixer'))
ref = sys.argv[sys.argv.index('--ref') + 1] if '--ref' in sys.argv else 'roformer'
rows = {}
for l in (HERE / 'results/fast_bench.jsonl').open():
    r = json.loads(l)
    rows[r['model']] = r  # last wins
vp = next((p for p in (HERE / 'vocal_plan.py', MAIN / 'spike/bench/vocal_plan.py') if p.exists()), None)
spec = importlib.util.spec_from_file_location('vocal_plan', vp)
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)
rng = np.random.default_rng(0)


def keep(r):
    return {i: (r['sdr_v'][i], r['sdr_i'][i]) for i in range(r['clips']) if not r['silent'][i]}


def paired(a, b, j):
    c = sorted(set(a) & set(b))
    d = np.array([a[i][j] - b[i][j] for i in c])
    if len(d) < 3:
        return None
    bs = [rng.choice(d, len(d)).mean() for _ in range(2000)]
    return d.mean(), np.percentile(bs, 2.5), np.percentile(bs, 97.5), len(d)


def onnx(m):
    f = {'roformer': 'roformer.onnx', 'compat': 'compat-mdx.onnx'}.get(m, m + '.onnx')
    p = next((q for q in (HERE.parent / 'ml/models' / f, MAIN / 'models-out' / f) if q.exists()), None)
    return f'{p.stat().st_size / 1e6:.0f} MB {"fp16" if "fp16" in m or m == "roformer" else "fp32"}' if p else '?'


FIXED_T = {'scnet_vocals', 'mdx23c_t128', 'mdx23c_t128_fp16'}  # kim2* have a dynamic frames axis: planner value stands


def min_delay(r):
    ms = r['step_p50_ms']
    if r['rtf'] >= 1:
        return 'cannot run live'
    if r['model'] in FIXED_T:  # graph input fixed to the exported frames: the chunk is the exported one, the RoFormer planner does not apply
        return f'{r["chunk_s"]:.2f} s (fixed chunk)'
    if r['model'] == 'compat':  # approximation of src/ml/mdx-plan.ts mdxGeometry, no karaoke tail or slack floor
        slack = -(-math.ceil(1.5 * ms * 44.1) // 128) * 128
        return f'{(r["chunk_s"] * 44100 + slack + 128) / 44100:.2f} s (chunk {r["chunk_s"]:.2f} s) approx' + ('' if ms * 1.5 <= r['block'] / 44.1 else ' NOT keeping up')
    # candidates replace High quality: RoFormer planner at the model's hop and frames
    f = r['frames']  # invert plan.step_ms to the 112-frame base
    d, p = plan.min_delay(ms / ((f / 112) * (1 + max(0, f - 400) / 1500)), r['hop'])
    return f'{d:.2f} s (chunk {p["chunk_s"]:.2f} s)' if d else 'never keeps up'


print('| model | clips | chunk s | ONNX | step p50 ms | RTF | vocal SDR | instr SDR | d vocal vs %s [95%% CI] | d instr vs %s [95%% CI] | min Delay limit |' % (ref, ref))
print('|---|---|---|---|---|---|---|---|---|---|---|')
base = keep(rows[ref]) if ref in rows else {}
for m, r in rows.items():
    k = keep(r)
    v, i = np.mean([x[0] for x in k.values()]), np.mean([x[1] for x in k.values()])
    dv, di = (paired(k, base, 0), paired(k, base, 1)) if m != ref and base else (None, None)
    f = lambda p: f'{p[0]:+.2f} [{p[1]:+.2f}, {p[2]:+.2f}] n={p[3]}' if p else '-'
    print(f'| {m} | {len(k)} | {r["chunk_s"]:.2f} | {onnx(m)} | {r["step_p50_ms"]:.0f} | {r["rtf"]:.2f} | {v:.2f} | {i:.2f} | {f(dv)} | {f(di)} | {min_delay(r)} |')
