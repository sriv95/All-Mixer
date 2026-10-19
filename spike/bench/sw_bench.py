"""BS-RoFormer SW (6 stems) against the models the extension runs, on the first N of the 50 MUSDB 7 s clips (torch fp32, CPU,
the whole clip in one pass, so this is the model and not the chunking).
  vocals  SW vs deux (Best quality) vs Kim FT (High quality): SDR against the vocals stem, on the full mix
  drums   SW on the full mix: SDR against the drums stem (spike/bench/results/drums.jsonl has SCNet Tran on the true accompaniment)
  bass, other(+guitar+piano)  SW: SDR against those stems
  guitar  no ground truth in MUSDB: the proxies of guitar_bench.py (leak / other / resid) for SW's guitar (input: the mix) and becruily's
          (input: the accompaniment), plus listening wavs for the first 3 clips.
  .venv/bin/python -I spike/bench/sw_bench.py [N=20]     -> spike/bench/results/sw.jsonl
"""
import functools, json, pathlib, sys, time
import numpy as np, soundfile as sf, torch, yaml
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from guitar_bench import CLIPS, ROOT, load_mel, shares, MEL
from sw_export import load as load_sw
from audio_separator.separator.uvr_lib_v5.roformer import mel_band_roformer as mbr

N = int(sys.argv[1]) if len(sys.argv) > 1 else 20
M = ROOT / '.cache/models'
OUT = ROOT / 'spike/bench/results/sw.jsonl'
WAVS = ROOT / 'spike/bench/results/sw'
torch.set_num_threads(4)


def sdr(ref, est):
    n = min(len(ref), len(est))
    ref, est = ref[:n], est[:n]
    return float(10 * np.log10((ref ** 2).sum() / max(((ref - est) ** 2).sum(), 1e-12)))


def mel(config, ckpt):
    cfg = yaml.unsafe_load(open(config))
    if not cfg['model'].get('linear_transformer_depth'):
        cfg['model'].pop('linear_transformer_depth', None)
    mbr.MaskEstimator = functools.partial(mbr.MaskEstimator, mlp_expansion_factor=cfg['model'].get('mlp_expansion_factor', 4))
    m = mbr.MelBandRoformer(**cfg['model'])
    sd = torch.load(ckpt, map_location='cpu', weights_only=False)  # our own earlier downloads (becruily/unwa), SHA-256 checked by export-roformer.py
    m.load_state_dict(sd.get('state_dict', sd) if isinstance(sd, dict) else sd, strict=True)
    m.eval()

    def run(wav):
        with torch.no_grad():
            y = m(torch.from_numpy(wav.T.copy())[None])
        y = y[0].numpy()
        return y[0].T if y.ndim == 3 else y.T  # stem 0 = vocals
    return run


sw = load_sw()


def run_sw(wav):
    with torch.no_grad():
        return sw(torch.from_numpy(wav.T.copy())[None])[0].numpy().transpose(0, 2, 1)  # [6, T, 2]


deux = mel(M / 'deux-config.yaml', M / 'becruily_deux.ckpt')
kim = mel(M / 'config_mel_band_roformer_kim_ft_unwa.yaml', M / 'mel_band_roformer_kim_ft_unwa.ckpt')
gtr, _ = load_mel('becruily')
BASS, DRUMS, OTHER, VOC, GTR, PIANO = range(6)
rows, secs = [], {'sw': [], 'deux': [], 'kim': []}
WAVS.mkdir(parents=True, exist_ok=True)
for i in range(N):
    d = CLIPS / f'{i:02d}'
    st = {k: sf.read(d / f'{k}.wav', dtype='float32')[0] for k in ('vocals', 'drums', 'bass', 'other')}
    mix, sr = sf.read(d / 'mix.wav', dtype='float32')
    acc = sf.read(d / 'accompaniment.wav', dtype='float32')[0]
    t = time.time(); s = run_sw(mix); secs['sw'].append(time.time() - t)
    t = time.time(); dv = deux(mix); secs['deux'].append(time.time() - t)
    t = time.time(); kv = kim(mix); secs['kim'].append(time.time() - t)
    g = gtr(acc, sr)
    n = min(len(mix), len(g))
    def prox(est):
        p = shares(est[:n], st)
        return dict(leak=p['drums'] + p['bass'] + p['vocals'], other=p['other'], resid=p['resid'])
    ps, pb = prox(s[GTR]), prox(g)
    r = dict(clip=i, voc_sw=sdr(st['vocals'], s[VOC]), voc_deux=sdr(st['vocals'], dv), voc_kim=sdr(st['vocals'], kv),
             drums_sw=sdr(st['drums'], s[DRUMS]), bass_sw=sdr(st['bass'], s[BASS]),
             other_sw=sdr(st['other'], s[OTHER] + s[GTR] + s[PIANO]), other_only_sw=sdr(st['other'], s[OTHER]),
             **{f'g_sw_{k}': v for k, v in ps.items()}, **{f'g_becruily_{k}': v for k, v in pb.items()},
             g_sw_level_db=float(10 * np.log10((s[GTR] ** 2).sum() / (mix ** 2).sum())), g_becruily_level_db=float(10 * np.log10((g ** 2).sum() / (acc ** 2).sum())))
    rows.append(r)
    print(json.dumps({k: round(v, 2) for k, v in r.items()}), flush=True)
    if i < 3:
        for nm, x in (('vocals', s[VOC]), ('drums', s[DRUMS]), ('guitar', s[GTR]), ('piano', s[PIANO])):
            sf.write(WAVS / f'sw-{nm}-{i:02d}.wav', x, sr, subtype='PCM_16')
        sf.write(WAVS / f'becruily-guitar-{i:02d}.wav', g, sr, subtype='PCM_16')
med = {k: round(float(np.median([r[k] for r in rows])), 2) for k in rows[0] if k != 'clip'}
med10 = {k + '_first10': round(float(np.median([r[k] for r in rows[:10]])), 2) for k in ('drums_sw', 'voc_sw', 'voc_deux', 'voc_kim')}
summary = dict(clips=N, **med, **med10, sec_per_clip={k: round(float(np.median(v)), 1) for k, v in secs.items()}, params_m_sw=round(sum(p.numel() for p in sw.parameters()) / 1e6, 1))
print('SUMMARY', json.dumps(summary))
OUT.open('a').write(json.dumps(summary) + '\n')
