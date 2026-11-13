"""Writes spike/bench/results/fast_work/clips_{mix,voc,acc}.f32 ([L...][R...]) + clips.json for fast_eval.mjs: the 142-clip set of KNOWLEDGES
(set A = spike/clips/wav 00-49, set B = spike/clips/musdb7/*/*.stem.mp4 minus names already in A, as kit/prep_musdb.py), 2 s of silence after each.
Clips are read from the main repo (gitignored). Needs ffmpeg.   .venv/bin/python -I spike/bench/fast_prep.py
"""
import glob, json, os, pathlib, subprocess, sys
import numpy as np, soundfile as sf
HERE = pathlib.Path(__file__).resolve().parents[2]  # worktree spike/..
MAIN = pathlib.Path(os.environ.get('ALLMIXER_MAIN', '/Users/sriv/Space/Repos/All-Mixer'))
CLIPS = MAIN / 'spike/clips'
OUT = HERE / 'spike/bench/results/fast_work'; OUT.mkdir(parents=True, exist_ok=True)
SR = 44100


def dec(f, i):
    b = subprocess.run(['ffmpeg', '-v', 'error', '-i', f, '-map', f'0:{i}', '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    return np.frombuffer(b, np.float32).reshape(-1, 2).T


clips = []  # (name, mix, voc, acc) each [2, n]
A = [d.rstrip('/') + '/' for d in sorted(glob.glob(str(CLIPS / 'wav/*/')))]
names = set()
for d in A:
    names.add(open(d + 'name.txt').read().strip())
    r = {k: sf.read(d + f'{k}.wav', dtype='float32')[0].T for k in ('mix', 'vocals', 'accompaniment')}
    clips.append((open(d + 'name.txt').read().strip(), r['mix'], r['vocals'], r['accompaniment']))
for f in sorted(glob.glob(str(CLIPS / 'musdb7/*/*.stem.mp4'))):
    name = os.path.basename(f)[:-9]
    if name in names:
        continue
    names.add(name)
    s = [dec(f, i) for i in range(5)]
    n = min(x.shape[1] for x in s)
    s = [x[:, :n] for x in s]
    clips.append((name, s[0], s[4], s[1] + s[2] + s[3]))
gap = np.zeros((2, 2 * SR), np.float32)
meta, pos = [], 0
SILENT = {'PR - Happy Daze', 'PR - Oh No'}  # flagged silent-ref in worktrees/All-Mixer-bench/results_all.csv (144 clips - 2 = the 142 of KNOWLEDGES); fast_report excludes them
for nm, m, v, a in clips:
    meta.append(dict(start=pos, len=m.shape[1], silent=nm in SILENT))
    pos += m.shape[1] + gap.shape[1]
for k, j in (('mix', 1), ('voc', 2), ('acc', 3)):
    a = np.concatenate([x for c in clips for x in (c[j], gap)], axis=1)
    np.concatenate([a[0], a[1]]).astype(np.float32).tofile(OUT / f'clips_{k}.f32')
(OUT / 'clips.json').write_text(json.dumps(dict(clips=meta, names=[c[0] for c in clips], total=pos)))
print(sum(m['silent'] for m in meta), 'silent:', [c[0] for c, m in zip(clips, meta) if m['silent']]); print(len(clips), 'clips (A', len(A), '), mean len', round(np.mean([m['len'] for m in meta]) / SR, 2), 's, total', round(pos / SR), 's')
