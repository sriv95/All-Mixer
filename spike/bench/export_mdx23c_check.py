"""CPU sanity for export_mdx23c.py: ORT vs torch Core on 3 clips (one native centre-padded chunk each), max abs diff + vocal SDR.
  MDX_CACHE=... .venv/bin/python -I spike/bench/export_mdx23c_check.py [T=128]"""
import importlib.util, pathlib, sys
import numpy as np, torch, soundfile as sf, onnxruntime as ort
H = pathlib.Path(__file__).resolve().parent
sp = importlib.util.spec_from_file_location('e', H / 'export_mdx23c.py'); e = importlib.util.module_from_spec(sp); sp.loader.exec_module(e)
T = int(sys.argv[1]) if len(sys.argv) > 1 else 128
N = (T - 1) * 1024
core = e.Core(e.load()).eval()
win = torch.hann_window(8192)
sess = {n: ort.InferenceSession(str(e.OUT / f'mdx23c_t{T}{n}.onnx'), providers=['CPUExecutionProvider']) for n in ('', '_fp16')}
clips = pathlib.Path('/Users/sriv/Space/Repos/All-Mixer/spike/clips/wav')
sdr = lambda r, y: 10 * np.log10((r ** 2).sum() / (((r - y) ** 2).sum() + 1e-12))
for c in ('00', '01', '02'):
    mix, _ = sf.read(clips / c / 'mix.wav', dtype='float32'); voc, _ = sf.read(clips / c / 'vocals.wav', dtype='float32')
    o = 44100; x = torch.from_numpy(mix[o:o + N].T.copy()); v = voc[o:o + N].T
    S = torch.stft(x, 8192, 1024, window=win, center=True, return_complex=True)  # [2, 4097, T]
    spec = torch.view_as_real(S)[:, :4096].permute(0, 3, 1, 2).reshape(1, 4, 4096, T)
    with torch.no_grad(): ref = core(spec)
    def wav(y):
        y = torch.as_tensor(y).reshape(2, 2, 4096, T).permute(0, 2, 3, 1).contiguous()
        z = torch.complex(y[..., 0], y[..., 1]); z = torch.cat([z, torch.zeros(2, 1, T, dtype=z.dtype)], 1)
        return torch.istft(z, 8192, 1024, window=win, center=True).numpy()
    out = f'{c}: torch SDR {sdr(v, wav(ref)):.2f}'
    for n, s in sess.items():
        y = s.run(None, {'spec': spec.numpy()})[0]
        out += f' | ort{n or "_fp32"} maxdiff {np.abs(y - ref.numpy()).max():.2e} (ref max {ref.abs().max():.1f}) SDR {sdr(v, wav(y)):.2f}'
    print(out, flush=True)
