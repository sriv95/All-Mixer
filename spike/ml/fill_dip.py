"""SRI-209: offline test of MDX vocal 'dip fill' from the Spleeter vocal mask (bins 100-1000 Hz), STFT n_fft 4096 / hop 1024.
Usage: python fill_dip.py <capture.f32|.st.f32> <video_t0_sec> <out.json> [--shift 512] [--lovely]
 capture: Default (reference) capture, mono f32 (or planar stereo if *.st.f32), 44.1 kHz. video_t0 = videoSec[0] of the capture.
 --lovely: also report dip depth (Khalid frames) and pause leak with the SRI-203 video times.
Variants: base (current Karaoke), V1 hard fill, V2 soft magnitude fill; sweep a{.5,.75} t{.3,.4} b{.5,1}.
Karaoke = (x - V') * (1 - g * m^2 * gate150), g .8, as hybrid_stream.rows_for. Caches V, m_spl in <out>.cache.npz."""
import sys, json, pathlib, argparse
import numpy as np
ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import mdx_stream as mx, spleeter_stream as ss, hybrid_stream as hy
from scipy.signal import butter, sosfilt
ap = argparse.ArgumentParser(); ap.add_argument('ref'); ap.add_argument('t0', type=float); ap.add_argument('out')
ap.add_argument('--shift', type=int, default=0); ap.add_argument('--lovely', action='store_true'); A = ap.parse_args()
SR = 44100; G = 0.8
raw = np.fromfile(A.ref, dtype=np.float32).astype(np.float64)
x = raw.reshape(2, -1).T.copy() if A.ref.endswith('.st.f32') else np.stack([raw, raw], 1)
n = len(x)
cache = pathlib.Path(A.out.replace('.json', f'.cache{A.shift}.npz'))
if cache.exists():
    z = np.load(cache); v, m_spl = z['v'], z['m']
else:
    so = mx.ort.SessionOptions(); so.intra_op_num_threads = 6
    sess = mx.ort.InferenceSession(str(mx.MODEL), so, providers=['CPUExecutionProvider'])
    xs = np.concatenate([np.zeros((A.shift, 2)), x])
    v = mx.separate(xs, sess, 64)[0][A.shift:]
    m_spl = hy.masks(x, ss.session('vocals'), ss.session('accompaniment'))[0]
    np.savez(cache, v=v, m=m_spl)
X = hy.stft_(x); Vm = hy.stft_(v); T = min(X.shape[2], m_spl.shape[2]); X, Vm = X[..., :T], Vm[..., :T]
ms = np.zeros((2, X.shape[1], T)); ms[:, :hy.F] = m_spl[..., :T]
freq = np.fft.rfftfreq(hy.N_FFT, 1 / SR)[:, None]; band = ((freq >= 100) & (freq <= 1000))[None]; gate = (freq >= 150)[None]
Vs = ms * X
def v1(a, t, b):
    c = band & (np.abs(Vm) < a * np.abs(Vs)) & (ms > t); return np.where(c, Vm + b * (Vs - Vm), Vm)
def v2(a, t, b):
    d = np.maximum(0, np.abs(Vs) - np.abs(Vm)) * band; return Vm + b * d * np.exp(1j * np.angle(X))
variants = {'base': Vm}
for a in (0.5, 0.75):
    for t in (0.3, 0.4):
        for b in (0.5, 1.0): variants[f'V1_a{a}_t{t}_b{b}'] = v1(a, t, b)
for b in (0.5, 1.0): variants[f'V2_b{b}'] = v2(0, 0, b)  # a,t unused (magnitude fill only)
sos = lambda lo, hi: butter(4, [lo, hi], 'bandpass', fs=SR, output='sos')
S150, S20 = sos(150, 1000), sos(20, 120)
db = lambda e: float(10 * np.log10(e + 1e-12))
F = int(0.25 * SR); NF = n // F
def frames(sig, filt=None):
    s = sig.mean(1) if filt is None else sosfilt(filt, sig.mean(1)); return np.array([db(np.mean(s[i * F:(i + 1) * F] ** 2)) for i in range(NF)])
fx150, fx20 = frames(x, S150), frames(x, S20)
def at(t_video): return int(round((t_video - A.t0) / 0.25))
DIPS = [102.5, 104.3, 104.5, 107.5, 111.25, 119.75, 120.5, 125.8, 126.0, 126.25, 126.5, 127.75]
PAUSE = [(89, 92), (94, 96), (99, 100)]
Vb_f = frames(v)
res = {}
for k, Vz in variants.items():
    V = v if k == 'base' else hy.istft_(Vz, n)
    inst = hy.istft_((X - Vz) * (1 - G * ms ** 2 * gate), n)
    fV, fV150, fI150, fI20 = frames(V), frames(V, S150), frames(inst, S150), frames(inst, S20)
    r = dict(V150_vs_mdx_db=db(np.mean(sosfilt(S150, V.mean(1)) ** 2)) - db(np.mean(sosfilt(S150, v.mean(1)) ** 2)),
             bass_delta_db=db(np.mean(sosfilt(S20, inst.mean(1)) ** 2)) - db(np.mean(sosfilt(S20, x.mean(1)) ** 2)),
             kar150_mean_minus_default=float(np.mean(fI150 - fx150)), kar150_sd=float(np.std(fI150)))
    if A.lovely:
        dips = {}
        for tv in DIPS:
            i = at(tv)
            if 4 <= i < NF - 4: dips[tv] = float(fV[max(0, i - 4):i + 5].max() - fV[i])
        r['dips'] = dips; r['worst_dip'] = max(dips.values())
        idx = [i for lo, hi in PAUSE for i in range(at(lo), at(hi)) if 0 <= i < NF and Vb_f[i] < -55]
        r['pause_frames'] = len(idx); r['pause_leak_db'] = float(np.mean(fV[idx] - Vb_f[idx])) if idx else None
        r['pause_leak_max_db'] = float(np.max(fV[idx] - Vb_f[idx])) if idx else None
        kh = [at(t) for t in DIPS if 0 <= at(t) < NF]
        r['khalid_kar150_mean_minus_default'] = float(np.mean(fI150[kh] - fx150[kh])); r['khalid_kar150_sd'] = float(np.std(fI150[kh]))
    res[k] = r; print(k, {a: (round(b, 2) if isinstance(b, float) else b) for a, b in r.items() if a != 'dips'}, flush=True)
json.dump(res, open(A.out, 'w'), indent=1)
