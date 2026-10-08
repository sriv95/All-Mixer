"""SRI-254: per-clip calibration offset of mdx_presence() (dB) per band, to pick one FIXED constant for the TS port.
Usage: python sri254_offsets.py <lovely.st.f32> <lovely.cache0.npz> <musdb dir> [clip ...]"""
import sys, numpy as np, soundfile as sf
sys.path.insert(0, '.')
import sri244_dip as d
hy, frames, BANDS, BEDGE, SR = d.hy, d.frames, d.BANDS, d.BEDGE, d.SR
def offs(v):
    V = hy.stft_(v).mean(0); freq = np.fft.rfftfreq(hy.N_FFT, 1 / SR); T = V.shape[1]; o = []
    for i, f in enumerate(BANDS.values()):
        bm = (freq >= BEDGE[i]) & (freq < BEDGE[i + 1]); e = (np.abs(V[bm]) ** 2).sum(0)
        blk = int(0.25 * SR / hy.HOP); nb = T // blk
        o.append(np.mean(frames(v, f)) - np.mean(10 * np.log10(e[:nb * blk].reshape(nb, blk).mean(1) + 1e-12)))
    return o
ref, cache, mdir, *clips = sys.argv[1:]
z = np.load(cache); print('lovely', np.round(offs(z['v']), 2))
for c in clips:
    v = sf.read(f'{mdir}/{c}/s94_m64/vocal.wav')[0]; v = v if v.ndim > 1 else np.stack([v, v], 1)
    print(c, np.round(offs(v), 2))
