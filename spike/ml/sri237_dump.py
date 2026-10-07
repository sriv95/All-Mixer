"""SRI-237: dump the lovely capture (x), MDX vocal (v) and Spleeter mask (m) for the TS combine (src/ml/parity.sri237.test.ts).
Usage: python sri237_dump.py <capture.st.f32> <cache.npz> <outdir>
Files (float32, little endian): x.f32 / v.f32 = [L (n)][R (n)]; m.f32 = [t][ch][1024], TS mask frame t = python frame t + 1."""
import sys, numpy as np, pathlib
ref, cache, out = sys.argv[1:4]; o = pathlib.Path(out); o.mkdir(parents=True, exist_ok=True)
x = np.fromfile(ref, dtype=np.float32).reshape(2, -1); z = np.load(cache)
x.astype(np.float32).tofile(o / 'x.f32'); z['v'].T.astype(np.float32).tofile(o / 'v.f32')
m = z['m'][:, :, 1:]  # [ch][k][t]
np.ascontiguousarray(m.transpose(2, 0, 1)).astype(np.float32).tofile(o / 'm.f32')
print('n', x.shape[1], 'frames', m.shape[2])
