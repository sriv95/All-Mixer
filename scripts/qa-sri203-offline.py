"""SRI-203 offline: MDX-Net 9482 T=64 vocal + Karaoke H3 (p2, g0.8) on a captured clip (mono f32 -> duplicated to stereo).
Usage: python qa-sri203-offline.py <ref.f32> <sr> <out.json>
Per 250 ms: x/V/Vk/inst RMS dB, 150-1000 Hz energy dB of x, V, inst(Karaoke), x-V (MDX instrumental), mean mask m over 150-1000 Hz."""
import sys, json, pathlib
import numpy as np
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'spike/ml'))
import mdx_stream as mx, spleeter_stream as ss, hybrid_stream as hy
from scipy.signal import butter, sosfilt
ref, sr, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
assert sr == 44100
m = np.fromfile(ref, dtype=np.float32).astype(np.float64)
if ref.endswith('.st.f32'): x = m.reshape(2, -1).T.copy()  # planar L, R
else: x = np.stack([m, m], 1)
m = x.mean(1)
so = mx.ort.SessionOptions(); so.intra_op_num_threads = 6
sess = mx.ort.InferenceSession(str(mx.MODEL), so, providers=['CPUExecutionProvider'])
v, _ = mx.separate(x, sess, 64)
voc, acc = ss.session('vocals'), ss.session('accompaniment')
m_spl, m_c2 = hy.masks(x, voc, acc)
inst = hy.rows_for(x, v, m_spl, m_c2, sweep=True)['h3_p2_g0.8'][1]
sos = butter(4, [150, 1000], 'bandpass', fs=sr, output='sos')
np.save(out.replace('.json', '-v.npy'), v.mean(1).astype(np.float32)); np.save(out.replace('.json', '-inst.npy'), inst.mean(1).astype(np.float32))
db = lambda e: float(10 * np.log10(e + 1e-12))
F = int(0.25 * sr); rows = []
fr = np.fft.rfftfreq(hy.N_FFT, 1 / sr)[:hy.F]; sel = (fr >= 150) & (fr < 1000)
mm = m_spl[0][sel].mean(0)  # per STFT frame (hop 1024)
for i in range(len(m) // F):
    s = slice(i * F, (i + 1) * F); g = lambda a: db(np.mean(a[s].mean(1) ** 2))
    bp = lambda a: db(np.mean(sosfilt(sos, a[s].mean(1)) ** 2))
    t0 = i * F // 1024; t1 = max(t0 + 1, (i + 1) * F // 1024)
    rows.append(dict(t=i * 0.25, x=g(x), V=g(v), inst=g(inst), xmv=g(x - v), x150=bp(x), V150=bp(v), inst150=bp(inst), xmv150=bp(x - v), mask=float(mm[t0:t1].mean())))
json.dump(rows, open(out, 'w'))
print('rows', len(rows))
