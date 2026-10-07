"""SRI-219: same as mdx_stream.separate but hop = N / div (div 2 = current 50 %, 4 = 75 % overlap, Hann sum = div / 2).
Usage: python sri219_overlap.py <capture.st.f32> <out_dir> <div>:<shift> ...  -> <out_dir>/ov<div>_shift<shift>.json (250 ms V frames, dB)"""
import sys, json, pathlib
import numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import mdx_stream as mx
from scipy.signal import stft, istft
N_FFT, HOP, DIM_F, SR = mx.N_FFT, mx.HOP, mx.DIM_F, 44100
def separate(x, sess, T, div, batch=8):
    N = mx.seg_len(T); H = N // div; n = len(x); pad = N - H
    xp = np.concatenate([np.zeros((pad, 2)), x, np.zeros((N + (-(n + pad)) % H + N, 2))])
    starts = list(range(0, len(xp) - N + 1, H))
    segs = np.stack([xp[s:s + N] for s in starts])
    _, _, Z = stft(segs.transpose(0, 2, 1), fs=SR, window='hann', nperseg=N_FFT, noverlap=N_FFT - HOP, boundary=None, padded=False)
    Z = Z * N_FFT / 2
    inp = np.stack([Z[:, 0].real, Z[:, 0].imag, Z[:, 1].real, Z[:, 1].imag], axis=1)[:, :, :DIM_F].astype(np.float32)
    out = np.concatenate([sess.run(None, {'input': inp[i:i + batch]})[0] for i in range(0, len(inp), batch)])
    Y = np.zeros(Z.shape, dtype=np.complex128)
    Y[:, 0, :DIM_F] = out[:, 0] + 1j * out[:, 1]; Y[:, 1, :DIM_F] = out[:, 2] + 1j * out[:, 3]
    _, y = istft(Y / (N_FFT / 2), fs=SR, window='hann', nperseg=N_FFT, noverlap=N_FFT - HOP, boundary=False)
    y = np.pad(y, ((0, 0), (0, 0), (0, max(0, N - y.shape[-1]))))[..., :N].transpose(0, 2, 1)
    w = np.hanning(N + 1)[:-1][:, None]
    acc = np.zeros_like(xp)
    for s, seg in zip(starts, y): acc[s:s + N] += seg * w
    return acc[pad:pad + n] * (2.0 / div)
if __name__ == '__main__':
    x0 = np.fromfile(sys.argv[1], dtype=np.float32).astype(np.float64).reshape(2, -1).T.copy(); out = pathlib.Path(sys.argv[2])
    so = mx.ort.SessionOptions(); so.intra_op_num_threads = 6
    sess = mx.ort.InferenceSession(str(mx.MODEL), so, providers=['CPUExecutionProvider'])
    F = SR // 4
    for c in sys.argv[3:]:
        div, shift = map(int, c.split(':'))
        v = separate(np.concatenate([np.zeros((shift, 2)), x0]), sess, 64, div)[shift:]
        fr = [float(10 * np.log10(np.mean(v.mean(1)[i * F:(i + 1) * F] ** 2) + 1e-12)) for i in range(len(v) // F)]
        json.dump(fr, open(out / f'ov{div}_shift{shift}.json', 'w')); print(c, 'done', flush=True)
