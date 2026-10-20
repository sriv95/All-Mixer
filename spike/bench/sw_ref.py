"""One-pass torch fp32 SW stems of the MIX of MUSDB clips 00..03 back to back (~28 s), for sw_stream_eval.mjs.
Writes .cache/sw/ref/input.f32 and <stem>.f32 (L then R)."""
import pathlib, sys, numpy as np, soundfile as sf, torch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from guitar_bench import CLIPS, ROOT
from sw_export import load
torch.set_num_threads(4)
mix = np.concatenate([sf.read(CLIPS / f'{i:02d}/mix.wav', dtype='float32')[0] for i in range(4)])
n = len(mix)
(ROOT / '.cache/sw/ref').mkdir(parents=True, exist_ok=True)
np.concatenate([mix[:, 0], mix[:, 1]]).astype('<f4').tofile(ROOT / '.cache/sw/ref/input.f32')
w = mix.T.copy()
w = np.pad(w, ((0, 0), (0, -n % 512 + 512)))
m = load()
with torch.no_grad():
    y = m(torch.from_numpy(w)[None])[0].numpy()[:, :, :n]  # [6, 2, n]
out = ROOT / '.cache/sw/ref'
out.mkdir(parents=True, exist_ok=True)
for i, name in enumerate(['bass', 'drums', 'other', 'vocals', 'guitar', 'piano']):
    np.concatenate([y[i, 0], y[i, 1]]).astype('<f4').tofile(out / f'{name}.f32')
print('ok', n / 44100, 's')
