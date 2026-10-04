"""Streaming (low-latency) Spleeter-2stems simulation on the MUSDB clips.

Real-time constraint: for output frame t the model may only see frames <= t + L (L = lookahead).
We run the model on a sliding window of C frames ending at frame block_end + L, every h frames,
and keep only the mask rows of the newest block. All windows of a clip are batched through the
`num_splits` axis, so the result equals frame-by-frame streaming but runs fast offline.

Added audio delay of the streaming scheme (excluding inference time):
  n_fft (STFT frame) + (h - 1 + L) * hop  samples.
Writes <clip>/<tag>/{vocal,instrumental}.wav aligned to the input (delay removed) for metrics.py.
Usage: python spleeter_stream.py <tag> --ctx 64 --hop-frames 4 --lookahead 0 [--single] [--offline]
"""
import argparse, pathlib, time
import numpy as np, soundfile as sf, onnx, onnxruntime as ort
from scipy.signal import stft, istft

N_FFT, HOP, F = 4096, 1024, 1024
ROOT = pathlib.Path(__file__).resolve().parents[1]
MODELS = ROOT / 'ml/models/sherpa-onnx-spleeter-2stems-fp16'

def session(name):
    so = ort.SessionOptions(); so.intra_op_num_threads = 4
    m = onnx.load(str(MODELS / f'{name}.fp16.onnx'))
    for v in (*m.graph.input, *m.graph.output):  # time axis is declared as 512; the U-Net accepts any multiple of 64
        v.type.tensor_type.shape.dim[2].dim_param = 'T'
    return ort.InferenceSession(m.SerializeToString(), so, providers=['CPUExecutionProvider'])

def run(sess, mag_windows):  # mag_windows: [2, S, C, 1024]
    return sess.run(None, {'x': mag_windows.astype(np.float32)})[0]

def separate(x, sr, voc, acc, ctx, h, L, single, offline):
    _, _, Z = stft(x.T, fs=sr, window='hann', nperseg=N_FFT, noverlap=N_FFT - HOP, boundary='zeros', padded=True)
    Z = Z * N_FFT / 2  # undo scipy scaling -> tf.stft-like magnitudes
    mag = np.abs(Z[:, :F, :]).transpose(0, 2, 1)  # [2, T, F]
    T = mag.shape[1]
    if offline:
        pad = (-T) % 512
        m = np.pad(mag, ((0, 0), (0, pad), (0, 0)))
        win = m.reshape(2, -1, 512, F)
        v = run(voc, win).reshape(2, -1, F)[:, :T]
        a = run(acc, win).reshape(2, -1, F)[:, :T] if not single else None
    else:
        # Left-pad with ctx frames of silence so early frames have a full window.
        m = np.pad(mag, ((0, 0), (ctx, h + L), (0, 0)))
        starts = list(range(0, T, h))
        win = np.stack([m[:, s + h + L: s + h + L + ctx] for s in starts], axis=1)  # window ends at block_end+L
        t0 = time.perf_counter()
        vw = run(voc, win); aw = run(acc, win) if not single else None
        rows = slice(ctx - h - L, ctx - L)
        v = np.concatenate([vw[:, i, rows] for i in range(len(starts))], axis=1)[:, :T]
        a = np.concatenate([aw[:, i, rows] for i in range(len(starts))], axis=1)[:, :T] if not single else None
    if single:
        mask = np.clip(v / (mag + 1e-8), 0, 1)
    else:
        mask = (v ** 2 + 1e-10 / 2) / (v ** 2 + a ** 2 + 1e-10)
    mask = mask.transpose(0, 2, 1)  # [2, F, T]
    full = np.zeros(Z.shape)
    full[:, :F, :] = mask  # bins above ~11 kHz go to the instrumental (spleeter 'zeros' extension)
    _, vocal = istft(Z * full / (N_FFT / 2), fs=sr, window='hann', nperseg=N_FFT, noverlap=N_FFT - HOP, boundary=True)
    vocal = vocal.T[: len(x)]
    return vocal, x - vocal

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('tag'); ap.add_argument('--ctx', type=int, default=64)
    ap.add_argument('--hop-frames', type=int, default=4); ap.add_argument('--lookahead', type=int, default=0)
    ap.add_argument('--single', action='store_true'); ap.add_argument('--offline', action='store_true')
    ap.add_argument('--clips', type=int, default=50)
    a = ap.parse_args()
    voc, acc = session('vocals'), (None if a.single else session('accompaniment'))
    for d in sorted((ROOT / 'clips/wav').iterdir())[: a.clips]:
        x, sr = sf.read(d / 'mix.wav')
        vocal, inst = separate(x, sr, voc, acc, a.ctx, a.hop_frames, a.lookahead, a.single, a.offline)
        (d / a.tag).mkdir(exist_ok=True)
        sf.write(d / a.tag / 'vocal.wav', vocal, sr, subtype='FLOAT')
        sf.write(d / a.tag / 'instrumental.wav', inst, sr, subtype='FLOAT')
    if not a.offline:
        print(f'{a.tag}: added delay {(N_FFT + (a.hop_frames - 1 + a.lookahead) * HOP) / 44100 * 1000:.1f} ms + inference')
