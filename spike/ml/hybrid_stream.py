"""SRI-116: Karaoke hybrids of MDX-Net 9482 T=64 (low buzz) and the shipped Spleeter mask (low leak), STFT domain of spleeter_stream.

Inputs per clip: MDX vocal from <clip>/s94_m64/vocal.wav (mdx_stream.py --T 64, aligned to input, 68608-sample delay removed),
m_spl = single-model Spleeter vocal mask (hop 4, ctx 64, lookahead 2, pre 3072 = c0), I_c2 = x * accompaniment-mask of the two-model
Wiener pair (hop 4, lookahead 2). All in the n_fft 4096 / hop 1024 STFT, so every row is a per-bin combination; no extra delay beyond MDX.
Writes <clip>/<tag>/{vocal,instrumental}.wav. Vocal stem of every hybrid row except H2/H4 is the MDX vocal (A cappella is decided).
Usage: python hybrid_stream.py [--clips 50]
"""
import argparse, pathlib
import numpy as np, soundfile as sf
from scipy.signal import stft, istft
import spleeter_stream as ss

N_FFT, HOP, F, PRE = ss.N_FFT, ss.HOP, ss.F, 3072
ROOT = ss.ROOT
SR = 44100

def stft_(x):
    return stft(x.T, fs=SR, window='hann', nperseg=N_FFT, noverlap=N_FFT - HOP, boundary='zeros', padded=True)[2] * N_FFT / 2

def istft_(Z, n):
    return istft(Z / (N_FFT / 2), fs=SR, window='hann', nperseg=N_FFT, noverlap=N_FFT - HOP, boundary=True)[1].T[:n]

def masks(x, voc, acc):
    """(m_spl [2,F,T] single-model vocal mask, m_c2 [2,F,T] two-model accompaniment mask), both on the grid of stft_(x)."""
    n = len(x); xp = np.concatenate([np.zeros((PRE, 2)), x])
    Z = stft_(xp); mag = np.abs(Z[:, :F, :]).transpose(0, 2, 1); T = mag.shape[1]; h, ctx = 4, 64
    def block(L):
        m = np.pad(mag, ((0, 0), (ctx, h + L), (0, 0))); starts = list(range(0, T, h))
        win = np.stack([m[:, s + h + L: s + h + L + ctx] for s in starts], axis=1)
        return win, starts, slice(ctx - h - L, ctx - L)
    def cat(mw, starts, rows): return np.concatenate([mw[:, i, rows] for i in range(len(starts))], axis=1)[:, :T]
    win, st, rows = block(2)  # c0 = shipped: single model, hop 4, lookahead 2, pre 3072
    m_spl = cat(np.clip(ss.run(voc, win) / (win + 1e-8), 0, 1), st, rows)
    win, st, rows = block(2)
    v, a = ss.run(voc, win), ss.run(acc, win)
    m_c2 = cat((a ** 2 + 1e-10 / 2) / (v ** 2 + a ** 2 + 1e-10), st, rows)
    def grid(m):  # [2,T,F] -> [2,F,T], drop the 3 prefix frames (PRE = 3 hops) and pad bins above F with 0 (vocal) / 1 (accompaniment)
        return m.transpose(0, 2, 1)[:, :, PRE // HOP:]
    return grid(m_spl), grid(m_c2)

def rows_for(x, vm, m_spl, m_c2, sweep=False):
    n = len(x); X = stft_(x); V = stft_(vm); T = min(X.shape[2], m_spl.shape[2])
    X, V = X[..., :T], V[..., :T]
    def full(m, fill):
        o = np.full((2, X.shape[1], T), fill); o[:, :F] = m[..., :T]; return o
    ms, ma = full(m_spl, 0.0), full(m_c2, 1.0)
    Xm_V = X - V; I_c2 = X * ma; I_spl = X * (1 - ms)
    freq = np.fft.rfftfreq(N_FFT, 1 / SR)[:, None]
    out = {}
    gate_on = (freq >= 150)[None]
    if sweep:  # margin sweep: H3 p=2 with larger g only
        for g in (0.6, 0.7, 0.8):
            out[f'h3_p2_g{g}'] = (V, Xm_V * (1 - g * ms ** 2 * gate_on))
        return {k: (istft_(v, n), istft_(i, n)) for k, (v, i) in out.items()}
    def minspec(other):
        return np.minimum(np.abs(Xm_V), np.abs(other)) * np.exp(1j * np.angle(Xm_V))
    out['h1_c2'] = (V, minspec(I_c2)); out['h1_spl'] = (V, minspec(I_spl))
    V2 = np.exp(1j * np.angle(V)) * np.maximum(np.abs(V), ms * np.abs(X)); out['h2'] = (V2, X - V2)
    for p in (2, 4):
        for g in (0.5, 1.0):
            out[f'h3_p{p}_g{g}'] = (V, Xm_V * (1 - g * ms ** p * gate_on))
    V4 = 0.5 * (V + ms * X); out['h4'] = (V4, X - V4)
    return {k: (istft_(v, n), istft_(i, n)) for k, (v, i) in out.items()}

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--clips', type=int, default=50); ap.add_argument('--sweep', action='store_true'); a = ap.parse_args()
    voc, acc = ss.session('vocals'), ss.session('accompaniment')
    for d in sorted((ROOT / 'clips/wav').iterdir())[: a.clips]:
        x, sr = sf.read(d / 'mix.wav'); assert sr == SR
        vm = sf.read(d / 's94_m64/vocal.wav')[0]
        m_spl, m_c2 = masks(x, voc, acc)
        for k, (v, i) in rows_for(x, vm, m_spl, m_c2, a.sweep).items():
            (d / f's116_{k}').mkdir(exist_ok=True)
            sf.write(d / f's116_{k}/vocal.wav', v, sr, subtype='FLOAT'); sf.write(d / f's116_{k}/instrumental.wav', i, sr, subtype='FLOAT')
        print(d.name, flush=True)
