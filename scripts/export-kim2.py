"""Export Kim Vocal 2 (UVR MDX-Net, vocal stem) for the extension (the Model menu in the popup, High quality):
Writes models-out/kim2.onnx + kim2-meta.json (MODELS_OUT env overrides the folder). Not part of the extension build:
`bun run model-manifest` prepares them for upload to the Hugging Face repo that the extension downloads from.

The weights are the original UVR ONNX file (66.8 MB fp32, SHA-256 checked). The ONNX file written here is fp16 weights,
fp32 input/output, any number of STFT frames (the `frames` axis, dim 3, is named so and made dynamic). The graph is the
network only; the STFT (n_fft 7680, hop 1024, bins 0..3071 as [Lre, Lim, Rre, Rim]), the iSTFT and the trim run in JS.
UVR parameters (model_data.json, key 970b3f9492014d18fefeedfe4773cb42 = md5 of the last 10 MB of the file):
compensate 1.009, mdx_dim_f_set 3072, mdx_n_fft_scale_set 7680, primary_stem Vocals.
  bun run export-kim2 [--force]
"""
import argparse, hashlib, json, os, pathlib, sys, urllib.request
import numpy as np, onnx, onnxruntime as ort
from onnxruntime.transformers.float16 import convert_float_to_float16

ROOT = pathlib.Path(__file__).resolve().parents[1]
URL = 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx'
SHA = 'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b'
NFFT, HOP, DIM_F, COMP, SR = 7680, 1024, 3072, 1.009, 44100


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    out = pathlib.Path(os.environ.get('MODELS_OUT') or ROOT / 'models-out')
    if not a.force and (out / 'kim2.onnx').exists() and (out / 'kim2-meta.json').exists():
        print('kim2 already exported (--force to redo)')
        return
    src = ROOT / '.cache/models/Kim_Vocal_2.onnx'
    src.parent.mkdir(parents=True, exist_ok=True)
    if not src.exists():
        print('downloading', URL)
        urllib.request.urlretrieve(URL, src)
    if hashlib.sha256(src.read_bytes()).hexdigest() != SHA:
        sys.exit(f'{src}: SHA-256 mismatch')
    m = onnx.load(src)
    for t in list(m.graph.input) + list(m.graph.output):
        t.type.tensor_type.shape.dim[3].dim_param = 'frames'  # convs and freq-axis MatMuls only: any frame count works
    del m.graph.value_info[:]  # stale static shapes
    out.mkdir(parents=True, exist_ok=True)
    onnx.save(convert_float_to_float16(m, keep_io_types=True), out / 'kim2.onnx')
    g = onnx.load(out / 'kim2.onnx').graph
    assert g.input[0].type.tensor_type.shape.dim[3].dim_param == 'frames', 'the frame axis must be named "frames"'
    sess = ort.InferenceSession(str(out / 'kim2.onnx'), providers=['CPUExecutionProvider'])
    for t in (64, 128):
        y = sess.run(None, {'input': np.random.randn(1, 4, DIM_F, t).astype(np.float32) * 0.1})[0]
        assert y.shape == (1, 4, DIM_F, t) and np.isfinite(y).all(), f'bad output at {t} frames'
    meta = {'nFft': NFFT, 'hop': HOP, 'dimF': DIM_F, 'compensate': COMP, 'sampleRate': SR, 'source': URL}
    (out / 'kim2-meta.json').write_text(json.dumps(meta, separators=(',', ':')))
    print('wrote', out / 'kim2.onnx', (out / 'kim2.onnx').stat().st_size // 2**20, 'MiB')


if __name__ == '__main__':
    main()
