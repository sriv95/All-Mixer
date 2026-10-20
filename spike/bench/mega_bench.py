"""MVSep Mega 53 (single-stem BS-RoFormers, ZFTurbo/MVSep release v1.0.21, mirrored by noblebarkrr) guitar models against SW's
guitar and becruily's, on the first N MUSDB 7 s clips (torch fp32 CPU, whole clip). Files: .cache/mega/{guitar,electric-guitar,acoustic-guitar}.{ckpt,yaml}.
Proxies as in guitar_bench.py (leak / other / resid, no ground truth) and the SDR of each guitar estimate against SW's one.
  .venv/bin/python -I spike/bench/mega_bench.py [N=20]  -> spike/bench/results/mega.jsonl"""
import json, pathlib, sys, time
import numpy as np, soundfile as sf, torch, yaml
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from guitar_bench import CLIPS, ROOT, load_mel, shares
from sw_export import load as load_sw
from audio_separator.separator.uvr_lib_v5.roformer import bs_roformer as bsr

torch.set_num_threads(4)
N = int(sys.argv[1]) if len(sys.argv) > 1 else 20
MEGA = ROOT / '.cache/mega'
WAVS = ROOT / 'spike/bench/results/mega'
WAVS.mkdir(parents=True, exist_ok=True)


def load_mega(name):
    cfg = yaml.unsafe_load(open(MEGA / f'{name}.yaml'))['model']
    cfg.pop('linear_transformer_depth', None)
    m = bsr.BSRoformer(**cfg)
    m.load_state_dict(torch.load(MEGA / f'{name}.ckpt', map_location='cpu', weights_only=True), strict=True)
    m.eval()
    print(name, 'params M', round(sum(p.numel() for p in m.parameters()) / 1e6, 1), flush=True)

    def run(w):
        n = len(w)
        w = np.pad(w, ((0, -n % 512 + 512), (0, 0)))
        with torch.no_grad():
            y = m(torch.from_numpy(w.T.copy())[None])[0].numpy()
        return y.T[:n]
    return run


def sdr(ref, est):
    n = min(len(ref), len(est)); ref, est = ref[:n], est[:n]
    return float(10 * np.log10((ref ** 2).sum() / max(((ref - est) ** 2).sum(), 1e-12)))


sw = load_sw()
becruily, _ = load_mel('becruily')
models = {k: load_mega(k) for k in ('guitar', 'electric-guitar', 'acoustic-guitar')}
rows, secs = [], {}
for i in range(N):
    d = CLIPS / f'{i:02d}'
    st = {k: sf.read(d / f'{k}.wav', dtype='float32')[0] for k in ('vocals', 'drums', 'bass', 'other')}
    mix, sr = sf.read(d / 'mix.wav', dtype='float32')
    acc = sf.read(d / 'accompaniment.wav', dtype='float32')[0]
    n0 = len(mix)
    w = np.pad(mix, ((0, -n0 % 512 + 512), (0, 0)))
    with torch.no_grad():
        swg = sw(torch.from_numpy(w.T.copy())[None])[0, 4].numpy().T[:n0]
    est = {'sw': swg, 'becruily(acc)': becruily(acc, sr)}
    for k, run in models.items():
        t = time.time(); est[k] = run(mix); secs.setdefault(k, []).append(time.time() - t)
    r = {'clip': i}
    for k, e in est.items():
        n = min(len(mix), len(e))
        p = shares(e[:n], st)
        r[k] = dict(leak=p['drums'] + p['bass'] + p['vocals'], other=p['other'], resid=p['resid'], level_db=float(10 * np.log10(((e[:n] ** 2).sum() + 1e-12) / ((mix[:n] ** 2).sum() + 1e-12))), sdr_vs_sw=sdr(swg, e))
    rows.append(r)
    if i < 3:
        for k, e in est.items():
            sf.write(WAVS / f'{k.replace("(", "-").replace(")", "")}-{i:02d}.wav', e, sr, subtype='PCM_16')
    print('clip', i, flush=True)
summary = {'clips': N, 'sec_per_clip': {k: round(float(np.median(v)), 1) for k, v in secs.items()}}
for k in rows[0]:
    if k == 'clip': continue
    summary[k] = {m: round(float(np.median([r[k][m] for r in rows])), 2) for m in rows[0][k]}
print('SUMMARY', json.dumps(summary))
open(ROOT / 'spike/bench/results/mega.jsonl', 'a').write(json.dumps(summary) + '\n')
