"""Real STFT input of a MUSDB clip + torch fp32 core output for SW, for sw_parity.mjs (WebGPU vs torch). Writes spike/ml/models/sw_x.f32, sw_y.f32 (T=200)."""
import pathlib, sys, numpy as np, soundfile as sf, torch
from einops import rearrange
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from guitar_bench import CLIPS, ROOT
from sw_export import load, Core
m = load(); core = Core(m).eval()
mix = sf.read(CLIPS / '05/mix.wav', dtype='float32')[0][:44100 * 3 + 512 * 200]
w = torch.from_numpy(mix.T.copy())
st = torch.view_as_real(torch.stft(w, **m.stft_kwargs, window=m.stft_window_fn(), return_complex=True))
x = rearrange(st, 's f t c -> t (f s c)')[None][:, 100:300]
with torch.no_grad():
    y = core(x)
d = ROOT / 'spike/ml/models'
x.numpy().astype('<f4').tofile(d / 'sw_x.f32'); y.numpy().astype('<f4').tofile(d / 'sw_y.f32')
print(x.shape, y.shape, float(y.abs().mean()))
