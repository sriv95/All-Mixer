"""Parity + re-export check for duality_torch.Core vs the shipped ONNX. CPU only.
  .venv/bin/python -I spike/duality_ft/parity.py [--export]   (--export writes <scratch>/duality_reexport.onnx, never into models-out)
Checks: (1) core x[1,175,4144] -> masks, torch fp32 vs shipped fp16 ONNX and vs fp32 teacher_fixed.onnx, random + real 3 s MUSDB chunk;
(2) host chain core_features -> Core -> apply_masks vs MelBandRoformer.forward waveform; (3) op-type counts / shapes of a fresh export."""
import sys, pathlib, collections, tempfile
import numpy as np, torch, onnx, onnxruntime as ort, soundfile as sf
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import duality_torch as dt

ROOT, FR = dt.ROOT, 175
torch.manual_seed(0)
core = dt.load().eval()
MUSDB = next(p for p in (ROOT / '.cache/musdb18hq/test', pathlib.Path('/Users/sriv/Space/Repos/All-Mixer/.cache/musdb18hq/test')) if p.exists())  # .cache is not linked into worktrees
song = sorted(MUSDB.iterdir())[0]
wav, sr = sf.read(song / 'mixture.wav', dtype='float32'); assert sr == 44100
n = (FR - 1) * 441
raw = torch.from_numpy(wav[44100 * 30:44100 * 30 + n].T.copy())[None]  # 3 s at t=30 s
sdr = lambda ref, est: float(10 * np.log10((ref ** 2).sum() / max(((ref - est) ** 2).sum(), 1e-20)))
def sess(p): return ort.InferenceSession(str(p), providers=['CPUExecutionProvider'])
S = {'fp16 shipped': sess(ROOT / 'models-out/duality.onnx'), 'fp32 teacher_fixed': sess(ROOT / 'models-out/duality-teacher/teacher_fixed.onnx')}
with torch.no_grad():
    xr = dt.core_features(core, raw)[0]
    for name, x in (('real', xr), ('random', torch.randn(1, FR, xr.shape[-1]) * 0.5)):
        y = core(x).numpy(); print(name, 'x', tuple(x.shape), 'maxabs', float(x.abs().max()))
        outs = {k: s.run(None, {'x': x.numpy()})[0] for k, s in S.items()}
        for k, o in outs.items(): print(f'  torch fp32 vs {k}: max abs diff {np.abs(y - o).max():.3e}  SDR {sdr(o, y):.2f} dB (mask), shape {o.shape}')
        print(f'  baseline fp32 ONNX vs fp16 ONNX: max abs diff {np.abs(outs["fp32 teacher_fixed"] - outs["fp16 shipped"]).max():.3e}  SDR {sdr(outs["fp32 teacher_fixed"], outs["fp16 shipped"]):.2f} dB')
    # host chain vs the full model forward (vocals waveform); model.forward(raw) uses the same patched modules
    x, st = dt.core_features(core, raw)
    v = dt.apply_masks(core, st, core(x)); ref = core.m(raw)
    print('waveform chain vs MelBandRoformer.forward:', tuple(v.shape), tuple(ref.shape), 'max abs diff', float((v - ref).abs().max()), 'SDR', sdr(ref.numpy(), v.numpy()))

if '--export' in sys.argv:
    from torch.export import Dim
    out = pathlib.Path(tempfile.mkdtemp()) / 'duality_reexport.onnx'
    fin = xr.shape[-1]
    with torch.no_grad():
        torch.onnx.export(core, (torch.randn(1, 113, fin) * 0.5,), str(out), input_names=['x'], output_names=['masks'], opset_version=18, dynamo=True,
                          dynamic_shapes={'x': {1: Dim('frames', min=16, max=1700)}}, external_data=False)
    def info(p):
        m = onnx.load(str(p)); c = collections.Counter(nd.op_type for nd in m.graph.node)
        io = lambda l: [(v.name, [d.dim_param or d.dim_value for d in v.type.tensor_type.shape.dim]) for v in l]
        return c, io(m.graph.input), io(m.graph.output), m.opset_import[0].version
    for name, p in (('re-export fp32', out), ('teacher_fixed fp32', ROOT / 'models-out/duality-teacher/teacher_fixed.onnx'), ('shipped fp16', ROOT / 'models-out/duality.onnx')):
        c, i, o, op = info(p); print(name, 'opset', op, 'nodes', sum(c.values()), 'in', i, 'out', o); globals()[name.split()[0] + name.split()[1]] = c
    a, b = globals()['re-exportfp32'], globals()['teacher_fixedfp32']
    print('op diff re-export vs teacher_fixed:', {k: (a[k], b[k]) for k in set(a) | set(b) if a[k] != b[k]} or 'EQUAL')
    s = globals()['shippedfp16']; print('op diff teacher_fixed vs shipped fp16:', {k: (b[k], s[k]) for k in set(s) | set(b) if s[k] != b[k]} or 'EQUAL')
    print('exported to', out)
