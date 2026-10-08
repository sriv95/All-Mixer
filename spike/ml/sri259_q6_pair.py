"""SRI-259: listening pair for the shipped Karaoke Q6 (python Q6 = TS, parity 0.002 dB): before_q6 (base combine), after_q6 (Q6), original_mix; lovely 101.5-131.5 s.
Usage: python sri259_q6_pair.py <lovely.st.f32> <cache.npz> <outdir> [--t0 71.5387]
Writes 3 wavs (16-bit, same peak-normalisation factor) and dB.json (band dB of mix/before/after for 125.8-127, 50-70, 100-120 s)."""
import sys, os, json, pathlib, numpy as np, soundfile as sf
os.environ.setdefault('SRI254_OFF', '-64.98')
ROOT = pathlib.Path(__file__).resolve().parent; sys.path.insert(0, str(ROOT))
argv = sys.argv; sys.argv = ['x', 'none']
import sri244_dip as d
ref, cache, out = argv[1:4]; t0 = float(argv[argv.index('--t0') + 1]) if '--t0' in argv else 71.5387; out = pathlib.Path(out); out.mkdir(parents=True, exist_ok=True)
x = np.fromfile(ref, dtype=np.float32).astype(np.float64).reshape(2, -1).T.copy(); z = np.load(cache)
c = d.Clip(x, z['v'], z['m']); g = c.gates(d.PARAMS)['G2_mask_evidence']
P = dict(kind='gate', gaingate=1, fillgate=1, tlo=[-50, -55, -55], thi=[-35, -40, -40], act=(-20, -24, -36), Wp=4.0, Wf=0.0, kc=1.0)  # as sri254_compare.py
before = d.combine(c, g, dict(kind='base'))[0]; after = d.combine(c, g, P)[0]
s0, s1 = int(round(30 * d.SR)), int(round(60 * d.SR))
w = {'original_mix': x[s0:s1], 'before_q6': before[s0:s1], 'after_q6': after[s0:s1]}
pk = max(np.abs(v).max() for v in w.values()); k = 0.98 / pk
for n, v in w.items(): sf.write(out / f'{n}.wav', v * k, d.SR, subtype='PCM_16')
print('peak', pk, 'factor', k, {n: len(v) for n, v in w.items()})
at = lambda t: int(round((t - t0) / 0.25)); fb = {n: d.band_frames(s) for n, s in (('mix', x), ('before', before), ('after', after))}; res = {}
for a, b in [(125.8, 127.0), (50, 70), (100, 120)]:
    res[f'{a}-{b}'] = {bd: {n: float(np.mean(fb[n][bd][at(a):at(b)])) for n in fb} for bd in d.BANDS}
json.dump(dict(peak=pk, factor=k, windows=res), open(out / 'dB.json', 'w'), indent=1); print(json.dumps(res, indent=1))
