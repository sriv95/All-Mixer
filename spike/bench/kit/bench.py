# usage: bench.py MODEL(roformer|deux|path.onnx) FRAMES EP(coreml|cpu) OUT.wav IN.wav   (single-stem models; sw -> bench_sw.py)
# Offline replay of src/ml/roformer.ts RoformerStream (n_fft 2048, hop 441, centre reflect, Hann, band-averaged masks,
# iSTFT OLA, 0.2 s cosine cross-fade, context-only prefix). One process per config; prints one line.
import os, pathlib; ROOT = pathlib.Path(__file__).resolve().parents[3]; MODELS = os.environ.get('MODELS_OUT') or str(ROOT / 'models-out')  # same default as stream_eval*.mjs
import sys, time, json, resource, numpy as np, soundfile as sf, onnxruntime as ort
model, F, ep, out = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
inp = sys.argv[5]
M = MODELS + '/'
path = model if model.endswith('.onnx') else M + model + '.onnx'
meta = json.load(open(path[:-5] + '-meta.json'))   # meta sits next to the model: roformer.onnx -> roformer-meta.json (was: roformer-meta unless 'deux' in path)
N_FFT, HOP, Q, CONTEXT, R = 2048, meta['hop'], 128, 439, 8832
BINS = N_FFT // 2 + 1
C = (F - 1) * HOP
H = (C - R - CONTEXT) // Q * Q          # block: chunk minus overlap and context, quantum aligned (112 -> 39680)
K, E = C - H, C - H - R
sel = np.array(meta['sel']); invb = (1 / np.maximum(np.array(meta['bands'], dtype=np.float32), 1e-8)).astype(np.float32)
win = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT))
pad = C + N_FFT
env = np.zeros(pad)
for t in range(F): env[t*HOP:t*HOP+N_FFT] += win**2
norm = np.where(env > 1e-11, 1 / np.maximum(env, 1e-11), 1.0)
ramp = 0.5 - 0.5 * np.cos(np.pi * (np.arange(R) + 0.5) / R)
idx = np.arange(F)[:, None] * HOP + np.arange(N_FFT)[None, :] - N_FFT // 2
idx = np.where(idx < 0, -idx, np.where(idx >= C, 2 * (C - 1) - idx, idx))

prov = {'coreml': [('CoreMLExecutionProvider', {})], 'cpu': []}[ep] + ['CPUExecutionProvider']
t0 = time.time()
sess = ort.InferenceSession(path, providers=prov)
tload = time.time() - t0
used = sess.get_providers()

x, sr = sf.read(inp, dtype='float32'); assert sr == 44100 and x.shape[1] == 2
n = len(x); nb = -(-(n + R) // H)
xp = np.zeros((nb * H, 2), np.float32); xp[:n] = x
chunk = np.zeros((2, C), np.float32); tail = np.zeros((2, R)); outs = []
t0 = time.time()
for b in range(nb):
    chunk = np.concatenate([chunk[:, H:], xp[b*H:(b+1)*H].T], axis=1)
    spec = np.fft.rfft(chunk[:, idx] * win, axis=-1)                    # [2, F, BINS]
    fs = spec.transpose(1, 2, 0).reshape(F, 2 * BINS)                    # (bin, ch) interleaved
    g = fs[:, sel]
    xin = np.stack([g.real, g.imag], -1).reshape(1, F, -1).astype(np.float32)
    m = sess.run(None, {'x': xin})[0].reshape(F, len(sel), 2).astype(np.float32)
    accr = np.zeros((F, 2 * BINS), np.float32); acci = np.zeros_like(accr)
    np.add.at(accr, (slice(None), sel), m[..., 0]); np.add.at(acci, (slice(None), sel), m[..., 1])
    mask = ((accr + 1j * acci).reshape(F, BINS, 2) * invb[None, :, None]).transpose(2, 0, 1)
    y = np.fft.irfft(spec * mask, n=N_FFT, axis=-1) * win              # [2, F, N_FFT]
    ola = np.zeros((2, pad))
    for t in range(F): ola[:, t*HOP:t*HOP+N_FFT] += y[:, t]
    ola *= norm
    seg = ola[:, N_FFT // 2 + E: N_FFT // 2 + E + H].copy()
    seg[:, :R] = tail * (1 - ramp) + seg[:, :R] * ramp
    tail = ola[:, N_FFT // 2 + E + H: N_FFT // 2 + E + H + R].copy()
    outs.append(seg)
dt = time.time() - t0
o = np.concatenate(outs, axis=1)[:, R:R + n].T                          # block b covers input [bH-R, ...)
sf.write(out, o.astype(np.float32), 44100, subtype='FLOAT')
rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20
print(f"model={path.split('/')[-1]} frames={F} block={H} blocks={nb} ep={used[0]} load={tload:.1f}s infer_wall={dt:.1f}s RTF={dt/(n/44100):.2f} peakRSS={rss:.0f}MB")
