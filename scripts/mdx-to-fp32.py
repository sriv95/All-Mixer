"""UVR_MDXNET_9482.onnx (fp32) -> fp32 model with the time axis dynamic (the 'compat' model for GPUs without shader-f16).
Usage: python scripts/mdx-to-fp32.py <UVR_MDXNET_9482.onnx> <out.onnx>   (needs onnx; scripts/mdx-to-fp16.py is the fp16 twin)"""
import sys, onnx

m = onnx.load(sys.argv[1])
for io in list(m.graph.input) + list(m.graph.output):
    d = io.type.tensor_type.shape.dim[3]  # [1, 4, 2048, T]
    d.ClearField('dim_value'); d.dim_param = 'T'
onnx.save(m, sys.argv[2])
