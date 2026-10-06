"""SRI-203 final: align in-Chrome captures to the offline stems, per-250 ms table + chart. usage: python qa-sri203-report.py <scratch> <scripts> <out.json>"""
import sys, json, numpy as np
from scipy.signal import butter, sosfiltfilt, sosfilt, correlate
S, R, OUT = sys.argv[1:4]; SR = 44100; F = SR // 4
ld = lambda m: np.fromfile(f'{S}/qa203-lovely-{m}.f32', dtype=np.float32).astype(np.float64)
ref = ld('reference'); V = np.load(f'{S}/offline-v.npy').astype(np.float64); I = np.load(f'{S}/offline-inst.npy').astype(np.float64)
off = {r['t']: r for r in json.load(open(f'{S}/offline.json'))}
db = lambda e: 10 * np.log10(e + 1e-14)
sos = butter(4, [100, 1000], 'bandpass', fs=SR, output='sos')
def xcorr_lag(x, stem, nominal):
    d = 10; a = sosfilt(sos, stem)[::d]; b = sosfilt(sos, x[SR * 5: SR * 35])[::d]; a -= a.mean(); b -= b.mean()
    c = correlate(a, b, mode='valid') / (np.linalg.norm(b) * 1e0)
    k0 = int((nominal + 5) * SR / d); w = int(1.0 * SR / d); lo, hi = max(0, k0 - w), min(len(c), k0 + w)
    k = lo + int(np.argmax(c[lo:hi])); pa = a[k:k + len(b)]; r = float(np.dot(pa, b) / (np.linalg.norm(pa) * np.linalg.norm(b) + 1e-12))
    return (k * d / SR) - 5, r   # mode sample s corresponds to stem sample s + lag*SR
nom = {'karaoke': 1.98 + 0.0, 'acappella': 1.98}
sec0 = {k: json.load(open(f'{R}/qa-sri203-lovely-{k}-wl.json'))['sec0'] for k in ('reference', 'karaoke', 'acappella')}
out = {}
for m, stem in (('karaoke', I), ('acappella', V)):
    x = ld(m); nominal = (sec0[m] - 1.97) - sec0['reference']; L, r = xcorr_lag(x, stem, nominal)
    d = json.load(open(f'{R}/qa-sri203-lovely-{m}-wl.json')); t0 = d['bt'][0]; wl = d['wl']
    rows = []
    fr = np.fft.rfftfreq(F, 1 / SR); win = np.hanning(F)
    def band(s, lo, hi): P = np.abs(np.fft.rfft(s * win)) ** 2 / (win ** 2).sum(); return db(P[(fr >= lo) & (fr < hi)].sum() / F)
    for i in range(int(np.ceil(max(0, -L) / 0.25)), 236):
        t = i * 0.25; s0 = int(round((t - L) * SR))   # mode sample for ref time t
        if s0 < 0 or s0 + F > len(x): continue
        xs = x[s0:s0 + F]; rs = ref[i * F:(i + 1) * F]
        tm = (t - L); ws = [w for w in wl if tm - 0.02 <= w['t'] - t0 < tm + 0.27]
        o = off.get(t)
        row = dict(t=t, vid=sec0['reference'] + t, ref_rms=db(np.mean(rs ** 2)), rms=db(np.mean(xs ** 2)), b80=band(xs, 80, 250), b250=band(xs, 250, 1000), b1k=band(xs, 1000, 4000),
                   ref80=band(rs, 80, 250), ref250=band(rs, 250, 1000), ref1k=band(rs, 1000, 4000),
                   w=float(1 - max(w['b'] for w in ws)) if ws else None, miss=ws[-1]['st']['misses'] if ws else None, post=ws[-1]['st']['posted'] if ws else None, ret=ws[-1]['st']['returned'] if ws else None, ph=ws[-1]['ph'] if ws else None)
        if o: row.update(off_V=o['V'], off_inst=o['inst'], off_inst150=o['inst150'], off_x150=o['x150'], off_xmv150=o['xmv150'], off_V150=o['V150'], mask=o['mask'], off_x=o['x'])
        row['stem_rms'] = db(np.mean(stem[i * F:(i + 1) * F] ** 2))
        row['cap150'] = band(xs, 150, 1000); row['ref150'] = band(rs, 150, 1000)
        rows.append(row)
    out[m] = dict(lag=L, corr=r, rows=rows, ml=[l for _, l in d['mlLog']], wl_n=len(wl), wl_b_nonzero=sum(1 for w in wl if w['b'] > 0), misses=wl[-1]['st']['misses'], posted=wl[-1]['st']['posted'], returned=wl[-1]['st']['returned'])
    print(m, 'lag %.3f corr %.3f rows %d wl %d bypass>0 %d misses %d' % (L, r, len(rows), len(wl), out[m]['wl_b_nonzero'], out[m]['misses']))
json.dump(out, open(OUT, 'w'))
