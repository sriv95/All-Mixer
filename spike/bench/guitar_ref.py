"""Long reference for guitar_stage_eval.mjs: accompaniment of MUSDB clips 00..03 back to back (~28 s), and each guitar model's
torch fp32 estimate on the whole thing in ONE pass (the best context the model can have). Writes
.cache/guitar/ref/{input,becruily,chencfd}.f32 (L then R). Usage: .venv/bin/python spike/bench/guitar_ref.py [becruily] [chencfd]"""
import pathlib, sys
import numpy as np, soundfile as sf, torch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from guitar_bench import CLIPS, ROOT, load_mel

out = ROOT / '.cache/guitar/ref'
out.mkdir(parents=True, exist_ok=True)
x = np.concatenate([sf.read(CLIPS / f'{i:02d}/accompaniment.wav', dtype='float32')[0] for i in range(4)])
(out / 'input.f32').write_bytes(np.concatenate([x[:, 0], x[:, 1]]).astype('<f4').tobytes())
torch.set_num_threads(4)
for name in sys.argv[1:] or ['becruily', 'chencfd']:
    run, _ = load_mel(name)
    e = run(x, 44100)
    (out / f'{name}.f32').write_bytes(np.concatenate([e[:, 0], e[:, 1]]).astype('<f4').tobytes())
    print(name, len(x) / 44100, 's, rms', float(np.sqrt((e ** 2).mean())), 'in rms', float(np.sqrt((x ** 2).mean())))
