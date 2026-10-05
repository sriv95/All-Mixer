"""Diagnostic: is the browser-vs-native gap the 1024-sample frame-grid phase (shipped pre-roll 1024 vs scipy 2048)
or WebGPU fp16? Runs the NATIVE separator on the clip delayed by SHIFT zeros (argv[1], default 3072: scipy pre-roll 2048 + 3072
= shipped pre-roll 1024 + 4 frames, so frames AND 4-frame blocks line up with the shipped worker), shifts back,
and compares to native and browser vocal outputs. Writes tag spl_h4l2_single_g<SHIFT>."""
import sys, pathlib
import numpy as np, soundfile as sf
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'ml'))
import spleeter_stream as S
import metrics as M
SH = int(sys.argv[1]) if len(sys.argv) > 1 else 3072
TAG = f'spl_h4l2_single_g{SH}'
clip = '00'; d = M.ROOT / clip
x, sr = sf.read(d / 'mix.wav')
voc = S.session('vocals')
xs = np.concatenate([np.zeros((SH, 2)), x])
v, _ = S.separate(xs, sr, voc, None, 64, 4, 2, True, False)
v = v[SH:SH + len(x)]
(d / TAG).mkdir(exist_ok=True)
sf.write(d / TAG / 'vocal.wav', v, sr, subtype='FLOAT')
sf.write(d / TAG / 'instrumental.wav', x - v, sr, subtype='FLOAT')
web = sf.read(d / 'ml_prod/vocal.wav')[0]; nat = sf.read(d / 'spl_h4l2_single/vocal.wav')[0]
r = lambda a, b: (float(np.abs(a - b).max()), float(np.sqrt(((a - b) ** 2).mean())))
print('browser vs native-shifted-grid  maxabs/rms', r(web, v))
print('browser vs native               maxabs/rms', r(web, nat))
print('native-shifted vs native        maxabs/rms', r(v, nat))
