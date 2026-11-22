"""Teacher vocal targets: becruily deux, long mode (13 s chunks, num_overlap 2, Hamming OLA as in spike/duality/eval_deux.py long_fn).
  .venv/bin/python spike/finetune/make_targets.py LIST OUT [--model CKPT] [--config YAML] [--device auto|cuda|mps|cpu]
  .venv/bin/python spike/finetune/make_targets.py --selftest
LIST: TSV with header-less rows `id<TAB>path` (a line with no tab = bare path, id = file stem). '#' lines skipped.
OUT/<id>/mixture.flac + vocals_teacher.flac (44.1 kHz stereo, 24-bit, same length) and OUT/targets.tsv (id, seconds, src_path).
Resumable (skips ids in targets.tsv with both files); files written tmp-then-rename. Decode: soundfile, else ffmpeg (also for non-44.1k/mono).
Precision: fp32 everywhere (autocast parity not verified)."""
import sys, os, time, argparse, pathlib, subprocess, tempfile
import numpy as np, torch, yaml, soundfile as sf
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'duality'))
import mel_band_roformer as mbr
SR, CHUNK = 44100, 573300  # config chunk_size (13 s)
MODELS = pathlib.Path(subprocess.run(['git', '-C', str(HERE), 'rev-parse', '--git-common-dir'], capture_output=True, text=True).stdout.strip() or '.').resolve().parent / '.cache' / 'models'


def pick(dev):
    if dev != 'auto': return dev
    return 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'


def load(ckpt, cfg_path, dev):
    cfg = yaml.unsafe_load(open(cfg_path)); cfg['model']['flash_attn'] = False
    m = mbr.MelBandRoformer(**cfg['model']); sd = torch.load(ckpt, map_location='cpu', weights_only=False)  # trusted local file
    m.load_state_dict(sd.get('state_dict', sd), strict=True)
    for a in m.modules():
        if hasattr(a, 'q_block'): a.q_block = 128  # exact; bounds attention memory
    return m.eval().to(dev)


def decode(path):
    try:
        x, sr = sf.read(path, dtype='float32', always_2d=True)
        if sr == SR and x.shape[1] == 2: return x.T.copy()
    except Exception: pass
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).T.copy()


def demix(m, mix, dev):  # [2, n] -> vocals [2, n]
    step = CHUNK // 2; win = torch.hamming_window(CHUNK); x = torch.from_numpy(mix); n = x.shape[1]
    res, cnt = torch.zeros_like(x), torch.zeros_like(x)
    with torch.no_grad():
        for i in range(0, n, step):
            if i + CHUNK > n: s, Ln = (n - CHUNK, CHUNK) if n >= CHUNK else (0, n)
            else: s, Ln = i, CHUNK
            part = x[:, s:s + Ln]
            if Ln < CHUNK: part = torch.nn.functional.pad(part, (0, CHUNK - Ln))
            y = m(part[None].to(dev))[0, 0][:, :Ln].float().cpu()  # stem 0 = Vocals
            res[:, s:s + Ln] += y * win[:Ln]; cnt[:, s:s + Ln] += win[:Ln]
            if s + Ln >= n: break
    return (res / cnt.clamp(min=1e-10)).numpy()


def write(path, a):  # atomic: tmp then rename
    tmp = path.with_name('.tmp.' + path.name)
    sf.write(tmp, a.T, SR, format='FLAC', subtype='PCM_24'); os.replace(tmp, path)


def run(items, out, m, dev):  # items: [(id, path)] -> compute seconds, audio seconds
    out.mkdir(parents=True, exist_ok=True); tsv = out / 'targets.tsv'
    done = {l.split('\t')[0] for l in tsv.read_text().splitlines()[1:]} if tsv.exists() else set()
    if not tsv.exists(): tsv.write_text('id\tseconds\tsrc_path\n')
    comp = audio = 0.0
    for id_, p in items:
        d = out / id_
        if id_ in done and (d / 'mixture.flac').exists() and (d / 'vocals_teacher.flac').exists(): print('skip', id_); continue
        d.mkdir(exist_ok=True); mix = decode(p); t = time.time(); voc = demix(m, mix, dev)
        if dev == 'mps': torch.mps.synchronize()
        comp += time.time() - t; audio += mix.shape[1] / SR
        write(d / 'mixture.flac', mix); write(d / 'vocals_teacher.flac', voc)
        with open(tsv, 'a') as f: f.write(f'{id_}\t{mix.shape[1] / SR:.3f}\t{p}\n')
        print('done', id_, f'{mix.shape[1] / SR:.1f}s', flush=True)
    return comp, audio


def selftest(args, dev, m):
    song = sorted(p for p in (MODELS.parent / 'musdb18hq' / 'test').iterdir() if p.is_dir())[0]
    with tempfile.TemporaryDirectory() as td:
        td = pathlib.Path(td); n = 30 * SR
        mix, voc = (sf.read(song / f, dtype='float32', frames=n)[0].T for f in ('mixture.wav', 'vocals.wav'))
        sf.write(td / 'clip.wav', mix.T, SR, subtype='FLOAT'); out = td / 'out'; items = [('clip', td / 'clip.wav')]
        comp, audio = run(items, out, m, dev)
        v = sf.read(out / 'clip' / 'vocals_teacher.flac', dtype='float32')[0].T; mx = sf.read(out / 'clip' / 'mixture.flac', dtype='float32')[0].T
        assert v.shape == mx.shape == mix.shape == (2, n), (v.shape, mx.shape, mix.shape)
        sdr = 10 * np.log10((voc ** 2).sum() / (((voc - v) ** 2).sum() + 1e-10)); assert sdr > 8, sdr
        assert (out / 'targets.tsv').read_text().splitlines()[1].split('\t')[0] == 'clip'
        c2, _ = run(items, out, m, dev); assert c2 == 0, 'resume did not skip'
        assert len((out / 'targets.tsv').read_text().splitlines()) == 2
        print(f'SELFTEST OK song={song.name} dev={dev} SDR={sdr:.2f} dB, {comp / audio * 60:.1f} s compute per audio minute, resume skipped')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('list', nargs='?'); ap.add_argument('out', nargs='?'); ap.add_argument('--selftest', action='store_true')
    ap.add_argument('--model', default=str(MODELS / 'becruily_deux.ckpt')); ap.add_argument('--config', default=str(MODELS / 'deux-config.yaml'))
    ap.add_argument('--device', default='auto', choices=['auto', 'cuda', 'mps', 'cpu']); a = ap.parse_args()
    dev = pick(a.device); m = load(a.model, a.config, dev)
    if a.selftest: selftest(a, dev, m); sys.exit(0)
    if not (a.list and a.out): ap.error('list and out required')
    items = []
    for l in open(a.list):
        l = l.strip()
        if l and not l.startswith('#'):
            i, _, p = l.partition('\t') if '\t' in l else (pathlib.Path(l).stem, '', l); items.append((i, p))
    c, au = run(items, pathlib.Path(a.out), m, dev); print(f'compute {c:.0f}s for {au:.0f}s audio')
