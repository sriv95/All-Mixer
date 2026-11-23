"""Duality checkpoint -> fp32 ONNX -> fp16 ONNX (the shipped recipe), plus checks against models-out/duality.onnx.
  .venv/bin/python -I spike/duality_ft/export_duality.py [--ckpt ft.pt] --out DIR   (DIR must be temp/gitignored; default = a fresh temp dir)
Recipe: parity.py --export (dynamo, opset 18, dynamic 'frames' axis, x [1,T,Fin] -> masks) then to_fp16.py (same dir: onnxruntime convert_float_to_float16 keep_io_types,
dedupe repeated nodes; no Concat/Split grouping), as for teacher_fixed.onnx -> teacher_fp16_fixed.onnx (== shipped duality.onnx).
Checks: op-type counts and IO shapes vs the shipped duality.onnx; masks SDR (dB) of the export vs the shipped model on a real 3 s MUSDB chunk and a random input (CPU ORT).
Without --ckpt (base weights) the pass bar is: identical op counts and IO, SDR > 40 dB."""
import argparse, collections, pathlib, subprocess, sys, tempfile
import numpy as np, onnx, onnxruntime as ort, soundfile as sf, torch
from torch.export import Dim

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import duality_torch as dt
import eval_duality as ed

MAX_FRAMES = 1700  # same axis as parity.py --export (stage 1) and the shipped graph (frames 16-1700)


def info(p):
    m = onnx.load(str(p)); c = collections.Counter(n.op_type for n in m.graph.node)
    io = lambda l: [(v.name, [d.dim_param or d.dim_value for d in v.type.tensor_type.shape.dim], v.type.tensor_type.elem_type) for v in l]
    return c, io(m.graph.input), io(m.graph.output)


def sdr(ref, est): return float(10 * np.log10((ref ** 2).sum() / max(((ref - est) ** 2).sum(), 1e-20)))


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--ckpt'); ap.add_argument('--out'); a = ap.parse_args()
    out = pathlib.Path(a.out or tempfile.mkdtemp(prefix='duality_export_')); out.mkdir(parents=True, exist_ok=True)
    core = dt.load('cpu'); core = ed.load_ckpt(core, a.ckpt) if a.ckpt else core.eval()
    fin = 2 * len(core.m.freq_indices)
    f32, f16 = out / 'duality_fp32.onnx', out / 'duality_fp16.onnx'
    with torch.no_grad():
        core(torch.randn(1, ed.FR, fin) * 0.5)  # warm-up: rotary_embedding_torch caches its freqs at the first forward (175 frames); parity.py --export and the shipped graph have them baked in (no Range/Einsum). Without it the graph differs.
        torch.onnx.export(core, (torch.randn(1, 113, fin) * 0.5,), str(f32), input_names=['x'], output_names=['masks'], opset_version=18, dynamo=True,
                          dynamic_shapes={'x': {1: Dim('frames', min=16, max=MAX_FRAMES)}}, external_data=False)
    subprocess.run([sys.executable, '-I', str(HERE / 'to_fp16.py'), str(f32), str(f16)], check=True)
    ref = dt.ROOT / 'models-out/duality.onnx'; (c1, i1, o1), (c0, i0, o0) = info(f16), info(ref)
    diff = {k: (c1[k], c0[k]) for k in set(c0) | set(c1) if c0[k] != c1[k]}
    print('ops equal:', not diff, diff or '', '| nodes', sum(c1.values()), 'vs shipped', sum(c0.values())); print('IO equal:', (i1, o1) == (i0, o0), i1, o1)
    sess = lambda p: ort.InferenceSession(str(p), providers=['CPUExecutionProvider'])
    s1, s0 = sess(f16), sess(ref)
    mus = next(p for p in (dt.ROOT / '.cache/musdb18hq/test', pathlib.Path('/Users/sriv/Space/Repos/All-Mixer/.cache/musdb18hq/test')) if p.exists())
    wav, _ = sf.read(sorted(mus.iterdir())[0] / 'mixture.wav', start=44100 * 30, frames=ed.CHUNK, dtype='float32')
    xr = dt.core_features(core, torch.from_numpy(wav.T.copy())[None])[0].numpy()
    for name, x in (('real 3 s', xr), ('random', (np.random.default_rng(0).standard_normal((1, ed.FR, fin)) * 0.5).astype(np.float32))):
        y1, y0 = s1.run(None, {'x': x})[0], s0.run(None, {'x': x})[0]; v = sdr(y0, y1)
        print(f'masks SDR vs shipped, {name}: {v:.2f} dB, max abs diff {np.abs(y1 - y0).max():.3e}' + (f'  PASS (>40): {v > 40}' if not a.ckpt else ''))
    print('wrote', f16)
