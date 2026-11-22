"""Fine-tune the Default model (MDX-Net 9482, compat-mdx.onnx via mdx_torch) on teacher targets (+ real MUSDB vocals where present).
  python spike/finetune/train_mdx.py --onnx models/compat-mdx.onnx --teacher-dir TD --musdb MUSDB/train --eval-root MUSDB/test --out OUT
        [--bs 2 --lr 1e-5 --steps 60000 --max-hours H --eval-every 2000 --resume]
  python spike/finetune/train_mdx.py --selftest        (CPU, fake teacher from 2 MUSDB train songs)
Loss per sample = L(est, teacher) * tmask + 0.25 * L(est, real) * rmask, L = L1(wave) + multi-res STFT L1 (train_kara2_r2.per_sample_loss).
Model is applied on app-style frames: STFT n_fft 4096 hop 1024 no centre, T random per batch from 64..256 step 32 (src/ml/mdx-plan.ts),
iSTFT / sum(w^2) as in mdx_torch.separate, so the loss is on waveforms. BatchNorm frozen. Cosine LR to 0 over --steps, no warmup.
Files in --out: last.pt (model, opt, step, best_sdr; every --save-every), snap_<step>.pt (every --snap-every), best_sdr.pt (state dicts of trainable params).
Checkpoint pick = mean vocal SDR of mdx_torch.separate (T=--eval-frames) on --eval-clips MUSDB test clips (10 s) every --eval-every steps, not val loss."""
import argparse, math, pathlib, sys, tempfile, time
import numpy as np, soundfile as sf, torch

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import mdx_torch as mt
from teacher_data import TeacherCrops
from train_kara2_r2 import per_sample_loss, distill_loss

SR, EXTRA = 44100, mt.NFFT // mt.HOP  # a crop of T+EXTRA hop-frames holds exactly the (T-1)*HOP+NFFT samples of T STFT frames
EDGE = 1024  # forward() divides by the squared-Hann envelope, which is ~0 at crop edges, so edges blow up: keep them out of the loss
FRAMES = [64, 96, 128, 160, 192, 224, 256]
MUSDB_REPO = pathlib.Path('/Users/sriv/Space/Repos/All-Mixer/.cache/musdb18hq')


def forward(model, mix, T):  # mix [B,2,N] -> est [B,2,N] differentiable, same maths as mt.separate
    dev = mix.device; win = mt.WIN.float().to(dev); B = mix.shape[0]; N = mix.shape[-1]; assert N == (T - 1) * mt.HOP + mt.NFFT
    s = torch.fft.rfft(mix.unfold(-1, mt.NFFT, mt.HOP) * win, dim=-1)[..., :mt.BINS].permute(0, 1, 3, 2)  # [B,2,BINS,T]
    y = model(torch.stack([s[:, 0].real, s[:, 0].imag, s[:, 1].real, s[:, 1].imag], 1)) * mt.COMP
    c = torch.complex(y[:, 0::2], y[:, 1::2])  # [B,2,BINS,T]
    c = torch.nn.functional.pad(c, (0, 0, 0, 1))  # bin 2048 = 0, as in separate
    w = torch.fft.irfft(c.permute(0, 1, 3, 2), n=mt.NFFT, dim=-1) * win  # [B,2,T,NFFT]
    acc = torch.nn.functional.fold(w.reshape(B * 2, T, mt.NFFT).transpose(1, 2), (1, N), (1, mt.NFFT), stride=(1, mt.HOP)).reshape(B, 2, N)
    env = torch.zeros(N, device=dev)
    for t in range(T): env[t * mt.HOP:t * mt.HOP + mt.NFFT] += win ** 2
    return acc / torch.where(env > 1e-10, env, torch.ones_like(env))


def train_step(model, batch, dev, opt=None):
    mix, tea, real, tm, rm, Tc = batch; T = Tc - EXTRA
    est = forward(model, mix.to(dev), T)
    loss = distill_loss(est[..., EDGE:-EDGE], tea.to(dev)[..., EDGE:-EDGE], real.to(dev)[..., EDGE:-EDGE], tm.to(dev), rm.to(dev))
    if opt: opt.zero_grad(set_to_none=True); loss.backward(); opt.step()
    return loss


def sdr(ref, est): return 10 * np.log10((ref ** 2).sum() / (((ref - est) ** 2).sum() + 1e-12))


def load_eval(root, n):  # 10 s clips from MUSDB test, 30 s in
    out = []
    for d in sorted(pathlib.Path(root).iterdir())[:n]:
        r = lambda f: sf.read(d / f, start=30 * SR, frames=10 * SR, dtype='float32')[0].T.copy()
        out.append((r('mixture.wav'), r('vocals.wav')))
    return out


def eval_sdr(model, clips, frames, dev):
    model.eval(); f = lambda x: model(x.to(dev)).cpu()
    s = [float(sdr(v, mt.separate(f, m, T))) for m, v in clips for T in frames]
    model.train(); return float(np.mean(s))


def train(a):
    dev = torch.device(('cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu') if a.device == 'auto' else a.device)
    model = mt.load(a.onnx).to(dev)
    if a.init: model.load_state_dict(torch.load(a.init, map_location=dev, weights_only=False), strict=False)
    model.train(); opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=a.lr)
    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True); step, best = 0, -float('inf')
    if a.resume:
        c = torch.load(out / 'last.pt', map_location=dev, weights_only=False)
        model.load_state_dict(c['model']); opt.load_state_dict(c['opt']); step, best = c['step'], c['best_sdr']
    ds = TeacherCrops(a.teacher_dir, a.musdb, a.bs, [f + EXTRA for f in FRAMES], mt.HOP, mt.NFFT, a.seed)
    dl = torch.utils.data.DataLoader(torch.utils.data.Subset(ds, range(step, a.steps)), batch_size=None, num_workers=a.workers, prefetch_factor=2 if a.workers else None)
    ef = [int(x) for x in a.eval_frames.split(',')]; clips = load_eval(a.eval_root, a.eval_clips) if a.eval_every else []
    print(f'device {dev} bs {a.bs} lr {a.lr} items {len(ds.items)} step {step}', flush=True); t0 = time.time()
    for batch in dl:
        for g in opt.param_groups: g['lr'] = a.lr * 0.5 * (1 + math.cos(math.pi * step / a.steps))
        loss = train_step(model, batch, dev, opt); step += 1
        assert torch.isfinite(loss), f'non-finite loss at step {step}'
        print(f'step {step} T {batch[5] - EXTRA} loss {loss.item():.6f} {time.time() - t0:.0f}s', flush=True)
        stop = a.max_hours and time.time() - t0 > a.max_hours * 3600
        if a.eval_every and (step % a.eval_every == 0 or step == a.steps or stop):
            s = eval_sdr(model, clips, ef, dev); print(f'eval step {step} sdr {s:.4f} best {max(best, s):.4f}', flush=True)
            if s > best: best = s; mt.save(model, out / 'best_sdr.pt')
        if step % a.save_every == 0 or step == a.steps or stop:
            torch.save(dict(model=model.state_dict(), opt=opt.state_dict(), step=step, best_sdr=best), out / 'last.pt.tmp'); (out / 'last.pt.tmp').replace(out / 'last.pt')
        if step % a.snap_every == 0: mt.save(model, out / f'snap_{step}.pt')
        if stop: print('max-hours reached'); break
    return step


def parser():
    a = argparse.ArgumentParser()
    a.add_argument('--onnx', default=str(mt.SRC)); a.add_argument('--teacher-dir'); a.add_argument('--musdb', help='MUSDB18-HQ train dir')
    a.add_argument('--eval-root', default=str(MUSDB_REPO / 'test'), help='MUSDB18-HQ test dir'); a.add_argument('--out', default=str(mt.ROOT / '.cache/finetune/mdx'))
    a.add_argument('--init', help='trainable-params state dict (best_sdr.pt/snap) to start from')
    a.add_argument('--steps', type=int, default=60000); a.add_argument('--bs', type=int, default=2); a.add_argument('--lr', type=float, default=1e-5)
    a.add_argument('--max-hours', type=float, default=0); a.add_argument('--save-every', type=int, default=500); a.add_argument('--snap-every', type=int, default=5000)
    a.add_argument('--eval-every', type=int, default=0); a.add_argument('--eval-clips', type=int, default=10); a.add_argument('--eval-frames', default='128')
    a.add_argument('--workers', type=int, default=2); a.add_argument('--seed', type=int, default=0)
    a.add_argument('--device', default='auto'); a.add_argument('--resume', action='store_true'); a.add_argument('--selftest', action='store_true')
    return a


def selftest():  # CPU only
    songs = sorted(p for p in (MUSDB_REPO / 'train').iterdir() if (p / 'vocals.wav').exists())[:2]
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d); tgt = d / 'teacher'; rows = []
        for p in songs:  # 20 s crops, real vocals as fake teacher
            (tgt / p.name).mkdir(parents=True)
            for f, o in (('mixture', 'mixture.flac'), ('vocals', 'vocals_teacher.flac')):
                x, _ = sf.read(p / f'{f}.wav', start=SR * 30, frames=SR * 20, dtype='float32'); sf.write(tgt / p.name / o, x, SR)
            rows.append(f'{p.name}\t20.0\t{p / "mixture.wav"}')
        (tgt / 'targets.tsv').write_text('id\tseconds\tsrc_path\n' + '\n'.join(rows) + '\n')
        base = ['--teacher-dir', str(tgt), '--musdb', str(MUSDB_REPO / 'train'), '--out', str(d / 'out'), '--device', 'cpu', '--bs', '1', '--workers', '0',
                '--save-every', '3', '--eval-every', '5', '--eval-clips', '1', '--eval-frames', '64']
        m = mt.load(); x = torch.randn(1, 2, (64 - 1) * mt.HOP + mt.NFFT) * 0.1  # differentiable forward == separate-style path
        assert torch.isfinite(forward(m, x, 64)).all()
        mx, vc = load_eval(MUSDB_REPO / 'test', 1)[0]; n = x.shape[-1]  # base model must separate vocals on the interior (edge bug gave -54 dB)
        with torch.no_grad(): e = forward(m.eval(), torch.from_numpy(mx[None, :, :n]), 64)[0].numpy()
        b = float(sdr(vc[:, :n][:, EDGE:-EDGE], e[:, EDGE:-EDGE])); print(f'base forward interior SDR {b:.2f} dB'); assert b > 8, b; m.train()
        assert train(parser().parse_args(base + ['--steps', '3'])) == 3
        assert train(parser().parse_args(base + ['--steps', '5', '--resume'])) == 5
        assert (d / 'out/best_sdr.pt').exists() and torch.load(d / 'out/last.pt', weights_only=False)['step'] == 5
        model = mt.load().train(); opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=1e-5)
        for T in (64, 256):
            dd = TeacherCrops(tgt, None, 1, [T + EXTRA], mt.HOP, mt.NFFT, 1); ts = []
            for i in range(3):
                t = time.time(); train_step(model, dd[i], torch.device('cpu'), opt); ts.append(time.time() - t)
            print(f'CPU bs 1 T {T}: {np.mean(ts[1:]):.2f} s/step')
    print('selftest ok')


if __name__ == '__main__':
    a = parser().parse_args()
    selftest() if a.selftest else train(a)
