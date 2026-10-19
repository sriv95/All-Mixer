"""SW with short chunks (what the extension would run): the clip is cut into chunks of B seconds + R seconds of overlap,
each run through SW alone, cross-faded in the overlaps. SDR of vocals / drums against the ground truth, guitar against SW's own
one-pass guitar (MUSDB has no guitar). First N clips.   .venv/bin/python -I spike/bench/sw_chunk.py [N=10]"""
import json, pathlib, sys
import numpy as np, soundfile as sf, torch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from guitar_bench import CLIPS, ROOT
from sw_export import load as load_sw
torch.set_num_threads(4)
N = int(sys.argv[1]) if len(sys.argv) > 1 else 10
sw = load_sw()
VOC, DRUMS, GTR = 3, 1, 4


def run(w):
    n = len(w)
    w = np.pad(w, ((0, -n % 512 + 512), (0, 0)))  # the model's iSTFT drops the tail: pad, then trim
    with torch.no_grad():
        return sw(torch.from_numpy(w.T.copy())[None])[0].numpy().transpose(0, 2, 1)[:, :n]


def chunked(x, B, R):
    out = np.zeros((6,) + x.shape, np.float32)
    wsum = np.zeros(len(x), np.float32)
    k = 0
    while k * B < len(x):
        a, b = k * B, min(len(x), k * B + B + R)
        y = run(x[a:b])
        w = np.ones(b - a, np.float32)
        if k > 0:
            m = min(R, b - a); w[:m] = 0.5 - 0.5 * np.cos(np.pi * (np.arange(m) + 0.5) / R)
        if b < len(x):
            m = min(R, b - a); w[-m:] *= 0.5 + 0.5 * np.cos(np.pi * (np.arange(m) + 0.5) / R)
        out[:, a:b] += y[:, :b - a] * w[None, :, None]
        wsum[a:b] += w
        k += 1
    return out / np.maximum(wsum, 1e-6)[None, :, None]


def sdr(ref, est):
    n = min(len(ref), len(est)); ref, est = ref[:n], est[:n]
    return float(10 * np.log10((ref ** 2).sum() / max(((ref - est) ** 2).sum(), 1e-12)))


sr = 44100
rows = {}
for i in range(N):
    d = CLIPS / f'{i:02d}'
    mix = sf.read(d / 'mix.wav', dtype='float32')[0]
    voc, dr = sf.read(d / 'vocals.wav', dtype='float32')[0], sf.read(d / 'drums.wav', dtype='float32')[0]
    one = run(mix)
    for B, R in ((1.0, 0.5), (2.0, 0.5), (3.0, 0.5), (5.5, 0.5)):
        s = chunked(mix, int(B * sr), int(R * sr))
        rows.setdefault((B, R), []).append(dict(voc=sdr(voc, s[VOC]), drums=sdr(dr, s[DRUMS]), guitar_vs_onepass=sdr(one[GTR], s[GTR]), voc_vs_onepass=sdr(one[VOC], s[VOC]), onepass_voc=sdr(voc, one[VOC]), onepass_drums=sdr(dr, one[DRUMS])))
    print('clip', i, flush=True)
for (B, R), r in rows.items():
    print(json.dumps(dict(block_s=B, overlap_s=R, clips=N, **{k: round(float(np.median([x[k] for x in r])), 2) for k in r[0]})), flush=True)
