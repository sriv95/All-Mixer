"""SRI-219: offline MDX (mdx_stream.separate, T=64) on the lovely capture under Chrome-runtime variants; saves 250 ms frame dB of V.
Usage: python sri219_sweep.py <capture.st.f32> <out_dir> <cfg> [<cfg> ...]
cfg: shift<N> (stream starts N samples earlier = grid phase), gain<g> (input scale), f32 (float32 STFT/iSTFT/cross-fade like the worker),
     fp16in (input tensor rounded to fp16), mono (L=R=mean)."""
import sys, json, pathlib, re
import numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import mdx_stream as mx
SR = 44100; F = SR // 4
ref, out = sys.argv[1], pathlib.Path(sys.argv[2]); out.mkdir(exist_ok=True)
x0 = np.fromfile(ref, dtype=np.float32).astype(np.float64).reshape(2, -1).T.copy()
so = mx.ort.SessionOptions(); so.intra_op_num_threads = 6
sess = mx.ort.InferenceSession(str(mx.MODEL), so, providers=['CPUExecutionProvider'])
db = lambda e: float(10 * np.log10(e + 1e-12))
for cfg in sys.argv[3:]:
    f = out / f'{cfg}.json'
    if f.exists(): continue
    x, shift, fp16 = x0, 0, False
    for p in cfg.split('+'):
        if p.startswith('shift'): shift = int(p[5:])
        elif p.startswith('gain'): x = x * float(p[4:])
        elif p == 'mono': x = np.repeat(x.mean(1, keepdims=True), 2, 1)
        elif p == 'fp16in': fp16 = True
    s = sess
    if fp16:
        class W:  # round the model input to fp16 and back
            def run(self, n, d): return sess.run(n, {k: v.astype(np.float16).astype(np.float32) for k, v in d.items()})
        s = W()
    xs = np.concatenate([np.zeros((shift, 2)), x])
    v = mx.separate(xs, s, 64)[0][shift:]
    if 'f32' in cfg.split('+'): v = v.astype(np.float32).astype(np.float64)
    fr = [db(np.mean(v.mean(1)[i * F:(i + 1) * F] ** 2)) for i in range(len(v) // F)]
    json.dump(fr, open(f, 'w')); print(cfg, 'done', flush=True)
