"""Duality fine-tune on 3 s (175-frame) crops: teacher distill + 0.25x real vocals (kara2 r2 recipe), init duality_v1, no architecture change.
  python spike/duality_ft/train_duality.py --teacher-dir D --musdb /.../musdb18hq/train --out .cache/finetune/dual [--init ckpt] [--bs 1 --accum 4 --lr 1e-5 --steps 0 --max-hours 4.5 --snap-min 15 --resume]
  python spike/duality_ft/train_duality.py --selftest [--device cpu]
Loss per sample = train_kara2_r2.distill_loss (L1 wave + multi-res complex STFT L1; teacher + 0.25 real, masked by availability). Crops: 175 frames = 76734 samples, +-6 dB gain and channel swap from teacher_data.TeacherCrops.
8 GB fit (RTX 3060 Ti): fp32 master weights + torch fused AdamW (228M params: ~3.7 GB weights+grads+states), bf16 autocast on the transformer core, STFT/iSTFT/loss fp32; --grad-ckpt checkpoints every time/freq transformer.
Cosine LR to 0 over --steps (optimizer steps, each = --accum micro-batches of --bs), no warmup (as r2). Default --steps 0: cosine over elapsed/--max-hours (default 4.5 h, a hard window with unknown step rate), stops at max-hours.
With --steps N, --max-hours stops early. Resume keeps the elapsed time (last.pt 'elapsed').
Snapshots every --snap-min minutes of wall time (and every --snap-every steps if > 0): snap_<step>.pt (Core state_dict), last.pt (model+opt+step+best), then in-training streaming SDR
(eval_duality.stream, 3 s plan) on --eval-clips eval_set clips cut to --eval-sec s; best_sdr.pt = best by SDR, not loss. Eval clips need the MUSDB test dir (eval_set.json paths or --eval-root).
Peak CUDA memory is printed at every snapshot and at the end."""
import argparse, os, functools, json, math, pathlib, sys, tempfile, time
import numpy as np, soundfile as sf, torch
from torch.utils.checkpoint import checkpoint

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent / 'finetune'))
import duality_torch as dt
import eval_duality as ed
from train_kara2_r2 import distill_loss, ROOT_MUSDB
from teacher_data import TeacherCrops

SR = 44100


def train_step(core, batch, dev, accum, amp):
    mix, tea, real, tm, rm, T = batch
    mix = mix.to(dev); x, st = dt.core_features(core, mix)
    with torch.autocast(dev.type, dtype=torch.bfloat16, enabled=amp): masks = core(x)
    est = dt.apply_masks(core, st, masks.float())
    loss = distill_loss(est, tea.to(dev), real.to(dev), tm.to(dev), rm.to(dev))
    (loss / accum).backward()
    return loss.detach()


def finite_mean(s):  # -inf/NaN clips must not poison the mean; no finite clip -> -inf
    s = [x for x in s if np.isfinite(x)]; return float(np.mean(s)) if s else float('-inf')


assert finite_mean([1., float('-inf'), float('nan'), 3.]) == 2. and finite_mean([float('nan')]) == float('-inf')


def eval_sdr(core, items, dev, amp):
    core.eval(); s = [float(ed.sdr(v, ed.stream(core, m, dev, amp))) for _, m, v in items if (v ** 2).sum() >= 1e-6]; core.train(); return finite_mean(s)


def run(a):
    dev = torch.device(('cuda' if torch.cuda.is_available() else 'cpu') if a.device == 'auto' else a.device); amp = dev.type == 'cuda' or os.environ.get('DUALITY_AMP') == '1'  # env: force bf16 autocast on CPU for selftests
    torch.manual_seed(a.seed)
    core = dt.load(dev)
    if a.init: ed.load_ckpt(core, a.init)
    if a.grad_ckpt:
        for tt, ft in core.m.layers:
            for mod in (tt, ft): mod.forward = functools.partial(checkpoint, mod.forward, use_reentrant=False)
    core.train(); opt = torch.optim.AdamW(core.parameters(), lr=a.lr, fused=dev.type == 'cuda')
    out = pathlib.Path(a.out or dt.ROOT / '.cache/finetune/dual'); out.mkdir(parents=True, exist_ok=True); step, best, el0 = 0, -float('inf'), 0
    if a.resume:
        c = torch.load(out / 'last.pt', map_location=dev, weights_only=False); core.load_state_dict(c['model']); opt.load_state_dict(c['opt']); step, best, el0 = c['step'], c['best_sdr'], c.get('elapsed', 0)
    ds = TeacherCrops(a.teacher_dir, a.musdb, a.bs, (ed.FR, ed.FR), ed.HOP, 2048, a.seed)
    dl = torch.utils.data.DataLoader(torch.utils.data.Subset(ds, range(step * a.accum, (a.steps or 1 << 28) * a.accum)), batch_size=None, num_workers=a.workers, prefetch_factor=2 if a.workers else None)
    items = []
    if a.eval_clips:
        for n, m, v in ed.clips(json.load(open(a.eval_set))[:a.eval_clips], a.eval_root): items.append((n, m[:, :int(a.eval_sec * SR)], v[:, :int(a.eval_sec * SR)]))
    print(f'device {dev} amp {amp} bs {a.bs} accum {a.accum} lr {a.lr} items {len(ds.items)} step {step} argv {sys.argv}', flush=True)
    if items and not a.resume: print(f'eval step {step} sdr {eval_sdr(core, items, dev, amp):.4f} (start weights)', flush=True)
    t0 = last_snap = time.time() - el0; it = iter(dl); T = a.max_hours * 3600  # t0 is shifted by the elapsed time of a resumed run

    def snapshot(why):
        nonlocal best, last_snap
        torch.save(core.state_dict(), out / f'snap_{step}.pt')
        torch.save(dict(model=core.state_dict(), opt=opt.state_dict(), step=step, best_sdr=best, elapsed=time.time() - t0), out / 'last.pt.tmp'); (out / 'last.pt.tmp').replace(out / 'last.pt')
        if items:
            s = eval_sdr(core, items, dev, amp); print(f'eval step {step} sdr {s:.4f} best {max(best, s):.4f} ({why})', flush=True)
            if s > best: best = s; torch.save(core.state_dict(), out / 'best_sdr.pt')
        if dev.type == 'cuda': print(f'peak_alloc_GiB {torch.cuda.max_memory_allocated() / 2**30:.3f}', flush=True)
        last_snap = time.time()

    while not a.steps or step < a.steps:
        frac = step / a.steps if a.steps else min(1.0, (time.time() - t0) / T)  # --steps 0: cosine over elapsed / max-hours
        for g in opt.param_groups: g['lr'] = a.lr * 0.5 * (1 + math.cos(math.pi * frac))
        ls = [train_step(core, next(it), dev, a.accum, amp).item() for _ in range(a.accum)]
        torch.nn.utils.clip_grad_norm_(core.parameters(), 1.0); opt.step(); opt.zero_grad(set_to_none=True); step += 1
        l = float(np.mean(ls)); assert math.isfinite(l), l
        print(f'step {step} loss {l:.6f} {time.time() - t0:.0f}s', flush=True)
        stop = bool(a.max_hours) and time.time() - t0 > a.max_hours * 3600
        if step == a.steps or stop or (a.snap_min and time.time() - last_snap > a.snap_min * 60) or (a.snap_every and step % a.snap_every == 0): snapshot('final' if step == a.steps or stop else 'snap')
        if stop: print('max-hours reached'); break
    if dev.type == 'cuda': print(f'peak_alloc_GiB {torch.cuda.max_memory_allocated() / 2**30:.3f}', flush=True)


def selftest(a):  # stand-in teacher = real MUSDB vocals (20 s crops of 2 train songs); song 0 also in the MUSDB dir (merge path)
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d); mus, tgt, rows = d / 'musdb', d / 'teacher', []
        songs = sorted(p for p in (ROOT_MUSDB / 'train').iterdir() if (p / 'vocals.wav').exists())[:2]
        for p in songs:
            (tgt / p.name).mkdir(parents=True); (mus / p.name).mkdir(parents=True, exist_ok=True)
            for f in ('mixture', 'vocals'):
                x, _ = sf.read(p / f'{f}.wav', start=SR * 30, frames=SR * 20, dtype='float32')
                sf.write(tgt / p.name / ('mixture.flac' if f == 'mixture' else 'vocals_teacher.flac'), x, SR)
                if p == songs[0]: sf.write(mus / p.name / f'{f}.wav', x, SR)
            rows.append(f'{p.name}\t20.0\t{p / "mixture.wav"}')
        (tgt / 'targets.tsv').write_text('id\tseconds\tsrc_path\n' + '\n'.join(rows) + '\n')
        a.teacher_dir, a.musdb, a.out = str(tgt), str(mus), a.out or str(d / 'run')
        run(a)
        assert (pathlib.Path(a.out) / 'last.pt').exists() and (pathlib.Path(a.out) / 'best_sdr.pt').exists(); print('selftest ok', a.out)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--teacher-dir'); p.add_argument('--musdb'); p.add_argument('--out'); p.add_argument('--init')
    p.add_argument('--steps', type=int, default=0); p.add_argument('--bs', type=int, default=1); p.add_argument('--accum', type=int, default=4); p.add_argument('--lr', type=float, default=1e-5)
    p.add_argument('--max-hours', type=float, default=None); p.add_argument('--snap-min', type=float, default=15); p.add_argument('--snap-every', type=int, default=0)
    p.add_argument('--eval-clips', type=int, default=4); p.add_argument('--eval-sec', type=float, default=12); p.add_argument('--eval-root'); p.add_argument('--eval-set', default=str(HERE.parent / 'finetune/eval_set.json'))
    p.add_argument('--grad-ckpt', action='store_true'); p.add_argument('--workers', type=int, default=2); p.add_argument('--seed', type=int, default=0)
    p.add_argument('--device', default='auto'); p.add_argument('--resume', action='store_true'); p.add_argument('--selftest', action='store_true')
    a = p.parse_args()
    if a.max_hours is None: a.max_hours = 0 if a.selftest else 4.5
    assert a.steps or a.max_hours, '--steps 0 needs --max-hours > 0'
    if a.selftest: a.steps, a.accum, a.workers, a.snap_min, a.snap_every, a.eval_clips, a.eval_sec, a.max_hours, a.device = a.steps or (0 if a.max_hours else 4), 1, 0, 0, 2, 1, 6, a.max_hours, 'cpu' if a.device == 'auto' else a.device; selftest(a)
    else: run(a)
