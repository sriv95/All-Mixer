"""kara2 round 2: fine-tune the vocals path on teacher targets (+ real MUSDB stems where present). New file; reuses train_kara2 (freeze, STFT constants).
  python spike/finetune/train_kara2_r2.py --teacher-dir D --musdb /.../musdb18hq/train --out .cache/finetune/k2r2 [--bs 2 --lr 1e-5 --steps 60000 --max-hours 8 --resume]
  python spike/finetune/train_kara2_r2.py --selftest
Loss per sample = L(est, teacher) * tmask + 0.25 * L(est, real) * rmask, batch mean; L = L1(wave) + sum_w L1(complex STFT) (train_kara2.loss_fn recipe).
Frames per batch: uniform integer 228..718 (app kara2 range). Cosine LR to 0 over --steps (no warmup); --max-hours stops early.
Files: last.pt (model, opt, step, best_sdr; every --save-every), snap_<step>.pt (state_dict, every --snap-every), best_sdr.pt (state_dict).
Checkpoint pick = streaming vocal SDR (eval_kara2_ft.stream) on --eval-clips MUSDB test clips from eval_set.json every --eval-every steps; not val loss.
Eval needs the MUSDB test dir at the path stored in eval_set.json (or --eval-root)."""
import argparse, gc, json, math, pathlib, sys, tempfile, time
import numpy as np, soundfile as sf, torch
import torch.nn.functional as F

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import kara2_torch as kt
import eval_kara2_ft as ev
from train_kara2 import WINS, STFT_HOP, NFFT
from teacher_data import TeacherCrops

SR = 44100


def per_sample_loss(est, tgt):  # [B,2,n] -> [B]; same terms as train_kara2.loss_fn, mean per sample
    B = est.shape[0]; loss = (est - tgt).abs().reshape(B, -1).mean(1)
    e, t = est.reshape(-1, est.shape[-1]), tgt.reshape(-1, tgt.shape[-1])
    for w in WINS:
        kw = dict(n_fft=max(w, NFFT), win_length=w, hop_length=STFT_HOP, window=torch.hann_window(w, device=est.device), return_complex=True)
        loss = loss + (torch.stft(e, **kw) - torch.stft(t, **kw)).abs().reshape(B, -1).mean(1)
    return loss


def distill_loss(est, teacher, real, tm, rm, w_real=0.25):
    return (per_sample_loss(est, teacher) * tm + w_real * per_sample_loss(est, real) * rm).mean()


def train_step(model, batch, dev, opt=None):
    mix, tea, real, tm, rm, T = batch
    est = (model.separate(mix.to(dev), masks_dtype=torch.bfloat16)['vocals'] if dev.type == 'cuda' and torch.cuda.is_bf16_supported() else kt.vocals(model, mix.to(dev))).float()  # same as train_kara2.step_loss
    loss = distill_loss(est, tea.to(dev), real.to(dev), tm.to(dev), rm.to(dev))
    if opt: opt.zero_grad(set_to_none=True); loss.backward(); opt.step()
    return loss


def sync(dev):
    if dev.type == 'mps': torch.mps.synchronize()
    elif dev.type == 'cuda': torch.cuda.synchronize()


def eval_sdr(model, items, frames, dev):  # mean streaming vocal SDR over clips and frame counts
    model.eval(); s = []
    for _, mix, voc in items:
        if (voc ** 2).sum() < 1e-6: continue
        s += [float(ev.sdr(voc, ev.stream(model, mix, f, dev))) for f in frames]
    model.train(); return float(np.mean(s))


def selftest(device='cpu'):  # CPU only by default: the 116M model OOMs on the 8 GB Mac MPS
    dev = torch.device(device)
    musdb = ROOT_MUSDB / 'train'; songs = sorted(p for p in musdb.iterdir() if (p / 'vocals.wav').exists())[:2]
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d); mus = d / 'musdb'; tgt = d / 'teacher'; rows = []
        for p in songs:  # 20 s crops: mixture + real vocals as fake teacher; song 0 also in MUSDB (merge path), song 1 teacher-only
            (tgt / p.name).mkdir(parents=True); mus.mkdir(exist_ok=True)
            for f in ('mixture', 'vocals'):
                x, _ = sf.read(p / f'{f}.wav', start=SR * 30, frames=SR * 20, dtype='float32')
                sf.write(tgt / p.name / ('mixture.flac' if f == 'mixture' else 'vocals_teacher.flac'), x, SR)
                if p == songs[0]: (mus / p.name).mkdir(exist_ok=True); sf.write(mus / p.name / f'{f}.wav', x, SR)
            rows.append(f'{p.name}\t20.0\t{p / "mixture.wav"}')
        (tgt / 'targets.tsv').write_text('id\tseconds\tsrc_path\n' + '\n'.join(rows) + '\n')
        # a third MUSDB-only song (no teacher)
        p = songs[0]; (mus / 'solo').mkdir(); [sf.write(mus / 'solo' / f'{f}.wav', sf.read(mus / p.name / f'{f}.wav')[0], SR) for f in ('mixture', 'vocals')]
        ds = TeacherCrops(tgt, mus, bs=1, frames=(228,), seed=3)
        assert len(ds.items) == 3 and sorted((i['teacher'] is not None, i['real'] is not None) for i in ds.items) == [(False, True), (True, False), (True, True)]
        b = ds[0]; assert b[0].shape == b[1].shape == b[2].shape == (1, 2, kt.frames_to_samples(b[5])) and b[5] == 228
        model = kt.load(dev); kt.freeze(model); model.train()
        opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=1e-5)
        ts = []
        for i in range(3):
            sync(dev); t = time.time(); l = train_step(model, ds[i], dev, opt); sync(dev); ts.append(time.time() - t); assert torch.isfinite(l), l
            print(f'step {i + 1} T {ds[i][5]} loss {l.item():.4f} {ts[-1]:.1f}s', flush=True)
        print(f'{dev} bs 1 frames 228: {np.mean(ts):.2f} s/step (incl. first)')
        del model, opt; import subprocess; gc.collect()
        cmd = [sys.executable, __file__, '--teacher-dir', str(tgt), '--musdb', str(mus), '--out', str(d / 'run'), '--bs', '1', '--workers', '0',
               '--save-every', '3', '--eval-every', '3', '--eval-clips', '1', '--eval-frames', '228', '--frames', '228,228', '--device', device]
        o1 = subprocess.run(cmd + ['--steps', '3'], capture_output=True, text=True); print(o1.stdout[-600:], o1.stderr[-600:]); assert o1.returncode == 0
        assert 'eval step 3 sdr' in o1.stdout and (d / 'run/best_sdr.pt').exists() and (d / 'run/last.pt').exists()
        o2 = subprocess.run(cmd + ['--steps', '4', '--resume'], capture_output=True, text=True); print(o2.stdout[-600:], o2.stderr[-600:]); assert o2.returncode == 0
        assert 'step 3\n' in o2.stdout.split('items')[1].split('\n')[0] + '\n' and 'step 4 ' in o2.stdout and 'step 1 ' not in o2.stdout
        print('eval + save + resume ok')
    print('selftest ok')


ROOT_MUSDB = next((p for p in (kt.ROOT / '.cache/musdb18hq', *([kt.ROOT.parents[2] / 'Repos/All-Mixer/.cache/musdb18hq'] if len(kt.ROOT.parents) > 2 else [])) if p.exists()), None)  # worktree has no .cache


def main():
    a = argparse.ArgumentParser()
    a.add_argument('--teacher-dir'); a.add_argument('--musdb'); a.add_argument('--out', default=str(kt.ROOT / '.cache/finetune/k2r2'))
    a.add_argument('--init', help='start from this state_dict/ckpt instead of stock kara2')
    a.add_argument('--steps', type=int, default=60000); a.add_argument('--bs', type=int, default=2); a.add_argument('--lr', type=float, default=1e-5)
    a.add_argument('--max-hours', type=float, default=0); a.add_argument('--save-every', type=int, default=500); a.add_argument('--snap-every', type=int, default=5000)
    a.add_argument('--eval-every', type=int, default=0); a.add_argument('--eval-clips', type=int, default=10); a.add_argument('--eval-frames', default='228,718')
    a.add_argument('--frames', default='228,718', help='lo,hi random frame range'); a.add_argument('--eval-root'); a.add_argument('--workers', type=int, default=2); a.add_argument('--seed', type=int, default=0)
    a.add_argument('--device', default='auto'); a.add_argument('--resume', action='store_true'); a.add_argument('--selftest', action='store_true')
    a = a.parse_args()
    if a.selftest: return selftest('cpu' if a.device == 'auto' else a.device)
    dev = torch.device(('cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu') if a.device == 'auto' else a.device)
    model = kt.load(dev)
    if a.init: ck = torch.load(a.init, map_location=dev, weights_only=False); model.load_state_dict(ck.get('model', ck))
    kt.freeze(model); model.train()
    params = [p for p in model.parameters() if p.requires_grad]; opt = torch.optim.AdamW(params, lr=a.lr)
    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True); step, best = 0, -float('inf')
    if a.resume:
        c = torch.load(out / 'last.pt', map_location=dev, weights_only=False)
        model.load_state_dict(c['model']); opt.load_state_dict(c['opt']); step, best = c['step'], c['best_sdr']
    ds = TeacherCrops(a.teacher_dir, a.musdb, a.bs, tuple(int(x) for x in a.frames.split(',')), kt.HOP, kt.NFFT, a.seed)
    dl = torch.utils.data.DataLoader(torch.utils.data.Subset(ds, range(step, a.steps)), batch_size=None, num_workers=a.workers, prefetch_factor=2 if a.workers else None)
    ef = [int(x) for x in a.eval_frames.split(',')]
    items = list(ev.clips(json.load(open(HERE / 'eval_set.json'))[:a.eval_clips], a.eval_root)) if a.eval_every else []
    print(f'device {dev} bs {a.bs} lr {a.lr} items {len(ds.items)} step {step}', flush=True); t0 = time.time()
    for batch in dl:
        for g in opt.param_groups: g['lr'] = a.lr * 0.5 * (1 + math.cos(math.pi * step / a.steps))
        loss = train_step(model, batch, dev, opt); step += 1
        print(f'step {step} T {batch[5]} loss {loss.item():.6f} {time.time() - t0:.0f}s', flush=True)
        stop = a.max_hours and time.time() - t0 > a.max_hours * 3600
        if a.eval_every and (step % a.eval_every == 0 or step == a.steps or stop):
            s = eval_sdr(model, items, ef, dev); print(f'eval step {step} sdr {s:.4f} best {max(best, s):.4f}', flush=True)
            if s > best: best = s; torch.save(model.state_dict(), out / 'best_sdr.pt')
        if step % a.save_every == 0 or step == a.steps or stop:
            torch.save(dict(model=model.state_dict(), opt=opt.state_dict(), step=step, best_sdr=best), out / 'last.pt.tmp'); (out / 'last.pt.tmp').replace(out / 'last.pt')
        if step % a.snap_every == 0: torch.save(model.state_dict(), out / f'snap_{step}.pt')
        if stop: print('max-hours reached'); break
    if dev.type == 'cuda': print(f'peak_alloc_GiB {torch.cuda.max_memory_allocated() / 2**30:.3f}', flush=True)


if __name__ == '__main__':
    main()
