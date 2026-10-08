"""SRI-254: TS combine (vk.f32 from src/ml/parity.sri237.test.ts, Q6 gate) vs python Q6 (sri244_dip.py combine, fixed offset -64.98, causal box).
Usage: python sri254_compare.py <capture.st.f32> <cache.npz> <dumpdir> [--t0 71.5387]
Prints per band (150-1k, 1-4k, >4k) the 0.25 s band energy of the instrumental in the dip window 125.8-127 s and the guards 50-70, 100-120 s:
python / TS mean dB and the max |diff| over the window's frames; plus the whole-clip max |diff| and the A cappella (vz) difference."""
import sys, os, pathlib, numpy as np
os.environ.setdefault('SRI254_OFF', '-64.98')
ROOT = pathlib.Path(__file__).resolve().parent; sys.path.insert(0, str(ROOT))
sys.argv, argv = ['x', 'none'], sys.argv
import sri244_dip as d
ref, cache, dd = argv[1:4]; t0 = float(argv[argv.index('--t0') + 1]) if '--t0' in argv else 71.5387; dd = pathlib.Path(dd)
x = np.fromfile(ref, dtype=np.float32).astype(np.float64).reshape(2, -1).T.copy(); z = np.load(cache); n = len(x)
c = d.Clip(x, z['v'], z['m']); g = c.gates(d.PARAMS)['G2_mask_evidence']
P = dict(kind='gate', gaingate=1, fillgate=1, tlo=[-50, -55, -55], thi=[-35, -40, -40], act=(-20, -24, -36), Wp=4.0, Wf=0.0, kc=1.0)
inst_py = d.combine(c, g, P)[0]
rd = lambda f: np.fromfile(dd / f, dtype=np.float32).astype(np.float64).reshape(2, -1).T[:n]
inst_ts = x - rd('vk.f32')
fp, ft = d.band_frames(inst_py), d.band_frames(inst_ts); at = lambda t: int(round((t - t0) / 0.25)); worst = 0
for a, b in [(125.8, 127.0), (50, 70), (100, 120)]:
    i0, i1 = at(a), at(b)
    for k in d.BANDS:
        df = np.abs(fp[k][i0:i1] - ft[k][i0:i1]); worst = max(worst, df.max())
        print(f'{a}-{b} s {k:6s} python {np.mean(fp[k][i0:i1]):7.2f} dB  ts {np.mean(ft[k][i0:i1]):7.2f} dB  mean diff {np.mean(ft[k][i0:i1] - fp[k][i0:i1]):+.3f}  max|diff| {df.max():.3f}')
print('worst max|diff| in the windows (dB):', round(worst, 3))
whole = {k: float(np.abs(fp[k][8:-8] - ft[k][8:-8]).max()) for k in d.BANDS}
print('whole clip max|diff| per band (dB):', {k: round(v, 3) for k, v in whole.items()})
