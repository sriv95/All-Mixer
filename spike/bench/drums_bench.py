"""Drum-stem model bench on the 50 MUSDB18 7 s test clips (spike/clips/wav, from export_clips.py).

Each model gets two inputs: `mix` (full song) and `inst` (true accompaniment = drums + bass + other, the ideal input of a
2nd pass after the vocal model). Reported per run (median over clips, dB): sdr_drums vs the drums stem,
sdr_others vs bass + other, where others = input - drums_est. Also wall time per clip (CPU, torch) and parameter count.
Models: ZFTurbo MSST checkpoints (cloned into .cache/drums/msst, ckpts next to it) and audio-separator ones.
  .venv/bin/python spike/bench/drums_bench.py <model> [<model> ...] [--clips N] [--inputs mix,inst]
Appends one JSON row per (model, input) to spike/bench/results/drums.jsonl.
"""
import argparse, json, os, pathlib, sys, tempfile, time
import numpy as np, soundfile as sf, torch

ROOT = pathlib.Path(__file__).resolve().parents[2]
CLIPS = ROOT / 'spike/clips/wav'
CACHE = ROOT / '.cache/drums'
OUT = ROOT / 'spike/bench/results/drums.jsonl'
sys.path.insert(0, str(CACHE / 'msst'))

# name -> (msst model_type, config, ckpt, index of drums in the output)
MSST = {
    'dttnet': ('dttnet', 'config_DTTNet_drums.yaml', 'dttnet_drumsg32_ep1612_fix.ckpt'),
    'scnet-large': ('scnet', 'config_musdb18_scnet_large_starrytong.yaml', 'SCNet-large_starrytong_fixed.ckpt'),
    'scnet-xl': ('scnet', 'config_musdb18_scnet_xl_more_wide_v5.yaml', 'model_scnet_ep_36_sdr_10.0891.ckpt'),
    'scnet-tran': ('scnet_tran', 'config_musdb18_scnet_tran.yaml', 'model_scnet_tran_sdr_8.9272.ckpt'),
    'scnet-masked-small': ('scnet_masked', 'config_musdb18_scnet_small.yaml', 'model_scnet_masked_ep_156_sdr_8.8149.ckpt'),
    'bs-roformer': ('bs_roformer', 'config_bs_roformer_384_8_2_485100.yaml', 'model_bs_roformer_ep_17_sdr_9.6568.ckpt'),
}
# audio-separator model filename; the stem called 'drums' is the output
AS = {
    'htdemucs': 'htdemucs.yaml',
    'htdemucs_ft': 'htdemucs_ft.yaml',
    'kuielab_b': 'kuielab_b_drums.onnx',
}


def sdr(ref, est):
    n = min(len(ref), len(est))
    ref, est = ref[:n], est[:n]
    return 10 * np.log10((ref ** 2).sum() / max(((ref - est) ** 2).sum(), 1e-12))


def load_msst(name):
    from utils.settings import get_model_from_config
    from utils.model_utils import demix
    mt, cfg, ckpt = MSST[name]
    model, config = get_model_from_config(mt, str(CACHE / cfg))
    import os
    if os.environ.get('CHUNK'):
        config.audio.chunk_size = int(os.environ['CHUNK'])
        config.inference.num_overlap = int(os.environ.get('OVERLAP', config.inference.num_overlap))
    sd = torch.load(CACHE / ckpt, map_location='cpu', weights_only=False)
    if isinstance(sd, dict) and 'state_dict' in sd:
        sd = sd['state_dict']
    if isinstance(sd, dict) and 'state' in sd:
        sd = sd['state']
    model.load_state_dict(sd)
    model.eval()
    params = sum(p.numel() for p in model.parameters())
    inst = list(config.training.instruments)
    di = inst.index('drums') if 'drums' in inst else 0

    def run(wav, sr):  # wav (T, 2) float32
        mix = torch.from_numpy(wav.T.copy())
        with torch.no_grad():
            r = demix(config, model, mix, torch.device('cpu'), mt, pbar=False)
        if isinstance(r, dict):
            return r['drums'].T if 'drums' in r else next(iter(r.values())).T
        return np.asarray(r)[di].T
    return run, params


def load_as(name):
    from audio_separator.separator import Separator
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='drumsbench'))
    sep = Separator(output_dir=str(tmp), output_format='WAV', model_file_dir=str(CACHE / 'as-models'), log_level=40)
    sep.load_model(AS[name])

    def run(wav, sr):
        src = tmp / 'in.wav'
        sf.write(src, wav, sr, subtype='FLOAT')
        for f in tmp.glob('in_*'):
            f.unlink()
        outs = sep.separate(str(src))
        pick = [o for o in outs if '(drums)' in o.lower() or '(Drums)' in o]
        if not pick:
            raise SystemExit(f'no drums stem in {outs}')
        p = pathlib.Path(pick[0])
        p = p if p.is_absolute() else tmp / p.name
        d, _ = sf.read(p, dtype='float32')
        return d
    return run, 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('models', nargs='+')
    ap.add_argument('--clips', type=int, default=50)
    ap.add_argument('--inputs', default='mix,inst')
    a = ap.parse_args()
    torch.set_num_threads(4)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    for name in a.models:
        run, params = load_msst(name) if name in MSST else load_as(name)
        for inp in a.inputs.split(','):
            sd, so, secs = [], [], []
            for i in range(a.clips):
                d = CLIPS / f'{i:02d}'
                x, sr = sf.read(d / ('mix.wav' if inp == 'mix' else 'accompaniment.wav'), dtype='float32')
                drums, _ = sf.read(d / 'drums.wav', dtype='float32')
                rest, _ = sf.read(d / 'accompaniment.wav', dtype='float32')
                rest = rest - drums
                t = time.time()
                est = run(x, sr)
                secs.append(time.time() - t)
                n = min(len(x), len(est), len(drums))
                sd.append(sdr(drums[:n], est[:n]))
                so.append(sdr(rest[:n], (x[:n] - est[:n])) if inp == 'inst' else float('nan'))
            row = dict(model=name + (f"@{os.environ['CHUNK']}/{os.environ.get('OVERLAP', '')}" if os.environ.get('CHUNK') else ''), input=inp, clips=a.clips, params_m=round(params / 1e6, 1),
                       sdr_drums=round(float(np.median(sd)), 2), sdr_drums_mean=round(float(np.mean(sd)), 2),
                       sdr_others=round(float(np.nanmedian(so)), 2) if inp == 'inst' else None,
                       sec_per_7s_clip=round(float(np.median(secs)), 2))
            print(json.dumps(row), flush=True)
            with OUT.open('a') as f:
                f.write(json.dumps(row) + '\n')


if __name__ == '__main__':
    main()
