"""SRI-244 phase A / SRI-245: measure the Karaoke instrumental dip while someone sings, and prototype compensation (offline).
Baseline = shipped combine incl. G2 dip fill (sri220_gate.py Clip.stems with the G2 gate): inst = (X - Vz) * (1 - 0.8 ms^2 [f>=150]).
Variants only change the instrumental gain per bin (Vz / A cappella stays bit-identical), using x, V_mdx and masks of frame t only
(no look-ahead beyond the G2 gate that the baseline already has):
  R<tag>_c<c>  : R_k = running |D_k| per bin and channel, updated only where m < 0.2 (R += a (|D| - R), a_up / a_dn from tau_up / tau_dn);
                 gain = cur + m^2 * max(0, min(1, c R / |D|) - cur), cur = 1 - g m^2   (cap |D|, phase of D)
  floor<f>     : gain = max(cur, f)
  match<tag>_c : like R, lift lambda in [0,1] chosen per frame, channel, band (150-1k, 1-4k, >4k) so band energy <= max(E_cur, min(E_D, c^2 E_R))
Usage: python sri244_dip.py musdb <clips/wav> <outdir> [--n 50]
       python sri244_dip.py lovely <capture.st.f32> <t0> <cache.npz> <outdir>
Needs the venv with onnxruntime/soundfile (/tmp/bv/bin/python)."""
import sys, json, pathlib, argparse
import numpy as np, soundfile as sf
ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
_argv = sys.argv; sys.argv = ['x', 'none']
exec(open(ROOT / 'sri220_gate.py').read().split("if sys.argv[1] == 'lovely':")[0])
sys.argv = _argv
HOPS = hy.HOP / SR
BANDS = {'150-1k': S150, '1-4k': sos(1000, 4000), '>4k': sos(4000, 20000)}
BEDGE = [150, 1000, 4000, 22051]
M_LOW = 0.2

def variants():
    v = {'base': dict(kind='base')}
    for tag, tu, td in (('s1', 1, 1), ('s3', 3, 3), ('s10', 10, 10), ('u.2d5', 0.2, 5)):
        for c in (0.5, 0.7, 1.0):
            if tag in ('s1', 's10') and c != 0.7: continue
            v[f'R{tag}_c{c}'] = dict(kind='R', tu=tu, td=td, c=c)
    for f in (0.3, 0.4, 0.5, 0.65): v[f'floor{f}'] = dict(kind='floor', f=f)
    for c in (0.7, 1.0): v[f'matchs3_c{c}'] = dict(kind='match', tu=3, td=3, c=c)
    return v

def mdx_presence(c, tlo, thi, k=3):
    """SRI-250: per band, per STFT frame MDX-presence g = clip((|Vmdx|_band_dB - tlo)/(thi - tlo), 0, 1), k-frame box smoothing, expanded to bins [1,B,T] (1 below 150 Hz).
    Band dB = mono-mean |Vm|^2 summed in band, offset-calibrated so its 0.25 s block mean power equals frames(v, band) on the whole clip."""
    cache = getattr(c, '_pres', None)
    if cache is None:
        freq = np.fft.rfftfreq(hy.N_FFT, 1 / SR); Vmono = c.Vm.mean(0); T = Vmono.shape[1]; cache = []
        for i in range(3):
            bm = (freq >= BEDGE[i]) & (freq < BEDGE[i + 1]); e = (np.abs(Vmono[bm]) ** 2).sum(0)
            blk = int(0.25 * SR / hy.HOP); nb = T // blk
            ref = np.mean(frames(c.v, list(BANDS.values())[i]))
            off = ref - np.mean(10 * np.log10(e[:nb * blk].reshape(nb, blk).mean(1) + 1e-12))
            cache.append((bm, 10 * np.log10(e + 1e-12) + off))
        c._pres = cache
    T = c.Vm.shape[2]; out = np.ones((1, c.Vm.shape[1], T))
    for i, (bm, d) in enumerate(cache):
        lo, hi = (tlo[i], thi[i]) if np.ndim(tlo) else (tlo, thi)
        gg = np.convolve(np.clip((d - lo) / (hi - lo), 0, 1), np.ones(k) / k, 'same'); out[0, bm, :] = gg[None]
    return out

def combine(c, g, p):
    """Instrumental of variant p (time domain) and the per-bin gain [2,B,T] applied to D = X - Vz."""
    pres = mdx_presence(c, p['tlo'], p['thi']) if p['kind'] == 'gate' else 1.0
    fg = pres if p.get('fillgate') else 1.0
    Vz = c.Vm + g[None, None, :] * fg * (c.fill() - c.Vm)
    D = c.X - Vz
    cur = 1 - G * (c.ms * (pres if p.get('gaingate') else 1.0)) ** 2 * c.gate150
    gain = cur
    if p['kind'] == 'floor':
        gain = np.where(c.gate150, np.maximum(cur, p['f']), 1.0) * np.ones_like(cur)
    elif p['kind'] in ('R', 'match'):
        gain = cur.copy(); B, T = D.shape[1], D.shape[2]
        au, ad = (1 - np.exp(-HOPS / p['tu'])), (1 - np.exp(-HOPS / p['td']))
        R = np.zeros((2, B)); aD = np.abs(D); freq = np.fft.rfftfreq(hy.N_FFT, 1 / SR)
        bidx = [(freq >= BEDGE[i]) & (freq < BEDGE[i + 1]) for i in range(3)]
        lam = np.linspace(0, 1, 11)[:, None, None]
        for t in range(T):
            a, m, cu = aD[:, :, t], c.ms[:, :, t], cur[:, :, t]
            low = m < M_LOW
            R = np.where(low & (R == 0), a, R)
            R = np.where(low, R + np.where(a > R, au, ad) * (a - R), R)
            w = m ** 2
            if p['kind'] == 'R':
                tgt = np.minimum(1.0, p['c'] * R / (a + 1e-12))
                gain[:, :, t] = cu + w * np.maximum(0, tgt - cu) * (R > 0)
            else:
                lift = w * (1 - cu) * (R > 0); out = cu.copy()
                for bm in bidx:
                    Ec = ((a * cu)[:, bm] ** 2).sum(1); ED = (a[:, bm] ** 2).sum(1); ER = p['c'] ** 2 * (R[:, bm] ** 2).sum(1)
                    tgtE = np.maximum(Ec, np.minimum(ED, ER))
                    E = (((cu[:, bm][None] + lam * lift[:, bm][None]) * a[:, bm][None]) ** 2).sum(2)  # [11,2]
                    ok = E <= tgtE[None] * (1 + 1e-9)
                    l = np.where(ok, lam[:, :, 0], 0).max(0)  # [2]
                    out[:, bm] = cu[:, bm] + l[:, None] * lift[:, bm]
                gain[:, :, t] = out
    inst = hy.istft_(D * gain, c.n)
    return inst, gain, D, Vz

def band_frames(sig): return {b: frames(sig, f) for b, f in BANDS.items()}

def nearest_pause_ref(fb, sung, pause, rad=16):
    """Mean dB of pause frames within +-rad of each sung frame; nan if none."""
    ref = np.full(len(fb), np.nan)
    for i in sung:
        j = pause[np.abs(pause - i) <= rad]
        if len(j): ref[i] = fb[j].mean()
    return ref

def evaluate(c, g, sung, pause, acc=None, voc=None, base=None, vlist=None, keep=None):
    """Return per-variant {metrics, samples}. samples = pooled per-frame dips for the tables."""
    res = {}; fx = band_frames(c.x); fxm = frames(c.x)
    if acc is not None:
        fa = band_frames(acc)
        Acc = hy.stft_(acc)[..., :c.X.shape[2]]; Voc = hy.stft_(voc)[..., :c.X.shape[2]]
    for name, p in (vlist or variants()).items():
        inst, gain, D, Vz = combine(c, g, p)
        if keep is not None and name in keep[0]: keep[1][name] = inst
        fi = band_frames(inst); r = {'dip_pause': {}, 'err_gt': {}, 'gt_natural_dip': {}}
        for b in BANDS:
            ref = nearest_pause_ref(fi[b], sung, pause); d = np.array([ref[i] - fi[b][i] for i in sung]); d = d[~np.isnan(d)]
            r['dip_pause'][b] = d.tolist()
            if acc is not None:
                r['err_gt'][b] = [float(fi[b][i] - fa[b][i]) for i in sung]
                rg = nearest_pause_ref(fa[b], sung, pause); dg = np.array([rg[i] - fa[b][i] for i in sung]); r['gt_natural_dip'][b] = dg[~np.isnan(dg)].tolist()
        r['bass_delta_db'] = db(np.mean(sosfilt(S20, inst.mean(1)) ** 2)) - db(np.mean(sosfilt(S20, c.x.mean(1)) ** 2))
        r['fI150'] = frames(inst, S150).tolist()
        Vk = c.x - inst; r['fVk'] = frames(Vk).tolist(); r['fVk150'] = frames(Vk, S150).tolist()
        # vocal-dominant-bin energy in the instrumental (|Vz| > |D|), per STFT frame, dB
        O = D * gain; dom = (np.abs(Vz) > np.abs(D)) & c.gate150
        r['vdom_db'] = (10 * np.log10((np.abs(O) ** 2 * dom).sum((0, 1)) + 1e-9)).tolist()
        if acc is not None:  # voice error that the gains pass: gain * (true vocal - Vz); energy above 150 Hz per STFT frame, dB
            r['leak_gt_db'] = (10 * np.log10((np.abs(gain * (Voc - Vz)) ** 2 * c.gate150).sum((0, 1)) + 1e-9)).tolist()
            hm = (c.ms > 0.5) & c.gate150  # bins the mask calls vocal: level of the instrumental there vs the true accompaniment, per STFT frame
            r['err_hm_db'] = (10 * np.log10((np.abs(O) ** 2 * hm).sum((0, 1)) + 1e-9) - 10 * np.log10((np.abs(Acc) ** 2 * hm).sum((0, 1)) + 1e-9)).tolist(); r['hm_frac'] = float(hm.mean())
            fq = np.fft.rfftfreq(hy.N_FFT, 1 / SR); L = np.abs(gain * (Voc - Vz)) ** 2 * c.gate150
            r['leak_gt_band'] = {b: float(np.mean(10 * np.log10(L[:, (fq >= BEDGE[i]) & (fq < BEDGE[i + 1])].sum((0, 1)) + 1e-9))) for i, b in enumerate(BANDS)}
            r['ret_vs_acc_db'] = {'bass20-150': float(db(np.mean(sosfilt(S20, inst.mean(1)) ** 2)) - db(np.mean(sosfilt(S20, acc.mean(1)) ** 2))), **{b: float(db(np.mean(sosfilt(f, inst.mean(1)) ** 2)) - db(np.mean(sosfilt(f, acc.mean(1)) ** 2))) for b, f in BANDS.items()}}
            r['fSnr'] = float(10 * np.log10((acc ** 2).sum() / (((inst - acc) ** 2).sum() + 1e-12)))
        res[name] = r
    return res

def summarize(per_clip):
    """per_clip: {clip: {variant: r}} -> overall + per-clip table."""
    out = {'overall': {}, 'clips': {}}
    names = list(next(iter(per_clip.values())).keys())
    for n in names:
        o = {}
        for key in ('dip_pause', 'err_gt', 'gt_natural_dip'):
            for b in BANDS:
                allv = np.concatenate([np.array(per_clip[k][n][key].get(b, []), float) for k in per_clip]) if any(per_clip[k][n][key].get(b) for k in per_clip) else np.array([])
                if len(allv): o[f'{key}|{b}'] = dict(mean=float(allv.mean()), median=float(np.median(allv)), n=len(allv))
        bb = [per_clip[k]['base'] for k in per_clip]; vv = [per_clip[k][n] for k in per_clip]
        o['bass_change_vs_base'] = float(np.mean([v['bass_delta_db'] - b['bass_delta_db'] for v, b in zip(vv, bb)]))
        o['kar150_change_vs_base'] = float(np.mean([np.mean(np.array(v['fI150']) - np.array(b['fI150'])) for v, b in zip(vv, bb)]))
        o['vk_change_vs_base_db'] = float(np.mean([np.mean(np.array(v['fVk']) - np.array(b['fVk'])) for v, b in zip(vv, bb)]))
        o['vdom_change_vs_base_db'] = float(np.mean([np.mean(np.array(v['vdom_db']) - np.array(b['vdom_db'])) for v, b in zip(vv, bb)]))
        if 'leak_gt_db' in vv[0]:
            o['leak_gt_change_vs_base_db'] = float(np.mean([np.mean(np.array(v['leak_gt_db']) - np.array(b['leak_gt_db'])) for v, b in zip(vv, bb)]))
            o['err_hm_db'] = float(np.mean([np.mean(v['err_hm_db']) for v in vv])); o['err_hm_median'] = float(np.median(np.concatenate([v['err_hm_db'] for v in vv]))); o['hm_frac'] = float(np.mean([v['hm_frac'] for v in vv]))
            o['inst_snr_db'] = float(np.mean([v['fSnr'] for v in vv])); o['inst_snr_change_vs_base_db'] = o['inst_snr_db'] - float(np.mean([b['fSnr'] for b in bb]))
        out['overall'][n] = o
    for k in per_clip:
        out['clips'][k] = {}
        for n in names:
            o = {}
            for key in ('dip_pause', 'err_gt'):
                for b in BANDS:
                    a = np.array(per_clip[k][n][key].get(b, []), float)
                    if len(a): o[f'{key}|{b}'] = dict(mean=float(a.mean()), median=float(np.median(a)), n=len(a))
            out['clips'][k][n] = o
    return out

def pause_leak(c, per_clip_lovely_pause, res):
    for n, r in res.items():
        r['pause_vk_change_vs_base_db'] = float(np.mean(np.array(r['fVk'])[per_clip_lovely_pause] - np.array(res['base']['fVk'])[per_clip_lovely_pause])) if len(per_clip_lovely_pause) else None

def musdb(a):
    import mdx_stream as mx, spleeter_stream as ss
    voc_s, acc_s = ss.session('vocals'), ss.session('accompaniment')
    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True); cache = pathlib.Path('/tmp/s244'); cache.mkdir(exist_ok=True)
    per = {}; V = sweep_variants(a.thresholds) if a.thresholds is not None else variants()
    for cdir in [d for d in sorted(pathlib.Path(a.dir).glob('[0-9][0-9]')) if not a.clips or d.name in a.clips.split(',')][:a.n]:
        x, _ = sf.read(cdir / 'mix.wav'); acc, _ = sf.read(cdir / 'accompaniment.wav'); tv, _ = sf.read(cdir / 'vocals.wav')
        v = sf.read(cdir / 's94_m64/vocal.wav')[0]
        st = lambda z: z[:, :2] if z.ndim > 1 else np.stack([z, z], 1)
        x, acc, tv, v = map(st, (x, acc, tv, v)); n = len(x); acc, tv, v = acc[:n], tv[:n], v[:n]
        cf = cache / f'm{cdir.name}.npy'
        if cf.exists(): m = np.load(cf)
        else: m = hy.masks(x, voc_s, acc_s)[0]; np.save(cf, m)
        c = Clip(x, v, m); g = c.gates(PARAMS)['G2_mask_evidence']
        fT = frames(tv); nf = len(fT)
        sung = np.array([i for i in range(4, nf - 4) if fT[i] > -50]); pause = np.array([i for i in range(nf) if fT[i] < -55])
        per[cdir.name] = evaluate(c, g, sung, pause, acc=acc, voc=tv, vlist=V)
        print(cdir.name, 'sung', len(sung), 'pause', len(pause), flush=True)
    s = summarize(per); json.dump(s, open(out / 'musdb_summary.json', 'w'), indent=1)
    print('leak_gt_db (mean over STFT frames, >150 Hz, per band): variant - base, dB; ret = inst band energy vs true accompaniment, whole clip, dB; err_gt = inst - acc on sung frames, dB')
    for k in per:
        for n, r in per[k].items():
            b0 = per[k]['base']
            print(f'{k} {n:16s} leak_all {np.mean(r["leak_gt_db"]) - np.mean(b0["leak_gt_db"]):+.2f} ' + ' '.join(f'leak{b} {r["leak_gt_band"][b] - b0["leak_gt_band"][b]:+.2f}' for b in BANDS) + ' | ret ' + ' '.join(f'{b} {v:+.2f}' for b, v in r['ret_vs_acc_db'].items()) + ' | err_gt ' + ' '.join(f'{b} {np.mean(r["err_gt"][b]):+.2f}' for b in BANDS))
    for n in V:
        print(f'MEAN {n:16s} leak_all {np.mean([np.mean(per[k][n]["leak_gt_db"]) - np.mean(per[k]["base"]["leak_gt_db"]) for k in per]):+.2f} ' + ' '.join(f'leak{b} {np.mean([per[k][n]["leak_gt_band"][b] - per[k]["base"]["leak_gt_band"][b] for k in per]):+.2f}' for b in BANDS) + ' | ret ' + ' '.join(f'{b} {np.mean([per[k][n]["ret_vs_acc_db"][b] for k in per]):+.2f}' for b in ['bass20-150', *BANDS]) + ' | err_gt ' + ' '.join(f'{b} {np.mean([np.mean(per[k][n]["err_gt"][b]) for k in per]):+.2f}' for b in BANDS))

def lovely(a):
    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    x = np.fromfile(a.ref, dtype=np.float32).astype(np.float64).reshape(2, -1).T.copy(); z = np.load(a.cache); c = Clip(x, z['v'], z['m'])
    g = c.gates(PARAMS)['G2_mask_evidence']; fV = frames(z['v']); nf = len(fV)
    sung = np.array([i for i in range(4, nf - 4) if fV[i] > -50]); pause = np.array([i for i in range(nf) if fV[i] < -55])
    print('lovely sung', len(sung), 'pause', len(pause), flush=True)
    keep = (set(a.keep.split(',')) | {'base'}, {})
    res = evaluate(c, g, sung, pause, vlist=variants(), keep=keep)
    pause_leak(c, pause, res)
    s = summarize({'lovely': res}); s['lovely_pause_vk_change_vs_base_db'] = {n: r['pause_vk_change_vs_base_db'] for n, r in res.items()}
    s['frames'] = dict(sung=len(sung), pause=len(pause)); json.dump(s, open(out / 'lovely_summary.json', 'w'), indent=1)
    s0, s1 = int(round(30 * SR)), int(round(60 * SR))  # abs t0 + 30 .. 60 s = 101.5 .. 131.5 s, includes the 126 s dip
    for n, inst in keep[1].items():
        y = np.clip(inst[s0:s1], -1, 1); sf.write(out / ('before.wav' if n == 'base' else f'after_{n}.wav'), y, SR, subtype='PCM_16')
    print('wavs', list(keep[1]))
    report(a, keep[1], z['v'], c)

def report(a, insts, vmdx, c):
    """SRI-246: lovely 124-128 s band delta vs base, and per-frame 120-132 s table (inst 150-4k dB base vs variants next to MDX vocal level)."""
    at = lambda t: int(round((t - a.t0) / 0.25))
    i0, i1 = at(124), at(128); base = insts['base']; fb = band_frames(base)
    for n, inst in insts.items():
        if n == 'base': continue
        fi = band_frames(inst); print(n, 'lovely 124-128 s delta dB vs before:', {b: round(float(np.mean(fi[b][i0:i1] - fb[b][i0:i1])), 2) for b in BANDS})
    S1k4 = sos(150, 4000); fV = frames(vmdx); fm = frames(c.x, S1k4); fi_ = {n: frames(v, S1k4) for n, v in insts.items()}
    names = list(insts); print('t(s)  mix150-4k  ' + '  '.join(f'{n:>10}' for n in names) + '  MDXvocal')
    for i in range(at(120), min(at(132), len(fV))):
        print(f'{a.t0 + i * 0.25:6.2f} {fm[i]:9.1f}  ' + '  '.join(f'{fi_[n][i]:10.1f}' for n in names) + f'  {fV[i]:8.1f}')

def gate_variants():
    v = {'base': dict(kind='base')}
    for n, (ga, fi) in {'A': (1, 0), 'B': (0, 1), 'C': (1, 1)}.items(): v[f'{n}_-50/-35'] = dict(kind='gate', gaingate=ga, fillgate=fi, tlo=-50, thi=-35)
    for d in (-5, 5): v[f'C_{-50 + d}/{-35 + d}'] = dict(kind='gate', gaingate=1, fillgate=1, tlo=-50 + d, thi=-35 + d)
    return v

def sweep_variants(extra=''):
    """SRI-251: base + C at -50/-35, -52.5/-37.5, -55/-40, plus --thresholds 'name=lo0/hi0,lo1/hi1,lo2/hi2' (per band 150-1k, 1-4k, >4k; ';'-separated list)."""
    v = {'base': dict(kind='base')}
    for d in (0, -2.5, -5): v[f'C_{-50 + d:g}/{-35 + d:g}'] = dict(kind='gate', gaingate=1, fillgate=1, tlo=-50 + d, thi=-35 + d)
    for e in filter(None, extra.split(';')):
        n, t = e.split('='); lh = [tuple(map(float, q.split('/'))) for q in t.split(',')]
        v[n] = dict(kind='gate', gaingate=1, fillgate=1, tlo=[l for l, h in lh], thi=[h for l, h in lh])
    return v

def gate(a):
    """SRI-250: Vmdx-gated mask gain / dip fill. Table 1: lovely 125.8-127.0 s mean dB per band, X and out, loss = out - X.
    Table 2 (guard): windows [t0,t1] (abs s): per band out - base dB (instrumental; rises = vocal leak up) and |out| - |X| ."""
    x = np.fromfile(a.ref, dtype=np.float32).astype(np.float64).reshape(2, -1).T.copy(); z = np.load(a.cache); c = Clip(x, z['v'], z['m'])
    g = c.gates(PARAMS)['G2_mask_evidence']; at = lambda t: int(round((t - a.t0) / 0.25))
    fx = band_frames(c.x); fv = band_frames(z['v']); outs = {}
    for n, p in (sweep_variants(a.thresholds) if a.thresholds is not None else gate_variants()).items(): outs[n] = band_frames(combine(c, g, p)[0])
    wins = [(125.8, 127.0, 'dip')] + [tuple(map(float, w.split(':'))) + ('guard',) for w in a.guard.split(',')]
    for t0, t1, kind in wins:
        i0, i1 = at(t0), at(t1); print(f'--- window {t0}-{t1} s ({kind}); MDX vocal dB per band: ' + ' '.join(f'{b}={np.mean(fv[b][i0:i1]):.1f}' for b in BANDS))
        print(f'{"variant":14s} ' + ' '.join(f'{b:>8s} out  loss  vs_base' for b in BANDS) if False else f'{"variant":14s}' + ''.join(f' | {b}: X  out  out-X  out-base' for b in BANDS))
        for n, fo in outs.items():
            print(f'{n:14s}' + ''.join(f' | {np.mean(fx[b][i0:i1]):6.1f} {np.mean(fo[b][i0:i1]):6.1f} {np.mean(fo[b][i0:i1] - fx[b][i0:i1]):5.2f} {np.mean(fo[b][i0:i1] - outs["base"][b][i0:i1]):5.2f}' for b in BANDS))

def diag(a):
    """SRI-249: per 0.25 s frame 124.5-128 s, per band dB: |X| mix, |Vmdx|, |fill| = Vz - Vmdx (dip-fill part), |Vz| subtracted, |D| = X - Vz, |out| = base instrumental, |Xg| = X * base gain (what Vz = 0 would give)."""
    x = np.fromfile(a.ref, dtype=np.float32).astype(np.float64).reshape(2, -1).T.copy(); z = np.load(a.cache); c = Clip(x, z['v'], z['m'])
    g = c.gates(PARAMS)['G2_mask_evidence']
    inst, gain, D, Vz = combine(c, g, dict(kind='base'))
    sigs = {'X': c.x, 'Vmdx': z['v'], 'fill': hy.istft_(Vz - c.Vm, c.n), 'Vz': hy.istft_(Vz, c.n), 'D': hy.istft_(D, c.n), 'out': inst, 'Xg': hy.istft_(c.X * gain, c.n)}
    fb = {k: band_frames(v) for k, v in sigs.items()}
    msf = frames(c.x)  # frame grid
    at = lambda t: int(round((t - a.t0) / 0.25))
    for b in BANDS:
        print(f'band {b} dB   t(s)   ' + ' '.join(f'{k:>7}' for k in sigs) + '   mask(mean over bins>=150, frame)  gate')
        for i in range(at(125.0), at(128.0) + 1):
            t = a.t0 + i * 0.25; hp = int(round(t * SR / hy.HOP)); h0 = int(round((t - a.t0) * SR / hy.HOP))
            m = c.ms[:, c.gate150[0, :, 0], h0].mean() if h0 < c.ms.shape[2] else float('nan')
            print(f'{t:20.2f} ' + ' '.join(f'{fb[k][b][i]:7.1f}' for k in sigs) + f'   {m:6.3f}  {g[min(h0, len(g)-1)]:.2f}')
    for b in BANDS:
        w = lambda t0, t1: {k: round(float(np.mean(fb[k][b][at(t0):at(t1)])), 1) for k in ('X', 'Vmdx', 'fill', 'Vz', 'D', 'out', 'Xg')}
        print(b, 'mean dB 125.8-127.0', w(125.8, 127.0), '| X 125.5 / 126.0 / 128.0:', [round(float(fb['X'][b][at(t)]), 1) for t in (125.5, 126.0, 128.0)])

if __name__ == '__main__':
    if sys.argv[1] == 'diag':
        ap = argparse.ArgumentParser(); ap.add_argument('mode'); ap.add_argument('ref'); ap.add_argument('t0', type=float); ap.add_argument('cache'); diag(ap.parse_args()); sys.exit()
    if sys.argv[1] == 'gate':
        ap = argparse.ArgumentParser(); ap.add_argument('mode'); ap.add_argument('ref'); ap.add_argument('t0', type=float); ap.add_argument('cache'); ap.add_argument('--guard', default='50:70,100:120'); ap.add_argument('--thresholds', default=None); gate(ap.parse_args()); sys.exit()
    ap = argparse.ArgumentParser(); ap.add_argument('mode')
    if sys.argv[1] == 'musdb': ap.add_argument('dir'); ap.add_argument('out'); ap.add_argument('--n', type=int, default=50); ap.add_argument('--clips', default=''); ap.add_argument('--thresholds', default=None)
    else: ap.add_argument('ref'); ap.add_argument('t0', type=float); ap.add_argument('cache'); ap.add_argument('out'); ap.add_argument('--keep', default='Rs3_c0.7')
    A = ap.parse_args(); (musdb if A.mode == 'musdb' else lovely)(A)
