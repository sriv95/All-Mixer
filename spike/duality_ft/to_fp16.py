"""fp32 ONNX -> fp16 ONNX, the recipe of the shipped duality.onnx (verified byte-identical: convert_float_to_float16(teacher_fixed.onnx, keep_io_types=True), repeated nodes dropped).
Usage: python to_fp16.py <in.onnx> <out.onnx>.  The converter can emit a Cast twice (same output name, ORT-web rejects it): repeats are dropped (none for Duality)."""
import sys, onnx
from onnxruntime.transformers.float16 import convert_float_to_float16
m = convert_float_to_float16(onnx.load(sys.argv[1]), keep_io_types=True)
seen, keep = set(), []
for n in m.graph.node:
    key = (n.op_type, tuple(n.input), tuple(n.output))
    if key not in seen: seen.add(key); keep.append(n)
del m.graph.node[:]; m.graph.node.extend(keep)
onnx.save(m, sys.argv[2])
