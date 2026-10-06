"""SRI-117 parity reference. For bench clips, runs the python references (spike/ml/mdx_stream.py separate() = A cappella,
spike/ml/hybrid_stream.py rows_for() h3_p2_g0.8 = Karaoke) on the first 8 stream blocks (8 · 34304 samples) and dumps,
per clip, everything scripts/parity-mdx.test.mjs needs to replay the TypeScript pipeline with the same model outputs:
  x.f32 [2, n]; mdx_in/out.f32 [S, 4, 2048, 64]; spl_in/out.f32 [S', 2, 64, 1024]; ref_v.f32, ref_inst.f32 [2, n].
Usage: python scripts/parity-ref.py <out dir> [clip ids ...]   (python with museval-free deps: numpy scipy soundfile onnx onnxruntime)"""
import sys, pathlib
import numpy as np, soundfile as sf, onnxruntime as ort
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'spike/ml'))
import mdx_stream as mx, spleeter_stream as ss, hybrid_stream as hy

H, NB = 34304, 8  # bench clips are ~6.8 s: 8 whole blocks
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
clips = sys.argv[2:] or ['00', '01', '02']

class Rec:
    """Session wrapper: remembers the first call's input and output."""
    def __init__(self, s): self.s, self.i, self.o = s, [], []
    def run(self, names, feed):
        arr = next(iter(feed.values())); r = self.s.run(names, feed)
        self.i.append(arr.copy()); self.o.append(np.asarray(r[0]).copy()); return r

so = ort.SessionOptions(); so.intra_op_num_threads = 4
mdx = ort.InferenceSession(str(mx.MODEL), so, providers=['CPUExecutionProvider'])
voc, acc = ss.session('vocals'), ss.session('accompaniment')
for c in clips:
    x, sr = sf.read(ROOT / f'spike/clips/wav/{c}/mix.wav'); assert sr == 44100
    x = x[: NB * H]
    rm = Rec(mdx); v, _ = mx.separate(x, rm, 64)
    ri = np.concatenate(rm.i)[:NB]; ro = np.concatenate(rm.o)[:NB]
    rv = Rec(voc)
    m_spl, m_c2 = hy.masks(x, rv, acc)
    inst = hy.rows_for(x, v, m_spl, m_c2, sweep=True)['h3_p2_g0.8'][1]
    si = rv.i[0].transpose(1, 0, 2, 3); so_ = rv.o[0].transpose(1, 0, 2, 3)  # [S', 2, 64, 1024]
    d = out / c; d.mkdir(exist_ok=True)
    for name, a in [('x', x.T), ('mdx_in', ri), ('mdx_out', ro), ('spl_in', si), ('spl_out', so_), ('ref_v', v.T), ('ref_inst', inst.T)]:
        np.ascontiguousarray(a, dtype=np.float32).tofile(d / f'{name}.f32')
    print(c, 'n', len(x), 'mdx segs', len(ri), 'spl windows', len(si), flush=True)
