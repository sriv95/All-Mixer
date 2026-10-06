"""SRI-117: UVR_MDXNET_9482.onnx (fp32, 29.7 MB) -> public/ml/mdx.onnx (fp16 weights, fp32 input/output, time axis dynamic).
Usage: python scripts/mdx-to-fp16.py <UVR_MDXNET_9482.onnx> <out.onnx>   (needs onnx + onnxconverter-common)
Weights: UVR MDX-Net, MIT, github.com/TRvlvr/model_repo (see public/ml/THIRD_PARTY_NOTICES.txt)."""
import sys, onnx
from onnxconverter_common import float16

m = onnx.load(sys.argv[1])
for io in list(m.graph.input) + list(m.graph.output):
    d = io.type.tensor_type.shape.dim[3]  # [1, 4, 2048, T]
    d.ClearField('dim_value'); d.dim_param = 'T'
m = float16.convert_float_to_float16(m, keep_io_types=True)
onnx.save(m, sys.argv[2])
