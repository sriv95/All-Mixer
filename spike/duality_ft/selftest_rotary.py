"""Export guard: a model warmed at 175 frames (the bug), then dt.warm_rotary + dynamic-frames export, must run in ORT at frames 176, 400, 900.
  .venv/bin/python -I spike/duality_ft/selftest_rotary.py   (tiny rotary model, seconds; no checkpoint needed)"""
import sys, pathlib, tempfile
import torch, onnxruntime as ort
from torch.export import Dim
from rotary_embedding_torch import RotaryEmbedding
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import duality_torch as dt


class Tiny(torch.nn.Module):
    def __init__(s): super().__init__(); s.rot = RotaryEmbedding(dim=8); s.q = torch.nn.Linear(16, 16)
    def forward(s, x): return s.rot.rotate_queries_or_keys(s.q(x).reshape(x.shape[0], 2, x.shape[1], 8)).sum(1)


m = Tiny().eval()
with torch.no_grad():
    m(torch.randn(1, 175, 16))  # bakes the cache, as the first forward of the real model does
    m = dt.warm_rotary(m, 16)
    f = pathlib.Path(tempfile.mkdtemp()) / 'tiny.onnx'
    torch.onnx.export(m, (torch.randn(1, 113, 16),), str(f), input_names=['x'], output_names=['y'], opset_version=18, dynamo=True,
                      dynamic_shapes={'x': {1: Dim('frames', min=16, max=1700)}}, external_data=False)
for n in (113, 176, 400, 900):
    o = ort.SessionOptions(); o.add_free_dimension_override_by_name('frames', n)
    y = ort.InferenceSession(str(f), o, providers=['CPUExecutionProvider']).run(None, {'x': torch.randn(1, n, 16).numpy()})[0]
    assert y.shape == (1, n, 8), y.shape
print('PASS rotary export runs at frames 113, 176, 400, 900')
