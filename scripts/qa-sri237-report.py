"""SRI-240 (QA of SRI-237): in-Chrome captures of lovely, old (c409932) vs new (G2 dip fill), Karaoke + A cappella.
usage: python qa-sri237-report.py <scratch> <scripts> <out.json>
Dip metric as sri220_gate.py: 0.25 s full-band frames of the vocal output; dip = max(+-4 frames) - frame."""
import sys, json, numpy as np
from scipy.signal import butter, sosfilt, correlate
S, R, OUT = sys.argv[1:4]; SR = 44100; F = SR // 4
db = lambda e: 10 * np.log10(e + 1e-12)
ld = lambda b, m: np.fromfile(f'{S}/qa203-{b}-{m}-{m}.f32', dtype=np.float32).astype(np.float64)
meta = lambda b, m: json.load(open(f'{R}/qa-sri237-{b}-{m}-{m}-wl.json'))
sos = lambda lo, hi: butter(4, [lo, hi], 'bandpass', fs=SR, output='sos')
S150, S20 = sos(150, 1000), sos(20, 120)
def frames(s, off=0, filt=None):
    s = s[off:]; s = s if filt is None else sosfilt(filt, s); n = len(s) // F
    return np.array([db(np.mean(s[i * F:(i + 1) * F] ** 2)) for i in range(n)])
def lag(a, b, maxs=3 * SR):  # b[k] ~ a[k + lag]; both bandpassed 100-1000, decimated by 10
    f = sos(100, 1000); d = 10; x = sosfilt(f, a)[::d]; y = sosfilt(f, b)[::d]
    c = correlate(x, y, mode='full'); mid = len(y) - 1; w = maxs // d; seg = c[mid - w: mid + w + 1]
    k = int(np.argmax(seg)) - w; return k * d, float(seg.max() / (np.linalg.norm(x) * np.linalg.norm(y) + 1e-12))
out = {}
oa, na = ld('old', 'acappella'), ld('new', 'acappella'); ok, nk = ld('old', 'karaoke'), ld('new', 'karaoke')
mo, mn = meta('old', 'acappella'), meta('new', 'acappella')
vid0 = lambda m: m['sec0'] - 1.97
# align each capture to video time with the old A cappella as the dip-pattern anchor
DIPS = [102.5, 104.3, 104.5, 107.5, 111.25, 119.75, 120.5, 125.8, 126.0, 126.25, 126.5, 127.75]
def dips_at(fr, t_of_frame0, phase):
    res = {}
    for t in DIPS:
        i = int(round((t - t_of_frame0 - phase) / 0.25))
        if 4 <= i < len(fr) - 4: res[t] = float(fr[max(0, i - 4):i + 5].max() - fr[i])
    return res
# best phase: maximise old dip at 126.0 within +-0.6 s of the nominal clock
t0o = vid0(mo); best = None
for ph in np.arange(-0.6, 0.6, 0.0125):
    s0 = int(round(ph * SR)); fr = frames(oa, max(0, s0)) if s0 >= 0 else frames(oa)
    d = dips_at(fr, t0o + max(0, ph), 0).get(126.0)
    if d is not None and (best is None or d > best[1]): best = (float(ph), d)
ph0 = best[0]; out['anchor'] = dict(old_vid0=t0o, phase=ph0, old_dip126=best[1])
off_old = max(0, int(round(ph0 * SR))); tf0 = t0o + off_old / SR
L_aa, c_aa = lag(oa, na); out['lag_acappella_old_vs_new_samples'] = (L_aa, c_aa)   # na[k] ~ oa[k + L]
# frames in the new capture on the same video-time grid as old
off_new = off_old - L_aa
if off_new < 0: off_old += -off_new; off_new = 0
fo, fn = frames(oa, off_old), frames(na, off_new); n = min(len(fo), len(fn)); fo, fn = fo[:n], fn[:n]
tf0 = vid0(mo) + off_old / SR; out['frame0_video_t'] = tf0
out['acappella_dips_old'] = dips_at(fo, tf0, 0); out['acappella_dips_new'] = dips_at(fn, tf0, 0)
out['acappella_worst_old'] = float(max(out['acappella_dips_old'].values())); out['acappella_worst_new'] = float(max(out['acappella_dips_new'].values()))
# new vs old vocal level per frame (artifacts: large positive = added energy, e.g. fill in pauses)
dlt = fn - fo; out['acappella_new_minus_old_db'] = dict(mean=float(dlt.mean()), p5=float(np.percentile(dlt, 5)), p95=float(np.percentile(dlt, 95)), max=float(dlt.max()), min=float(dlt.min()))
pm = fo < -55
out['pause_frames'] = int(pm.sum()); out['pause_vocal_new_minus_old_db'] = dict(mean=float(dlt[pm].mean()), max=float(dlt[pm].max())) if pm.any() else None
quiet = fo < -45; out['quiet_frames_lt-45'] = int(quiet.sum()); out['quiet_new_minus_old_max'] = float(dlt[quiet].max()) if quiet.any() else None
out['frames_table'] = [dict(t=round(tf0 + i * 0.25, 2), V_old=round(float(fo[i]), 1), V_new=round(float(fn[i]), 1)) for i in range(n) if 124 <= tf0 + i * 0.25 <= 129]
# sample-level peak (hard clipping check)
out['peak'] = {k: float(np.max(np.abs(v))) for k, v in dict(old_acap=oa, new_acap=na, old_kar=ok, new_kar=nk).items()}
# Karaoke: align new to old, compare 150-1000 band and bass 20-120 over the aligned span
Lk, ck = lag(ok, nk); out['lag_karaoke_old_vs_new_samples'] = (Lk, ck)
a0, b0 = (max(0, Lk), max(0, -Lk)); m = min(len(ok) - a0, len(nk) - b0) - SR
ko, kn = ok[a0:a0 + m], nk[b0:b0 + m]
fb = lambda s, f: frames(s, 0, f); bo, bn = fb(ko, S150), fb(kn, S150); lo_, ln_ = fb(ko, S20), fb(kn, S20); ro, rn = frames(ko), frames(kn)
tk0 = vid0(meta('old', 'karaoke')) + a0 / SR
out['karaoke'] = dict(t0=tk0, band150_1000_new_minus_old_mean=float((bn - bo).mean()), band150_1000_new_minus_old_sd=float((bn - bo).std()), band150_1000_new_minus_old_max=float((bn - bo).max()), band150_1000_new_minus_old_min=float((bn - bo).min()),
    bass20_120_new_minus_old_mean=float((ln_ - lo_).mean()), bass20_120_new_minus_old_maxabs=float(np.abs(ln_ - lo_).max()), full_new_minus_old_mean=float((rn - ro).mean()), full_new_minus_old_maxabs=float(np.abs(rn - ro).max()),
    # pumping: frame-to-frame 150-1000 level swing, old vs new
    pump_sd_old=float(np.diff(bo).std()), pump_sd_new=float(np.diff(bn).std()), pump_max_drop_old=float(np.diff(bo).min()), pump_max_drop_new=float(np.diff(bn).min()))
kt = [dict(t=round(tk0 + i * 0.25, 2), b_old=round(float(bo[i]), 1), b_new=round(float(bn[i]), 1)) for i in range(len(bo)) if 124 <= tk0 + i * 0.25 <= 129]
out['karaoke_table'] = kt
# CPU proxy: ML worker timing logs (debug.mlTiming)
import re
def p95(b, mode):
    r = []
    for _, l in meta(b, mode)['mlLog']:
        q = re.search(r'mdx resp p50/p95/max (\d+)/(\d+)/(\d+) ms, spl catchUp p50/p95/max (\d+)/(\d+)/(\d+) ms, n (\d+)', l)
        if q: r.append(dict(mdx_p50=int(q[1]), mdx_p95=int(q[2]), spl_p50=int(q[4]), spl_p95=int(q[5]), n=int(q[7])))
    return r
out['ml_timing'] = {f'{b}-{m}': p95(b, m) for b in ('old', 'new') for m in ('karaoke', 'acappella')}
json.dump(out, open(OUT, 'w'), indent=1)
print(json.dumps({k: v for k, v in out.items() if k not in ('frames_table', 'karaoke_table')}, indent=1))
print('A cappella V (old/new):', [(r['t'], r['V_old'], r['V_new']) for r in out['frames_table']])
print('Karaoke 150-1000 (old/new):', [(r['t'], r['b_old'], r['b_new']) for r in out['karaoke_table']])
