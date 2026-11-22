"""Shared random-crop loader for teacher-distillation training (kara2 r2 now, a 9482 trainer later). No model imports.
  ds = TeacherCrops(teacher_dir=None, musdb_dir=None, bs=2, frames=(228, 718), hop=441, n_fft=2048, seed=0, sr=44100)
  ds[i] -> (mix[B,2,n], teacher[B,2,n], real[B,2,n], tmask[B], rmask[B], T)   n = (T-1)*hop (centred STFT gives n/hop+1 frames)
  Item i is a whole batch drawn from rng(seed, i): T uniform in [min(frames), max(frames)] when frames is a (lo, hi) pair, else
  random.choice from a longer list. Missing stems are zeros with mask 0. Same gain (+-6 dB) and channel swap on all stems.
Sources: (1) teacher_dir: <dir>/targets.tsv (id, seconds, src_path; header optional) + <dir>/<id>/mixture.flac + vocals_teacher.flac.
(2) musdb_dir (MUSDB18-HQ train): <song>/mixture.wav + vocals.wav = real vocals. A teacher row whose src_path is a MUSDB mixture
(or whose id is the song folder name) is merged into that song (teacher mixture + teacher vocal + real vocal). MUSDB 'test' is refused.
n_fft only sets the minimum crop (n >= n_fft); crops shorter than a clip are zero-padded at the end."""
import pathlib
import numpy as np, soundfile as sf, torch


def _read(path, start, n):
    x, _ = sf.read(path, start=start, frames=n, dtype='float32', always_2d=True)
    x = x.T if x.shape[1] > 1 else np.repeat(x.T, 2, 0)
    return np.pad(x, ((0, 0), (0, n - x.shape[1])))


class TeacherCrops(torch.utils.data.Dataset):
    def __init__(self, teacher_dir=None, musdb_dir=None, bs=2, frames=(228, 718), hop=441, n_fft=2048, seed=0, sr=44100):
        assert teacher_dir or musdb_dir, 'need teacher_dir and/or musdb_dir'
        self.bs, self.frames, self.hop, self.n_fft, self.seed = bs, list(frames), hop, n_fft, seed
        self.items = []  # dict(mix, teacher|None, real|None, len)
        musdb = {}
        if musdb_dir:
            md = pathlib.Path(musdb_dir); assert md.name != 'test', 'MUSDB test songs are never used for training'
            for p in sorted(md.iterdir()):
                if (p / 'mixture.wav').exists() and (p / 'vocals.wav').exists(): musdb[p.name] = p
            assert musdb, f'no MUSDB songs in {md}'
        merged = set()
        if teacher_dir:
            td = pathlib.Path(teacher_dir)
            for line in open(td / 'targets.tsv'):
                f = line.rstrip('\n').split('\t')
                if len(f) < 3 or f[0] == 'id': continue
                id_, src = f[0], f[2]
                assert '/test/' not in src.replace('\\', '/'), f'test song in teacher targets: {src}'
                m, t = td / id_ / 'mixture.flac', td / id_ / 'vocals_teacher.flac'
                if not (m.exists() and t.exists()): continue
                song = next((k for k, p in musdb.items() if k == id_ or str(p / 'mixture.wav') == src), None)
                real = None
                if song: real = musdb[song] / 'vocals.wav'; merged.add(song)
                self.items.append(dict(mix=m, teacher=t, real=real, len=sf.info(m).frames))
        for k, p in musdb.items():
            if k not in merged: self.items.append(dict(mix=p / 'mixture.wav', teacher=None, real=p / 'vocals.wav', len=sf.info(p / 'mixture.wav').frames))
        assert self.items, 'no usable items'

    def __len__(self): return 1 << 30

    def samples(self, T): return (T - 1) * self.hop

    def __getitem__(self, i):
        rng = np.random.default_rng((self.seed, i))
        T = int(rng.integers(self.frames[0], self.frames[1] + 1)) if len(self.frames) == 2 else int(rng.choice(self.frames))
        n = max(self.samples(T), self.n_fft)
        M, Tt, R, tm, rm = [], [], [], [], []
        for _ in range(self.bs):
            it = self.items[int(rng.integers(len(self.items)))]; st = int(rng.integers(max(1, it['len'] - n)))
            m = _read(it['mix'], st, n)
            t = _read(it['teacher'], st, n) if it['teacher'] else np.zeros_like(m)
            r = _read(it['real'], st, n) if it['real'] else np.zeros_like(m)
            g = 10 ** (rng.uniform(-6, 6) / 20); sw = rng.random() < 0.5
            M.append((m[::-1] if sw else m) * g); Tt.append((t[::-1] if sw else t) * g); R.append((r[::-1] if sw else r) * g)
            tm.append(float(it['teacher'] is not None)); rm.append(float(it['real'] is not None))
        c = lambda x: torch.from_numpy(np.ascontiguousarray(np.stack(x)))
        return c(M), c(Tt), c(R), torch.tensor(tm), torch.tensor(rm), T
