"""App-faithful streaming vocal-SDR eval of Duality (base duality_v1 or a fine-tuned ckpt) at the 3 s plan, paired 95% bootstrap CI.
  .venv/bin/python -I spike/duality_ft/eval_duality.py [--ckpt ft.pt] [--limit N] [--sec S] [--device cuda|cpu] [--out res.json] [--ref ref.json] [--root DIR] [--set eval_set.json]
Geometry = planRof 3 s for Duality: 175 frames, chunk (175-1)*441 = 76734, block 67456, overlap 8832 (src/ml/rof-plan.ts framesFor; KNOWLEDGES: teacher_fp16_fixed 'app plan 175 frames, block 67456').
Streaming framing = spike/finetune/eval_kara2_ft.stream ([context|block|overlap], cosine crossfade of the overlap tail), driven by duality_torch (fp32).
No --ckpt: base only (prints base mean SDR). --ckpt: base vs ckpt paired diff + CI; PASS gate = CI lower bound > 0. --ref: --out JSON of an earlier run on the same device (reuses its base SDRs, adds ckpt-vs-ref).
--sec crops each clip to its first S seconds (default: full eval_set clip, 30 s). --root rewrites eval_set dirs to <root>/<song>."""
import argparse, json, pathlib, sys, time
import numpy as np, torch

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent / 'finetune'))
import duality_torch as dt
from eval_kara2_ft import clips, ci, sdr

HOP, FR, BLOCK, OV = 441, 175, 67456, 8832
CHUNK = (FR - 1) * HOP


def vocals(core, raw):  # raw [B,2,n] -> vocals [B,2,n]
    x, st = dt.core_features(core, raw)
    return dt.apply_masks(core, st, core(x))


@torch.no_grad()
def stream(core, mix, dev, amp=False):  # mix [2,N] float32 -> vocals [2,N]
    K = CHUNK - BLOCK; E = K - OV; N = mix.shape[1]
    ramp = 0.5 - 0.5 * np.cos(np.pi * (np.arange(OV) + 0.5) / OV)
    c = np.zeros((2, CHUNK), np.float32); tail = np.zeros((2, OV), np.float32); out = np.zeros((2, N), np.float32)
    for b in range(-(-(N + OV) // BLOCK)):
        blk = np.zeros((2, BLOCK), np.float32); seg = mix[:, b * BLOCK:min(N, (b + 1) * BLOCK)]; blk[:, :seg.shape[1]] = seg
        c[:, :K] = c[:, BLOCK:].copy(); c[:, K:] = blk
        with torch.autocast(dev.type, dtype=torch.bfloat16, enabled=amp):
            v = vocals(core, torch.from_numpy(c)[None].to(dev))[0].float().cpu().numpy()
        o = v[:, E:E + BLOCK].copy(); o[:, :OV] = tail * (1 - ramp) + o[:, :OV] * ramp; tail = v[:, E + BLOCK:E + BLOCK + OV]
        u0 = b * BLOCK - OV; lo, hi = max(0, u0), min(N, u0 + BLOCK); out[:, lo:hi] = o[:, lo - u0:hi - u0]
    return out


def load_ckpt(core, path):
    ck = torch.load(path, map_location='cpu', weights_only=False); core.load_state_dict(ck.get('model', ck), strict=True); return core.eval()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt'); ap.add_argument('--limit', type=int); ap.add_argument('--sec', type=float); ap.add_argument('--out'); ap.add_argument('--ref'); ap.add_argument('--root')
    ap.add_argument('--set', default=str(HERE.parent / 'finetune/eval_set.json')); ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    a = ap.parse_args(); dev = torch.device(a.device)
    base = dt.load(dev).eval(); cand = load_ckpt(dt.load(dev), a.ckpt) if a.ckpt else None
    ref = json.load(open(a.ref))['per_song'] if a.ref else {}
    items = json.load(open(a.set)); per = {}
    for i, (name, mix, voc) in enumerate(clips(items, a.root)):
        if a.limit and i >= a.limit: break
        if a.sec: mix, voc = mix[:, :int(a.sec * 44100)], voc[:, :int(a.sec * 44100)]
        if (voc ** 2).sum() < 1e-6: print('skip silent', name); continue
        t0 = time.time(); r0 = ref.get(name)
        sb = r0['base'] if r0 else float(sdr(voc, stream(base, mix, dev)))
        sc = float(sdr(voc, stream(cand, mix, dev))) if cand else sb
        per[name] = dict(base=sb, ckpt=sc, **({'vs_ref': sc - r0['ckpt']} if r0 else {}))
        print(f'{name:44s} base {sb:8.4f} ckpt {sc:8.4f} diff {sc - sb:+.4f} ({time.time() - t0:.1f}s)', flush=True)
    per = {k: v for k, v in per.items() if np.isfinite([v['base'], v['ckpt'], v.get('vs_ref', 0.)]).all()}  # bootstrap only over clips finite for ckpt and ref
    b = np.array([x['base'] for x in per.values()]); c = np.array([x['ckpt'] for x in per.values()]); d = c - b
    lo, hi = ci(d) if len(d) else (0, 0)
    summ = dict(n=len(d), base_mean=float(b.mean()), ckpt_mean=float(c.mean()), diff=float(d.mean()), ci_lo=lo, ci_hi=hi)
    print(f'base SDR mean {b.mean():.4f} (n={len(d)})')
    if cand: print(f'ckpt {c.mean():.4f} diff {d.mean():+.4f} 95%CI [{lo:+.4f}, {hi:+.4f}]  PASS (CI lo > 0): {lo > 0}')
    if ref and per and all('vs_ref' in x for x in per.values()):
        dr = np.array([x['vs_ref'] for x in per.values()]); rl, rh = ci(dr); summ.update(vs_ref=float(dr.mean()), vs_ref_lo=rl, vs_ref_hi=rh)
        print(f'vs ref ckpt diff {dr.mean():+.4f} 95%CI [{rl:+.4f}, {rh:+.4f}]')
    if a.out: json.dump(dict(device=str(dev), argv=sys.argv, ckpt=a.ckpt, summary=summ, per_song=per), open(a.out, 'w'), indent=1)
