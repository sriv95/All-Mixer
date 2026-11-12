# usage: bench_compat.py FRAMES OUT.wav IN.wav   (FRAMES = MDX segment STFT frames, multiple of 32, 64..256; app default 64)
# Offline replay of src/ml/mdx.ts MdxStream + pipeline.ts: compat-mdx.onnx makes the VOCAL stem (instrumental = mix - vocal,
# Spleeter compat-vocals.onnx only gates that, not the vocal, so it is not run). n_fft 4096, hop 1024, periodic Hann, no centre pad,
# segment N=(T-1)*1024+4096 every N/2 (blocks, prev+cur), iSTFT/sum(w^2), periodic Hann cross-fade over the segment.
import os, pathlib; ROOT = pathlib.Path(__file__).resolve().parents[3]; MODELS = os.environ.get('MODELS_OUT') or str(ROOT / 'models-out')  # same default as stream_eval*.mjs
import sys, time, resource, numpy as np, soundfile as sf, onnxruntime as ort
T, out = int(sys.argv[1]), sys.argv[2]
inp = sys.argv[3]
assert 64 <= T <= 256 and T % 32 == 0
NF, HOP, B = 4096, 1024, 2048
N = (T - 1) * HOP + NF; H = N // 2
win = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(NF) / NF)
env = np.zeros(N)
for t in range(T): env[t*HOP:t*HOP+NF] += win**2
norm = np.where(env > 1e-10, 1 / np.maximum(env, 1e-300), 1.0)
cw = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N) / N)
idx = np.arange(T)[:, None] * HOP + np.arange(NF)[None, :]
t0 = time.time()
sess = ort.InferenceSession(MODELS + '/compat-mdx.onnx', providers=['CPUExecutionProvider'])
tload = time.time() - t0
x, sr = sf.read(inp, dtype='float32'); assert sr == 44100 and x.shape[1] == 2
n = len(x); nb = -(-n // H) + 1                      # block b completes input [(b-1)H, bH)
xp = np.zeros((nb * H, 2), np.float32); xp[:n] = x
t0 = time.time()
seg = np.zeros((2, N), np.float32); tail = np.zeros((2, H)); outs = []
xq = np.concatenate([xp, np.zeros((H, 2), np.float32)])
for b in range(nb):
    seg = np.concatenate([seg[:, H:], xq[b*H:(b+1)*H].T], axis=1)
    sp = np.fft.rfft(seg[:, idx] * win, axis=-1)[..., :B]        # [2, T, B]
    inp_ = np.stack([sp[0].real, sp[0].imag, sp[1].real, sp[1].imag])      # [4, T, B]
    xin = inp_.transpose(0, 2, 1)[None].astype(np.float32)               # [1,4,B,T]
    v = sess.run(None, {'input': xin})[0][0].transpose(0, 2, 1).astype(np.float64)   # [4,T,B]
    full = np.zeros((2, T, B + 1), complex)
    full[0, :, :B] = v[0] + 1j * v[1]; full[1, :, :B] = v[2] + 1j * v[3]
    full[:, :, 0] = full[:, :, 0].real                                  # DC real; bin 2048 = 0
    y = np.fft.irfft(full, n=NF, axis=-1) * win                         # [2,T,NF]
    acc = np.zeros((2, N))
    for t in range(T): acc[:, t*HOP:t*HOP+NF] += y[:, t]
    acc *= norm * cw
    outs.append(tail + acc[:, :H]); tail = acc[:, H:]
dt = time.time() - t0
o = np.concatenate(outs, axis=1)[:, H:H + n].T
sf.write(out, o.astype(np.float32), 44100, subtype='FLOAT')
rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20
print(f"model=compat-mdx.onnx frames={T} segment={N} blocks={nb} ep=cpu load={tload:.1f}s infer_wall={dt:.1f}s RTF={dt/(n/44100):.2f} peakRSS={rss:.0f}MB")
