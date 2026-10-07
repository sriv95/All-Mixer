"""SRI-237: score the TS combine (vk.f32 / vz.f32 from src/ml/parity.sri237.test.ts) against sri220_gate.py G2.
Usage: python sri237_compare.py <capture.st.f32> <cache.npz> <dumpdir> <out.json> [--t0 71.5387]
Metrics = sri220_gate.py metrics(): worst dip, pause leak vs base, bass 20-120 Hz change vs base, plus TS-vs-python stem error."""
import sys, json, pathlib, numpy as np
ROOT = pathlib.Path(__file__).resolve().parent; sys.path.insert(0, str(ROOT))
sys.argv, argv = ['x', 'none'], sys.argv
exec(open(ROOT / 'sri220_gate.py').read().split("if sys.argv[1] == 'lovely':")[0])
ref, cache, d, out = argv[1:5]; t0 = float(argv[argv.index('--t0') + 1]) if '--t0' in argv else 71.5387
d = pathlib.Path(d)
x = np.fromfile(ref, dtype=np.float32).astype(np.float64).reshape(2, -1).T.copy(); z = np.load(cache)
c = Clip(x, z['v'], z['m'])
n = len(x)
rd = lambda f: np.fromfile(d / f, dtype=np.float32).astype(np.float64).reshape(2, -1).T[:n]
vk, vz = rd('vk.f32'), rd('vz.f32'); inst_ts = x - vk
at = lambda t: int(round((t - t0) / 0.25))
DIPS = [102.5, 104.3, 104.5, 107.5, 111.25, 119.75, 120.5, 125.8, 126.0, 126.25, 126.5, 127.75]
V0 = frames(z['v']); nf = len(V0)
dips_idx = [at(t) for t in DIPS if 4 <= at(t) < nf - 4]
pause_idx = np.array([i for lo, hi in [(89, 92), (94, 96), (99, 100)] for i in range(at(lo), at(hi)) if 0 <= i < nf and V0[i] < -55])
g0 = np.zeros(len(c.eM)); V0s, I0 = c.stems(g0)
base = dict(fV=frames(V0s), bass_delta_db=db(np.mean(sosfilt(S20, I0.mean(1)) ** 2)) - db(np.mean(sosfilt(S20, c.x.mean(1)) ** 2)), fI150=frames(I0, S150))
gp = c.gates(PARAMS)['G2_mask_evidence']; Vp, Ip = c.stems(gp)
def score(V, inst):
    fV = frames(V); r = {}
    dd = {i: float(fV[max(0, i - 4):i + 5].max() - fV[i]) for i in dips_idx}
    r['dips'] = {int(k): round(v, 1) for k, v in dd.items()}; r['worst_dip'] = max(dd.values()); r['worst_at_frame'] = max(dd, key=dd.get)
    lk = fV[pause_idx] - base['fV'][pause_idx]; r['pause_leak_mean'] = float(lk.mean()); r['pause_leak_max'] = float(lk.max())
    r['bass_change_vs_base'] = db(np.mean(sosfilt(S20, inst.mean(1)) ** 2)) - db(np.mean(sosfilt(S20, c.x.mean(1)) ** 2)) - base['bass_delta_db']
    r['kar150_change_vs_base'] = float(np.mean(frames(inst, S150) - base['fI150']))
    return r
res = {'base_mdx': score(V0s, I0), 'python_G2': score(Vp, Ip), 'ts': score(vz, inst_ts)}
sl = slice(8192, n - 8192)
res['ts_vs_python_max_abs'] = {'vocal': float(np.abs(vz[sl] - Vp[sl]).max()), 'inst': float(np.abs(inst_ts[sl] - Ip[sl]).max()), 'signal_peak': float(np.abs(x).max())}
for k in ('base_mdx', 'python_G2', 'ts'): print(k, {a: (round(b, 3) if not isinstance(b, dict) else b) for a, b in res[k].items() if a != 'dips'})
print('dips ts', res['ts']['dips']); print('dips py', res['python_G2']['dips']); print(res['ts_vs_python_max_abs'])
json.dump(res, open(out, 'w'), indent=1)
