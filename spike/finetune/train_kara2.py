"""Fine-tune kara2 (LeadBackingRoformer, lab 6daf2f3) vocals path (fine-tune spike, kara2 port of train.py).
  python spike/finetune/train_kara2.py --data <musdb18hq/train> --out .cache/finetune/k2run [--steps N --bs 2 --lr 1e-5 --resume]
  python spike/finetune/train_kara2.py --bench 20 --frames 718 --bs 2   # speed + peak VRAM only, no checkpoint
  python spike/finetune/train_kara2.py --selftest
Data: subfolders with mixture.wav + vocals.wav (MUSDB18-HQ), real vocals as target.
Loss: lab6daf MelBandRoformer.forward recipe (spike/duality/lab6daf/mel_band_roformer.py, config.yaml multi_stft_*):
  L1(waveform) + 1.0 * sum over windows 4096/2048/1024/512/256 of L1(complex STFT), hop 147, n_fft=max(win,2048), hann, not normalized.
Freeze: kara2_torch.freeze (only split_estimator.* frozen). One frame count per step (whole batch), from rng(seed, step) -> exact resume.
Checkpoint: last.pt = dict(model=full state_dict (keys as kara2_torch.load), opt, step, best); best.pt = state_dict."""
import argparse, pathlib, sys, tempfile, time
import numpy as np, soundfile as sf, torch
import torch.nn.functional as F

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import kara2_torch as kt

ROOT, HOP, SR = kt.ROOT, kt.HOP, 44100
FRAMES = [228, 303, 379, 450, 519, 587, 653, 718]  # planRof frame counts at 316.9 ms for integer delays 3..10 s
WINS, STFT_HOP, NFFT = (4096, 2048, 1024, 512, 256), 147, 2048


def find_songs(d):
    s = [p for p in sorted(pathlib.Path(d).iterdir()) if (p / 'mixture.wav').exists() and (p / 'vocals.wav').exists()]
    assert s, f'no songs in {d}'
    return s


def read(p, name, start, n):  # float32 [2, n], zero-padded at the end
    x, _ = sf.read(p / f'{name}.wav', start=start, frames=n, dtype='float32', always_2d=True)
    return np.pad(x.T, ((0, 0), (0, n - x.shape[0])))


class Batches(torch.utils.data.Dataset):  # item i = whole batch i, built from rng(seed, i)
    def __init__(self, songs, bs, seed=0, remix=0.25, frames=FRAMES):
        self.songs, self.bs, self.seed, self.remix, self.frames = songs, bs, seed, remix, frames
        self.lens = [sf.info(s / 'mixture.wav').frames for s in songs]
    def __len__(self): return 1 << 30
    def _chunk(self, rng, n):
        i = int(rng.integers(len(self.songs))); return self.songs[i], int(rng.integers(max(1, self.lens[i] - n)))
    def __getitem__(self, i):
        rng = np.random.default_rng((self.seed, i))
        T = int(self.frames[int(rng.integers(len(self.frames)))]); n = kt.frames_to_samples(T)
        mix, voc = [], []
        for _ in range(self.bs):
            s, st = self._chunk(rng, n)
            m, v = read(s, 'mixture', st, n), read(s, 'vocals', st, n)
            if rng.random() < self.remix:  # cross-song remix: vocal of A over accompaniment of B
                s2, st2 = self._chunk(rng, n)
                m = v + (read(s2, 'mixture', st2, n) - read(s2, 'vocals', st2, n))
            g = 10 ** (rng.uniform(-6, 6) / 20)  # random gain +-6 dB
            if rng.random() < 0.5: m, v = m[::-1], v[::-1]  # channel swap
            mix.append(m * g); voc.append(v * g)
        return torch.from_numpy(np.ascontiguousarray(np.stack(mix))), torch.from_numpy(np.ascontiguousarray(np.stack(voc))), T


def loss_fn(est, tgt):  # est/tgt [B,2,n] fp32
    loss = F.l1_loss(est, tgt)
    e, t = est.reshape(-1, est.shape[-1]), tgt.reshape(-1, tgt.shape[-1])
    for w in WINS:
        kw = dict(n_fft=max(w, NFFT), win_length=w, hop_length=STFT_HOP, window=torch.hann_window(w, device=est.device), return_complex=True)
        loss = loss + F.l1_loss(torch.stft(e, **kw), torch.stft(t, **kw))
    return loss


def step_loss(model, mix, voc, dev, amp):
    mix = mix.to(dev)
    est = model.separate(mix, masks_dtype=amp)['vocals'] if dev.type == 'cuda' and amp else kt.vocals(model, mix)
    return loss_fn(est.float(), voc.to(dev))


def selftest():
    with tempfile.TemporaryDirectory() as d:
        for i in range(2):
            p = pathlib.Path(d) / f's{i}'; p.mkdir()
            for f in ('mixture', 'vocals'): sf.write(p / f'{f}.wav', np.random.randn(SR * 20, 2).astype('float32') * .1, SR)
        ds = Batches(find_songs(d), 2, seed=1); Ts = set()
        for i in range(30):
            m, v, T = ds[i]; Ts.add(T); assert m.shape == v.shape == (2, 2, kt.frames_to_samples(T)) and T in FRAMES
        assert len(Ts) > 3 and torch.equal(ds[7][0], ds[7][0])
        assert loss_fn(m, v).item() > 0 and loss_fn(v, v).item() == 0
    print('selftest ok')


def main():
    a = argparse.ArgumentParser()
    a.add_argument('--data', default=str(ROOT / '.cache/musdb18hq/train')); a.add_argument('--out', default=str(ROOT / '.cache/finetune/k2run'))
    a.add_argument('--steps', type=int, default=20000); a.add_argument('--bs', type=int, default=2)
    a.add_argument('--lr', type=float, default=1e-5); a.add_argument('--save-every', type=int, default=500)
    a.add_argument('--workers', type=int, default=2); a.add_argument('--seed', type=int, default=0)
    a.add_argument('--device', default='auto'); a.add_argument('--resume', action='store_true'); a.add_argument('--selftest', action='store_true')
    a.add_argument('--overfit', action='store_true')  # same batch every step (proof only)
    a.add_argument('--bench', type=int, default=0, help='N steps at --frames/--bs on random audio, print s/step + peak VRAM, no checkpoint')
    a.add_argument('--frames', type=int, default=718)
    a.add_argument('--fixed-frames', type=int, default=0, help='training: always this frame count (smoke on small RAM)')
    a = a.parse_args()
    if a.selftest: return selftest()
    dev = torch.device(('cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu') if a.device == 'auto' else a.device)
    amp = torch.bfloat16 if dev.type == 'cuda' and torch.cuda.is_bf16_supported() else None  # MPS/CPU: fp32
    model = kt.load().to(dev); tr, tot = kt.freeze(model)
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=a.lr)
    model.train()
    print(f'device {dev} amp {amp} bs {a.bs} lr {a.lr} trainable {tr}/{tot}', flush=True)
    if a.bench:
        n, ts = kt.frames_to_samples(a.frames), []
        mix, voc = torch.randn(a.bs, 2, n) * .1, torch.randn(a.bs, 2, n) * .1
        if dev.type == 'cuda': torch.cuda.reset_peak_memory_stats()
        sync = lambda: torch.cuda.synchronize() if dev.type == 'cuda' else torch.mps.synchronize() if dev.type == 'mps' else None
        for i in range(a.bench):
            sync(); t = time.time()
            loss = step_loss(model, mix, voc, dev, amp); opt.zero_grad(set_to_none=True); loss.backward(); opt.step(); sync()
            ts.append(time.time() - t); print(f'bench step {i + 1} {ts[-1]:.2f}s loss {loss.item():.4f}', flush=True)
        r = ts[3:] or ts
        print(f'BENCH frames {a.frames} bs {a.bs} mean {np.mean(r):.3f} s/step over {len(r)} steps'
              + (f' peak VRAM {torch.cuda.max_memory_allocated() / 2**30:.2f} GiB' if dev.type == 'cuda' else ''))
        return
    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True); step, best = 0, float('inf')
    if a.resume:
        c = torch.load(out / 'last.pt', map_location=dev, weights_only=False)
        model.load_state_dict(c['model']); opt.load_state_dict(c['opt']); step, best = c['step'], c['best']
    ds = Batches(find_songs(a.data), a.bs, a.seed, **(dict(frames=[a.fixed_frames]) if a.fixed_frames else {}))
    dl = torch.utils.data.DataLoader(torch.utils.data.Subset(ds, [0] * (a.steps - step) if a.overfit else range(step, a.steps)), batch_size=None, num_workers=a.workers, prefetch_factor=2 if a.workers else None)
    win_losses = []; t0 = time.time()
    for mix, voc, T in dl:
        loss = step_loss(model, mix, voc, dev, amp)
        opt.zero_grad(set_to_none=True); loss.backward(); opt.step()
        step += 1; win_losses.append(loss.item())
        print(f'step {step} T {T} loss {win_losses[-1]:.6f} {time.time() - t0:.0f}s', flush=True)
        if step % a.save_every == 0 or step == a.steps:
            avg = float(np.mean(win_losses)); win_losses = []  # best = lowest mean train loss over the last save interval
            torch.save(dict(model=model.state_dict(), opt=opt.state_dict(), step=step, best=min(best, avg)), out / 'last.pt.tmp'); (out / 'last.pt.tmp').replace(out / 'last.pt')
            if avg < best: best = avg; torch.save(model.state_dict(), out / 'best.pt')
            print(f'saved step {step} interval-avg {avg:.6f} best {best:.6f}', flush=True)


if __name__ == '__main__':
    main()
