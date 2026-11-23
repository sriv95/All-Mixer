"""usage: .venv/bin/python spike/finetune/eval_mdx_ckpt.py [base|CKPT.pt ...] [--ref base|CKPT.pt] [--frames 128] [--clips 5] [--device cpu] [--out res.json]   (run from worktree root)
last.pt (dict with 'model') or snap/best state dict; 'base' = models-out/compat-mdx.onnx weights (the old bundled 9482). No args = base.
Prints mean vocal SDR on MUSDB test clips (10 s, 30 s in, silent skipped) at T frames (default 128 = 127*1024 samples = 2.95 s of output at 44.1 kHz, hop 1024, ~3 s)
and the paired bootstrap 95% CI of the per-clip SDR diff vs --ref (default base; eval_kara2_ft.py ci(): 2000 resamples, seed 0).
SHIP GATE (Default retrain): beats old bundled 9482 at 3 s = CI lower bound > 0. --clips 50 = full MUSDB test (default 5 is a weak CI)."""
import argparse, json, sys, pathlib, torch
import numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import train_mdx as tm, mdx_torch as mt


def ci(d):  # same as eval_kara2_ft.py ci(): 2000 resamples, seed 0, percentile
    rng = np.random.default_rng(0); bs = [rng.choice(d, len(d)).mean() for _ in range(2000)]
    return float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))


def model(p, dev):
    m = mt.load()
    if p != 'base':
        c = torch.load(p, map_location='cpu', weights_only=False); m.load_state_dict(c.get('model', c), strict=False)
    return m.to(dev)


def per_clip(m, clips, T, dev):  # per-clip vocal SDR, silent clips (eval_kara2_ft.py) -> nan
    m.eval(); f = lambda x: m(x.to(dev)).cpu()
    with torch.no_grad():
        return np.array([float(tm.sdr(v, mt.separate(f, x, T))) if (v ** 2).sum() >= 1e-6 else np.nan for x, v in clips])


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('ckpts', nargs='*', default=['base']); ap.add_argument('--ref', default='base'); ap.add_argument('--frames', type=int, default=128)
    ap.add_argument('--clips', type=int, default=5); ap.add_argument('--device', default='cpu'); ap.add_argument('--out')
    a = ap.parse_args(); clips = tm.load_eval(tm.MUSDB_REPO / 'test', a.clips)
    r = per_clip(model(a.ref, a.device), clips, a.frames, a.device); keep = ~np.isnan(r); res = dict(device=a.device, argv=sys.argv, frames=a.frames, ref=a.ref, ref_mean=float(r[keep].mean()), n=int(keep.sum()), ckpts={})
    print(f'ref {a.ref} n={keep.sum()} T={a.frames} mean {r[keep].mean():.3f}', flush=True)
    for p in a.ckpts:
        s = r if p == a.ref else per_clip(model(p, a.device), clips, a.frames, a.device); d = (s - r)[keep]; lo, hi = ci(d)
        res['ckpts'][p] = dict(mean=float(s[keep].mean()), diff=float(d.mean()), ci_lo=lo, ci_hi=hi, per_clip=s.tolist())
        print(f'{p} {s[keep].mean():.3f} diff {d.mean():+.3f} 95%CI [{lo:+.3f}, {hi:+.3f}] beats ref: {lo > 0}', flush=True)
    if a.out: json.dump(res, open(a.out, 'w'), indent=1)
