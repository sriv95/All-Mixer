"""App-faithful streaming vocal-SDR eval of a fine-tuned kara2 checkpoint vs untuned kara2, 49-song set (eval_set.json), paired 95% CI.
  .venv/bin/python -I spike/finetune/eval_kara2_ft.py --ckpt ft.pt [--frames 228,718] [--limit N] [--device cuda|mps|cpu] [--out res.json] [--root DIR]
Streaming = spike/duality/eval_short.py Stream framing (RoformerStream: chunk=(frames-1)*441, block/overlap from planRof(delay, 316.9 ms), [context|block|overlap],
cosine crossfade of the overlap tail), driven by the torch model (kara2_torch.vocals) instead of the ONNX core. Scoring = eval.py sdr(); silent clips skipped (eval.py l.92).
Geometry (bun spike/duality/plan.ts 316.9 <delay>; src/ml/rof-plan.ts planRof): 3 s -> 228 fr, block 90496, overlap 8832; 10 s -> 718 fr, block 306816, overlap 8832.
--ckpt: torch.save dict, key 'model' = state_dict (a bare state_dict also works). Omit --ckpt: untuned vs untuned (self-check, diff 0).
--root: audio root holding the song dirs (<root>/<song>/mixture.wav + vocals.wav); eval_set.json 'dir' is rewritten to <root>/<last path component>.
PASS BAR: 3 s: CI lower bound > 0 (beats untuned). 10 s: no loss = CI upper bound >= 0 (not significantly worse) AND mean diff >= -0.05 dB."""
import argparse, json, pathlib, sys, time
import numpy as np, soundfile as sf, torch

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import kara2_torch as kt

GEOM = {228: (90496, 8832), 718: (306816, 8832)}  # frames -> (block, overlap), from planRof(3 s / 10 s, 316.9)
HOP = kt.HOP


def sdr(ref, est): return 10 * np.log10((ref ** 2).sum() / (((ref - est) ** 2).sum() + 1e-12))


@torch.no_grad()
def stream(m, mix, frames, dev):  # mix [2, N] float32 -> vocals [2, N]; driver = eval_short.separate, chunk step = eval_short.Stream.process
    block, ov = GEOM[frames]; chunk = kt.frames_to_samples(frames); K = chunk - block; E = K - ov; N = mix.shape[1]
    ramp = 0.5 - 0.5 * np.cos(np.pi * (np.arange(ov) + 0.5) / ov)
    c = np.zeros((2, chunk), np.float32); tail = np.zeros((2, ov), np.float32); out = np.zeros((2, N), np.float32)
    for b in range(-(-(N + ov) // block)):
        blk = np.zeros((2, block), np.float32); seg = mix[:, b * block:min(N, (b + 1) * block)]; blk[:, :seg.shape[1]] = seg
        c[:, :K] = c[:, block:].copy(); c[:, K:] = blk
        v = kt.vocals(m, torch.from_numpy(c)[None].to(dev))[0].float().cpu().numpy()
        o = v[:, E:E + block].copy(); o[:, :ov] = tail * (1 - ramp) + o[:, :ov] * ramp; tail = v[:, E + block:E + block + ov]
        u0 = b * block - ov; lo, hi = max(0, u0), min(N, u0 + block); out[:, lo:hi] = o[:, lo - u0:hi - u0]
    return out


def clips(items, root):
    for it in items:
        d = pathlib.Path(root) / pathlib.Path(it['dir']).name if root else pathlib.Path(it['dir'])
        mix, sr = sf.read(d / 'mixture.wav', dtype='float32'); voc, _ = sf.read(d / 'vocals.wav', dtype='float32'); assert sr == 44100, d
        a0 = int(it['start'] * sr); a1 = a0 + int(it['dur'] * sr)
        yield it['name'], mix.T[:, a0:a1].copy(), voc.T[:, a0:a1].copy()


def ci(d):  # eval.py:76-78: 2000 resamples, seed 0, percentile
    rng = np.random.default_rng(0); bs = [rng.choice(d, len(d)).mean() for _ in range(2000)]
    return float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt'); ap.add_argument('--frames', default='228,718'); ap.add_argument('--limit', type=int)
    ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu')
    ap.add_argument('--out'); ap.add_argument('--ref', help='--out JSON of a reference ckpt run (same device): reuse its untuned SDRs, report ckpt-vs-ref paired diff + CI'); ap.add_argument('--root'); ap.add_argument('--set', default=str(HERE / 'eval_set.json'))
    a = ap.parse_args(); frames = [int(x) for x in a.frames.split(',')]; dev = a.device
    base = kt.load(dev).eval(); cand = base
    if a.ckpt:
        ck = torch.load(a.ckpt, map_location='cpu', weights_only=False); cand = kt.load(dev); cand.load_state_dict(ck.get('model', ck) if isinstance(ck, dict) else ck, strict=True); cand.eval()
    items = json.load(open(a.set)); per = {f: {} for f in frames}; sec = {f: [] for f in frames}; same = cand is base
    ref = json.load(open(a.ref))['per_song'] if a.ref else {}
    for i, (name, mix, voc) in enumerate(clips(items, a.root)):
        if a.limit and i >= a.limit: break
        if (voc ** 2).sum() < 1e-6: print('skip silent', name); continue
        for f in frames:
            t0 = time.time(); r0 = ref.get(str(f), {}).get(name); sb = r0['untuned'] if r0 else float(sdr(voc, stream(base, mix, f, dev))); t1 = time.time()
            sc = sb if same else float(sdr(voc, stream(cand, mix, f, dev))); t2 = time.time()
            per[f][name] = dict(untuned=sb, ckpt=sc)
            if r0: per[f][name]['vs_ref'] = sc - r0['ckpt']
            sec[f].append((t2 - t0) / (1 if same or r0 else 2))
            print(f'{name:44s} {f:4d}fr untuned {sb:8.4f} ckpt {sc:8.4f} diff {sc - sb:+.4f} ({sec[f][-1]:.1f}s/model)', flush=True)
    summ = {}
    for f in frames:
        r = per[f]; b = np.array([x['untuned'] for x in r.values()]); c = np.array([x['ckpt'] for x in r.values()]); d = c - b
        lo, hi = ci(d) if len(d) else (0, 0)
        summ[f] = dict(n=len(d), untuned_mean=float(b.mean()), ckpt_mean=float(c.mean()), diff=float(d.mean()), ci_lo=lo, ci_hi=hi, s_per_song_model=float(np.mean(sec[f])))
        if ref and all('vs_ref' in x for x in r.values()):
            dr = np.array([x['vs_ref'] for x in r.values()]); rl, rh = ci(dr); summ[f].update(vs_ref=float(dr.mean()), vs_ref_lo=rl, vs_ref_hi=rh)
            print(f'{f} frames vs ref ckpt diff {dr.mean():+.4f} 95%CI [{rl:+.4f}, {rh:+.4f}]')
        print(f'{f} frames n={len(d)} untuned {b.mean():.4f} ckpt {c.mean():.4f} diff {d.mean():+.4f} 95%CI [{lo:+.4f}, {hi:+.4f}]')
    ok3 = 228 in summ and summ[228]['ci_lo'] > 0; ok10 = 718 in summ and summ[718]['ci_hi'] >= 0 and summ[718]['diff'] >= -0.05
    if 228 in summ: print(f'PASS 3 s (CI lo > 0): {ok3}')
    if 718 in summ: print(f'PASS 10 s (no loss: CI hi >= 0 and mean diff >= -0.05): {ok10}')
    if a.out: json.dump(dict(ckpt=a.ckpt, summary=summ, per_song=per), open(a.out, 'w'), indent=1)
