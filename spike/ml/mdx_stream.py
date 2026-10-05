"""Streaming simulation of UVR_MDXNET_9482 on the MUSDB clips (SRI-100 step 3).

The model (dim_f 2048, n_fft 4096, hop 1024, input [B, 4, 2048, T] = Re/Im of L and R) sees a segment of T STFT frames
(no centre padding): N = (T - 1) * 1024 + 4096 samples. Segments start every N / 2 samples (50 % overlap); the
overlapping outputs are cross-faded with a periodic Hann window of length N (sums to 1 at hop N / 2).
Vocal = model output (iSTFT, bin 2048 = 0), instrumental = mix - vocal.

Added audio delay (excluding inference): the cross-fade region [kH, (k+1)H) with H = N / 2 needs segment k+1, and that
segment needs all of its N input samples (the U-Net sees the whole segment), so a sample at the START of a cross-fade
region waits N samples:  delay = N = (T - 1) * 1024 + 4096 = 1024 * T + 3072 samples
  T = 32 -> 35840 samples = 812.7 ms;  T = 64 -> 68608 samples = 1555.8 ms     (+ inference time of one segment).
Writes <clip>/<tag>/{vocal,instrumental}.wav aligned to the input for metrics.py.
Usage: python mdx_stream.py <tag> --T 32 [--clips 50] [--gain 1.0]
"""
import argparse, pathlib
import numpy as np, soundfile as sf, onnxruntime as ort
from scipy.signal import stft, istft

N_FFT, HOP, DIM_F = 4096, 1024, 2048
ROOT = pathlib.Path(__file__).resolve().parents[1]
MODEL = ROOT / 'ml/models/UVR_MDXNET_9482_dynT.onnx'

def seg_len(T): return (T - 1) * HOP + N_FFT

def separate(x, sess, T, gain=1.0, batch=8):
    N = seg_len(T); H = N // 2; n = len(x)
    xp = np.concatenate([np.zeros((H, 2)), x, np.zeros((N + H + (-(n + H)) % H, 2))])  # left pad H, right pad to whole hops
    starts = list(range(0, len(xp) - N + 1, H))
    segs = np.stack([xp[s:s + N] for s in starts])  # [S, N, 2]
    _, _, Z = stft(segs.transpose(0, 2, 1), fs=44100, window='hann', nperseg=N_FFT, noverlap=N_FFT - HOP, boundary=None, padded=False)
    Z = Z * N_FFT / 2  # [S, 2, 2049, T]
    inp = np.stack([Z[:, 0].real, Z[:, 0].imag, Z[:, 1].real, Z[:, 1].imag], axis=1)[:, :, :DIM_F].astype(np.float32)
    out = np.concatenate([sess.run(None, {'input': inp[i:i + batch]})[0] for i in range(0, len(inp), batch)])
    Y = np.zeros(Z.shape, dtype=np.complex128)
    Y[:, 0, :DIM_F] = out[:, 0] + 1j * out[:, 1]; Y[:, 1, :DIM_F] = out[:, 2] + 1j * out[:, 3]
    _, y = istft(Y / (N_FFT / 2), fs=44100, window='hann', nperseg=N_FFT, noverlap=N_FFT - HOP, boundary=False)  # [S, 2, ~N]
    y = np.pad(y, ((0, 0), (0, 0), (0, max(0, N - y.shape[-1]))))[..., :N].transpose(0, 2, 1)  # [S, N, 2]
    w = np.hanning(N + 1)[:-1][:, None]  # periodic Hann; overlap-add at hop N/2 sums to 1
    acc = np.zeros_like(xp)
    for s, seg in zip(starts, y):
        acc[s:s + N] += seg * w
    vocal = acc[H:H + n] * gain
    return vocal, x - vocal

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('tag'); ap.add_argument('--T', type=int, default=32); ap.add_argument('--gain', type=float, default=1.0)
    ap.add_argument('--clips', type=int, default=50)
    a = ap.parse_args()
    so = ort.SessionOptions(); so.intra_op_num_threads = 4
    sess = ort.InferenceSession(str(MODEL), so, providers=['CPUExecutionProvider'])
    for d in sorted((ROOT / 'clips/wav').iterdir())[: a.clips]:
        x, sr = sf.read(d / 'mix.wav'); assert sr == 44100
        vocal, inst = separate(x, sess, a.T, a.gain)
        (d / a.tag).mkdir(exist_ok=True)
        sf.write(d / a.tag / 'vocal.wav', vocal, sr, subtype='FLOAT'); sf.write(d / a.tag / 'instrumental.wav', inst, sr, subtype='FLOAT')
    N = seg_len(a.T)
    print(f'{a.tag}: added delay {N} samples = {N / 44100 * 1000:.1f} ms + inference')
