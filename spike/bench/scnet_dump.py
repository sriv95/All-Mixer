"""Inputs for scnet_webgpu_parity.mjs and scnet_stage_eval.mjs (needs models-out/drums.onnx from `bun run export-scnet`, and the
MUSDB clips from export_clips.py). Writes into spike/ml/models (gitignored):
  drums.onnx                 copy of models-out/drums.onnx
  stage_in.f32 / stage_truth.f32   accompaniment and drums of clips 00-03 back to back, [L then R] (27.2 s)
  stage_py.f32               what DrumStage should output (same chunks and cross-fade, torch STFT / iSTFT, CPU ORT) for the final region
  scnet_in.f32 / scnet_ref.f32     STFT of the first chunk and the model output on CPU (the WebGPU parity check)
  .venv/bin/python spike/bench/scnet_dump.py
"""
import pathlib, shutil
import numpy as np, soundfile as sf, torch, onnxruntime as ort

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'spike/ml/models'
C, F = 129772, 21 * 1024  # SC_CHUNK, SC_FADE in src/ml/scnet.ts
S = C - F
rd = lambda i, name: sf.read(ROOT / f'spike/clips/wav/{i:02d}/{name}.wav', dtype='float32')[0]
acc, dr = [], []
for i in range(4):
    a, d = rd(i, 'accompaniment'), rd(i, 'drums')
    n = min(len(a), len(d))
    acc.append(a[:n]); dr.append(d[:n])
acc, dr = np.concatenate(acc).T, np.concatenate(dr).T
N = acc.shape[1]
OUT.mkdir(parents=True, exist_ok=True)
shutil.copy(ROOT / 'models-out/drums.onnx', OUT / 'drums.onnx')
acc.reshape(-1).astype(np.float32).tofile(OUT / 'stage_in.f32')
dr.reshape(-1).astype(np.float32).tofile(OUT / 'stage_truth.f32')
sess = ort.InferenceSession(str(OUT / 'drums.onnx'), providers=['CPUExecutionProvider'])
win = torch.ones(4096)
fade = np.sin(np.pi / 2 * ((np.arange(F) + 0.5) / F)) ** 2
out = np.zeros((2, N))
j = 0
while j * S + C <= N:
    st = j * S
    xp = torch.nn.functional.pad(torch.from_numpy(acc[:, st:st + C].copy()), (0, 276))
    Z = torch.stft(xp, n_fft=4096, hop_length=1024, win_length=4096, window=win, center=True, normalized=True, return_complex=True)
    X = torch.view_as_real(Z).permute(0, 3, 1, 2).reshape(1, 4, 2049, -1).contiguous().numpy()
    if j == 0:
        X.tofile(OUT / 'scnet_in.f32')
    Y = sess.run(None, {'x': X})[0]
    if j == 0:
        Y.astype(np.float32).tofile(OUT / 'scnet_ref.f32')
    Yc = torch.view_as_complex(torch.from_numpy(Y).reshape(2, 2, 2049, 128).permute(0, 2, 3, 1).contiguous())
    y = torch.istft(Yc, n_fft=4096, hop_length=1024, win_length=4096, window=win, center=True, normalized=True, length=xp.shape[1])[:, :C].numpy()
    w = np.ones(C)
    if j > 0:
        w[:F] = fade
    w[C - F:] = 1 - fade
    out[:, st + (0 if j == 0 else F):st + C] = 0
    out[:, st:st + C] += y * w
    j += 1
R = j * S
np.concatenate([out[0, :R], out[1, :R]]).astype(np.float32).tofile(OUT / 'stage_py.f32')
print('wrote', OUT, 'ready', R / 44100, 's of', N / 44100)
