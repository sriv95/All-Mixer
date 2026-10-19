"""Guitar-stem model bench on the MUSDB18 7 s test clips (spike/clips/wav, from export_clips.py).

MUSDB has no guitar stem, so there is NO ground-truth SDR here. Proxies per clip (median over clips):
  level_db   guitar estimate RMS relative to its input (how much of the input it claims)
  leak       share of the estimate's energy that lies in drums + bass + vocals (least squares onto the four true
             stems; a guitar stem should sit in `other`, so a high share means bleed)
  other      share that lies in `other` (guitars, keys, synths, strings all live there)
  resid      share the four stems do not explain (artifacts, or true content the regression missed)
Inputs (what the 2nd/3rd pass of the cascade would see): `inst` = accompaniment, `nodrums` = accompaniment - drums.
Also wall time per clip (CPU, torch) and parameter count.
  .venv/bin/python spike/bench/guitar_bench.py becruily [htdemucs_6s] [--clips N] [--inputs inst,nodrums]
Appends one JSON row per (model, input) to spike/bench/results/guitar.jsonl, and writes the first 3 clips'
estimates to spike/bench/results/guitar/<model>-<input>-<clip>.wav for listening.
"""
import argparse, functools, json, pathlib, tempfile, time
import numpy as np, soundfile as sf, torch, yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
CLIPS = ROOT / 'spike/clips/wav'
CACHE = ROOT / '.cache/guitar'
OUT = ROOT / 'spike/bench/results/guitar.jsonl'
WAVS = ROOT / 'spike/bench/results/guitar'


def load_becruily():
    from audio_separator.separator.uvr_lib_v5.roformer import mel_band_roformer as mbr
    # audio-separator builds the mask estimator with expansion 4 whatever the config says (see scripts/export-roformer.py)
    cfg = yaml.unsafe_load(open(CACHE / 'config_guitar_becruily.yaml'))
    mbr.MaskEstimator = functools.partial(mbr.MaskEstimator, mlp_expansion_factor=cfg['model'].get('mlp_expansion_factor', 4))
    m = mbr.MelBandRoformer(**cfg['model'])
    sd = torch.load(CACHE / 'becruily_guitar.ckpt', map_location='cpu', weights_only=False)
    m.load_state_dict(sd.get('state_dict', sd) if isinstance(sd, dict) else sd, strict=True)
    m.eval()

    def run(wav, sr):  # (T, 2) -> (T, 2)
        with torch.no_grad():
            y = m(torch.from_numpy(wav.T.copy())[None])
        return y[0].numpy().T
    return run, sum(p.numel() for p in m.parameters())


def load_as(name, stem):
    from audio_separator.separator import Separator
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='guitarbench'))
    sep = Separator(output_dir=str(tmp), output_format='WAV', model_file_dir=str(ROOT / '.cache/drums/as-models'), log_level=40)
    sep.load_model(f'{name}.yaml')

    def run(wav, sr):
        src = tmp / 'in.wav'
        sf.write(src, wav, sr, subtype='FLOAT')
        for f in tmp.glob('in_*'):
            f.unlink()
        outs = sep.separate(str(src))
        pick = [o for o in outs if f'({stem})' in o.lower()]
        if not pick:
            raise SystemExit(f'no {stem} stem in {outs}')
        p = pathlib.Path(pick[0])
        p = p if p.is_absolute() else tmp / p.name
        d, _ = sf.read(p, dtype='float32')
        return d
    return run, 0


def shares(est, stems):
    """Energy shares of `est` per true stem (least squares onto the stems), plus the unexplained rest."""
    n = min(len(est), *(len(s) for s in stems.values()))
    A = np.stack([s[:n].ravel() for s in stems.values()], 1).astype(np.float64)
    y = est[:n].ravel().astype(np.float64)
    a = np.linalg.lstsq(A, y, rcond=None)[0]
    e = (y ** 2).sum() + 1e-12
    part = {k: float(((a[i] * A[:, i]) ** 2).sum() / e) for i, k in enumerate(stems)}
    part['resid'] = float(((y - A @ a) ** 2).sum() / e)
    return part


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('models', nargs='+')
    ap.add_argument('--clips', type=int, default=50)
    ap.add_argument('--inputs', default='inst,nodrums')
    a = ap.parse_args()
    torch.set_num_threads(4)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    WAVS.mkdir(parents=True, exist_ok=True)
    for name in a.models:
        run, params = load_becruily() if name == 'becruily' else load_as(name, 'guitar')
        for inp in a.inputs.split(','):
            rows, secs = [], []
            for i in range(a.clips):
                d = CLIPS / f'{i:02d}'
                st = {k: sf.read(d / f'{k}.wav', dtype='float32')[0] for k in ('vocals', 'drums', 'bass', 'other')}
                acc, sr = sf.read(d / 'accompaniment.wav', dtype='float32')
                x = acc if inp == 'inst' else acc - st['drums'][:len(acc)]
                t = time.time()
                est = run(x, sr)
                secs.append(time.time() - t)
                if i < 3:
                    sf.write(WAVS / f'{name}-{inp}-{i:02d}.wav', est, sr, subtype='FLOAT')
                n = min(len(x), len(est))
                p = shares(est[:n], st)
                rows.append(dict(level_db=10 * np.log10(((est[:n] ** 2).sum() + 1e-12) / ((x[:n] ** 2).sum() + 1e-12)),
                                 leak=p['drums'] + p['bass'] + p['vocals'], other=p['other'], resid=p['resid']))
            med = {k: round(float(np.median([r[k] for r in rows])), 3) for k in rows[0]}
            row = dict(model=name, input=inp, clips=a.clips, params_m=round(params / 1e6, 1), sec_per_7s_clip=round(float(np.median(secs)), 2), **med)
            print(json.dumps(row), flush=True)
            with OUT.open('a') as f:
                f.write(json.dumps(row) + '\n')


if __name__ == '__main__':
    main()
