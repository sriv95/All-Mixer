"""Dump 20 real vocals-model inputs (T=64 windows, built as separate() does with ctx=64, h=4, L=0)
and native onnxruntime outputs, plus the edited model, for bench/ort_parity.mjs.
Usage: .venv/bin/python spike/bench/parity_dump.py"""
import json, pathlib, sys
import numpy as np, soundfile as sf, onnx
from scipy.signal import stft
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'ml'))
import spleeter_stream as S

N, CTX, H, L = 20, 64, 4, 0
src = S.MODELS / 'vocals.fp16.onnx'
m = onnx.load(str(src))
for v in (*m.graph.input, *m.graph.output):
    v.type.tensor_type.shape.dim[2].dim_param = 'T'  # same edit as S.session()
out_model = S.ROOT / 'ml/models/vocals_stream.onnx'
onnx.save(m, str(out_model))
sess = S.session('vocals')

x, sr = sf.read(S.ROOT / 'clips/wav/00/mix.wav')
_, _, Z = stft(x.T, fs=sr, window='hann', nperseg=S.N_FFT, noverlap=S.N_FFT - S.HOP, boundary='zeros', padded=True)
Z = Z * S.N_FFT / 2
mag = np.abs(Z[:, :S.F, :]).transpose(0, 2, 1)
T = mag.shape[1]
mp = np.pad(mag, ((0, 0), (CTX, H + L), (0, 0)))
starts = list(range(0, T, H))
win = np.stack([mp[:, s + H + L: s + H + L + CTX] for s in starts], axis=1)  # [2, S, 64, 1024]
# skip the first 16 windows (mostly zero padding); take N evenly spaced real windows
idx = np.linspace(16, len(starts) - 1, N).astype(int)
xin = np.ascontiguousarray(win[:, idx].transpose(1, 0, 2, 3)[:, :, None]).astype(np.float32)  # [N,2,1,64,1024]
# separate() feeds [2, S, C, F] (S windows batched on the num_splits axis); model input per window is [2,1,64,1024]
ref = np.stack([S.run(sess, xin[i][:, 0:1].reshape(2, 1, CTX, S.F)) for i in range(N)]).astype(np.float32)
d = S.ROOT / 'bench/ref/parity'
xin.tofile(d / 'x.f32'); ref.tofile(d / 'y_native.f32')
json.dump({'n': N, 'inputShape': [2, 1, CTX, S.F], 'outputShape': list(ref.shape[1:]), 'windowIndex': idx.tolist(),
           'clip': 'clips/wav/00/mix.wav', 'sourceModel': str(src.relative_to(S.ROOT)), 'model': 'ml/models/vocals_stream.onnx',
           'ctx': CTX, 'hop': H, 'lookahead': L, 'maskEps': 1e-8,
           'mask': 'single-model path of separate(): clip(v / (x + 1e-8), 0, 1), x = input magnitude'},
          open(d / 'manifest.json', 'w'), indent=1)
print(xin.shape, ref.shape, float(ref.min()), float(ref.max()), 'zero-frac x', float((xin == 0).mean()))
