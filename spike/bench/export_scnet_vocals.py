"""Export the SCNet Tran Small VOCALS stem (spike). Reuses scripts/export-scnet.py by patching its source text
(drums slice x[:, :4] -> vocals x[:, 12:16]; source 3 of 4, each source owns 4 contiguous channels:
scnet_tran.py x.view(B, dims[0]=4, -1, F, T)), then checks onnxruntime vs torch on 3 clips (CPU).
Run: <repo>/.venv/bin/python spike/bench/export_scnet_vocals.py   (needs the main repo's .cache/drums)"""
import json, pathlib, sys
import numpy as np, soundfile as sf, torch, onnxruntime as ort

HERE = pathlib.Path(__file__).resolve()
MAIN = pathlib.Path('/Users/sriv/Space/Repos/All-Mixer')
SRC = (MAIN / 'scripts/export-scnet.py').read_text()
OUT = HERE.parents[1] / 'ml/models/scnet_vocals.onnx'
for a, b in [("x[:, :4]", "x[:, 12:16]"),
             ("ROOT = pathlib.Path(__file__).resolve().parents[1]", f"ROOT = pathlib.Path({str(MAIN)!r})"),
             ("ROOT / 'models-out/drums.onnx'", f"pathlib.Path({str(OUT)!r})"),
             ("body = Body().eval()", "body = Body().eval(); globals()['_M'] = m")]:
    assert SRC.count(a) == 1, a
    SRC = SRC.replace(a, b)
g = {'__name__': 'x', '__file__': str(MAIN / 'scripts/export-scnet.py')}
exec(compile(SRC, 'export-scnet-vocals', 'exec'), g)
sys.argv = ['x', '--force']
g['main']()
m = g['_M']
cfg = m.stft_config
N, FR = 129772, 128
sess = ort.InferenceSession(str(OUT), providers=['CPUExecutionProvider'])

def sdr(est, ref):
    return 10 * np.log10((ref ** 2).sum() / (((est - ref) ** 2).sum() + 1e-12))

for clip in ['00', '03', '07']:
    d = MAIN / 'spike/clips/wav' / clip
    mix, sr = sf.read(d / 'mix.wav'); voc, _ = sf.read(d / 'vocals.wav')
    o = max(0, min(int(sr * 20), len(mix) - N))
    x = torch.tensor(mix[o:o + N].T, dtype=torch.float32)[None]
    v = voc[o:o + N].T
    with torch.no_grad():
        ref = m(x)[0, 3].numpy()  # full torch model (patched DFT/norm), source 3
        z = torch.view_as_real(torch.stft(torch.nn.functional.pad(x, (0, 276)).reshape(-1, 130048), **cfg, return_complex=True))
        z = z.permute(0, 3, 1, 2).reshape(1, 4, 2049, FR)
        y = sess.run(None, {'x': z.numpy()})[0]
        y = torch.tensor(y).reshape(2, 2, 2049, FR).permute(0, 2, 3, 1).contiguous()
        got = torch.istft(torch.view_as_complex(y), **cfg)[:, :N].numpy()
    print(clip, 'sr', sr, 'max abs diff', float(np.abs(got - ref).max()), 'SDR onnx', sdr(got, v), 'SDR torch', sdr(ref, v))

(OUT.parent / 'scnet_vocals-meta.json').write_text(json.dumps(
    {'adapter': 'stft_outside', 'sr': 44100, 'n_fft': 4096, 'hop': 1024, 'win': 'hann', 'frames': FR, 'bins': 2049,
     'layout': 'mdx', 'out_kind': 'complex', 'out_stem': 'vocals', 'compensate': 1.0, 'dtype': 'fp32'}))
