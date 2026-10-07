"""SRI-220: SRI-209 dip-fill with a frame-level pause gate, on corrected frames (lovely t0 = 71.5387).
Usage: python sri220_gate.py lovely <capture.st.f32> <t0> <cache.npz> <out.json> [--shift N]
       python sri220_gate.py musdb <clips/wav dir> <out.json> [--n 12]   (second test: MUSDB clips with ground-truth vocals)
Fill core = SRI-209 V1 a0.5 t0.3 b1.0 (band 100-1000 Hz, STFT 4096/1024). Gate g(t) in [0,1] per STFT frame: Vz = Vm + g*(fill - Vm).
Frame energies are band (100-1000 Hz) dB of |Vm| (eM) and Spleeter |ms*X| (eS), stereo mean.
 G1 spleeter-vs-mdx: ramp on eS-eM from D0 to D1 dB, and eS above (clip P95(eS) - FLOOR dB).
 G2 mask evidence : ramp on |X|-weighted mean ms in band from M0 to M1.
 G3 G1*G2 and a vocal phrase nearby: max eM within +-CTX s above (P95(eM) - FLOOR2).
g is smoothed with a 5-frame hann (+-2 frames = +-46 ms lookahead). Karaoke = (X - Vz)*(1 - 0.8*ms^2*[f>=150]) as hybrid_stream."""
import sys, json, pathlib, argparse
import numpy as np, soundfile as sf
ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import hybrid_stream as hy
from scipy.signal import butter, sosfilt
SR = 44100; G = 0.8
db = lambda e: float(10 * np.log10(e + 1e-12))
sos = lambda lo, hi: butter(4, [lo, hi], 'bandpass', fs=SR, output='sos')
S150, S20 = sos(150, 1000), sos(20, 120)
F4 = int(0.25 * SR)
def frames(sig, filt=None):
    s = sig.mean(1) if filt is None else sosfilt(filt, sig.mean(1)); nf = len(s) // F4
    return np.array([db(np.mean(s[i * F4:(i + 1) * F4] ** 2)) for i in range(nf)])
def ramp(x, a, b): return np.clip((x - a) / (b - a), 0, 1)
def smooth(g, k=5):
    w = np.hanning(k + 2)[1:-1]; w /= w.sum(); return np.clip(np.convolve(g, w, 'same'), 0, 1)

class Clip:
    def __init__(s, x, v, m):
        s.x, s.v, s.n = x, v, len(x)
        X = hy.stft_(x); Vm = hy.stft_(v); T = min(X.shape[2], m.shape[2]); s.X, s.Vm = X[..., :T], Vm[..., :T]
        s.ms = np.zeros((2, X.shape[1], T)); s.ms[:, :hy.F] = m[..., :T]
        freq = np.fft.rfftfreq(hy.N_FFT, 1 / SR)[:, None]
        s.band = ((freq >= 100) & (freq <= 1000))[None]; s.gate150 = (freq >= 150)[None]
        s.Vs = s.ms * s.X
        bb = s.band[0, :, 0]
        s.eM = 10 * np.log10((np.abs(s.Vm[:, bb]) ** 2).mean((0, 1)) + 1e-9)
        s.eS = 10 * np.log10((np.abs(s.Vs[:, bb]) ** 2).mean((0, 1)) + 1e-9)
        ax = np.abs(s.X[:, bb]); s.mw = ((s.ms[:, bb] * ax).sum((0, 1)) / (ax.sum((0, 1)) + 1e-9))
    def fill(s, a=0.5, t=0.3, b=1.0):
        c = s.band & (np.abs(s.Vm) < a * np.abs(s.Vs)) & (s.ms > t); return np.where(c, s.Vm + b * (s.Vs - s.Vm), s.Vm)
    def gates(s, p):
        T = len(s.eM); out = {}
        floor_s = np.percentile(s.eS, 95) - p['floor']
        g1 = ramp(s.eS - s.eM, p['d0'], p['d1']) * (s.eS > floor_s)
        g2 = ramp(s.mw, p['m0'], p['m1'])
        k = int(p['ctx'] * SR / hy.HOP); mx = np.array([s.eM[max(0, i - k):i + k + 1].max() for i in range(T)])
        near = (mx > np.percentile(s.eM, 95) - p['floor2']).astype(float)
        out['G0_nogate'] = np.ones(T)
        out['G1_spl_vs_mdx'] = smooth(g1)
        out['G2_mask_evidence'] = smooth(g2 * (s.eS > floor_s))
        out['G3_G1xG2_phrase'] = smooth(g1 * g2 * near)
        g2b = ramp(s.mw, p['m0b'], p['m1b']) * (s.eS > np.percentile(s.eS, 95) - p['floorb'])
        out['G4_mask_loose'] = smooth(g2b)
        out['G5_mask_loose_dil'] = smooth(np.array([g2b[max(0, i - 2):i + 3].max() for i in range(T)]))
        return out
    def stems(s, g):
        Vz = s.Vm + g[None, None, :] * (s.fill() - s.Vm)
        V = hy.istft_(Vz, s.n); inst = hy.istft_((s.X - Vz) * (1 - G * s.ms ** 2 * s.gate150), s.n)
        return V, inst
PARAMS = dict(m0b=0.15, m1b=0.35, floorb=50, d0=3, d1=9, floor=40, m0=0.3, m1=0.5, ctx=1.5, floor2=45)

def metrics(c, g, dips_idx, pause_idx, base):
    V, inst = c.stems(g)
    fV = frames(V); r = {}
    d = {i: float(fV[max(0, i - 4):i + 5].max() - fV[i]) for i in dips_idx}
    r['dips'] = {int(k): round(v, 1) for k, v in d.items()}; r['worst_dip'] = max(d.values()); r['worst_at_frame'] = max(d, key=d.get)
    if len(pause_idx):
        lk = fV[pause_idx] - base['fV'][pause_idx]; r['pause_frames'] = len(pause_idx)
        r['pause_leak_mean'] = float(lk.mean()); r['pause_leak_max'] = float(lk.max())
    r['bass_delta_db'] = db(np.mean(sosfilt(S20, inst.mean(1)) ** 2)) - db(np.mean(sosfilt(S20, c.x.mean(1)) ** 2))
    r['bass_change_vs_base'] = r['bass_delta_db'] - base['bass_delta_db']
    r['kar150_change_vs_base'] = float(np.mean(frames(inst, S150) - base['fI150']))
    r['gate_on_frac'] = float((g > 0.5).mean())
    return r, fV

def run_all(c, dips_idx, pause_idx, name, res):
    gs = c.gates(PARAMS)
    V0, I0 = c.stems(np.zeros(len(c.eM)))
    base = dict(fV=frames(V0), bass_delta_db=db(np.mean(sosfilt(S20, I0.mean(1)) ** 2)) - db(np.mean(sosfilt(S20, c.x.mean(1)) ** 2)), fI150=frames(I0, S150))
    r, _ = metrics(c, np.zeros(len(c.eM)), dips_idx, pause_idx, base); res[f'{name}|base'] = r; print(name, 'base', r, flush=True)
    for k, g in gs.items():
        r, _ = metrics(c, g, dips_idx, pause_idx, base); res[f'{name}|{k}'] = r; print(name, k, {a: round(b, 2) for a, b in r.items() if a != 'dips'}, flush=True)

if sys.argv[1] == 'lovely':
    ap = argparse.ArgumentParser(); ap.add_argument('mode'); ap.add_argument('ref'); ap.add_argument('t0', type=float); ap.add_argument('cache'); ap.add_argument('out'); ap.add_argument('--shift', type=int, default=0); A = ap.parse_args()
    raw = np.fromfile(A.ref, dtype=np.float32).astype(np.float64); x = raw.reshape(2, -1).T.copy()
    z = np.load(A.cache); c = Clip(x, z['v'], z['m'])
    at = lambda t: int(round((t - A.t0) / 0.25))
    DIPS = [102.5, 104.3, 104.5, 107.5, 111.25, 119.75, 120.5, 125.8, 126.0, 126.25, 126.5, 127.75]
    PAUSE = [(89, 92), (94, 96), (99, 100)]
    V0 = frames(z['v']); nf = len(V0)
    dips_idx = [at(t) for t in DIPS if 4 <= at(t) < nf - 4]
    pause_idx = np.array([i for lo, hi in PAUSE for i in range(at(lo), at(hi)) if 0 <= i < nf and V0[i] < -55])
    res = {}; run_all(c, dips_idx, pause_idx, f'lovely_shift{A.shift}', res)
    json.dump(res, open(A.out, 'w'), indent=1)
elif sys.argv[1] == 'capture':
    # second-clip check on a mono f32 reference capture (no ground truth): dips = frames >=8 dB below the +-4-frame max of base MDX V (V > -60 dB);
    # pause = frames where base MDX V and Spleeter-only V are both < -55 dB.
    ap = argparse.ArgumentParser(); ap.add_argument('mode'); ap.add_argument('ref'); ap.add_argument('out'); ap.add_argument('--sec', type=float, default=60); ap.add_argument('--start', type=float, default=0); A = ap.parse_args()
    import mdx_stream as mx
    import spleeter_stream as ss
    raw = np.fromfile(A.ref, dtype=np.float32).astype(np.float64)[int(A.start * SR):int((A.start + A.sec) * SR)]; x = np.stack([raw, raw], 1)
    so = mx.ort.SessionOptions(); so.intra_op_num_threads = 6
    sess = mx.ort.InferenceSession(str(mx.MODEL), so, providers=['CPUExecutionProvider'])
    v = mx.separate(x, sess, 64)[0]; m = hy.masks(x, ss.session('vocals'), ss.session('accompaniment'))[0]
    c = Clip(x, v, m); fV = frames(v); nf = len(fV)
    fS = frames(hy.istft_(c.Vs, c.n))[:nf]
    dips_idx = [i for i in range(4, nf - 4) if fV[i] > -60 and fV[i - 4:i + 5].max() - fV[i] >= 8]
    pause_idx = np.array([i for i in range(nf) if fV[i] < -55 and fS[i] < -55])
    print('dips', len(dips_idx), 'pause', len(pause_idx), 'frames', nf)
    res = {}; run_all(c, dips_idx, pause_idx, pathlib.Path(A.ref).stem, res)
    json.dump(res, open(A.out, 'w'), indent=1)
else:
    ap = argparse.ArgumentParser(); ap.add_argument('mode'); ap.add_argument('dir'); ap.add_argument('out'); ap.add_argument('--n', type=int, default=12); A = ap.parse_args()
    import mdx_stream as mx, spleeter_stream as ss
    so = mx.ort.SessionOptions(); so.intra_op_num_threads = 6
    sess = mx.ort.InferenceSession(str(mx.MODEL), so, providers=['CPUExecutionProvider'])
    voc, acc = ss.session('vocals'), ss.session('accompaniment')
    res = {}; agg = {}
    for cdir in sorted(pathlib.Path(A.dir).glob('[0-9][0-9]'))[:A.n]:
        x, _ = sf.read(cdir / 'mix.wav'); tv, _ = sf.read(cdir / 'vocals.wav'); x = x[:, :2] if x.ndim > 1 else np.stack([x, x], 1)
        tv = tv if tv.ndim > 1 else np.stack([tv, tv], 1)
        v = mx.separate(x, sess, 64)[0]
        m = hy.masks(x, voc, acc)[0]; c = Clip(x, v, m)
        fT = frames(tv); nf = min(len(fT), len(frames(v)))
        dips_idx = [i for i in range(4, nf - 4) if fT[i] > -50]
        pause_idx = np.array([i for i in range(nf) if fT[i] < -60 and frames(v)[i] < -55])
        if not len(dips_idx): continue
        run_all(c, dips_idx, pause_idx, cdir.name, res)
    json.dump(res, open(A.out, 'w'), indent=1)
