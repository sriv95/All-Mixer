# usage: stats.py [results_all.csv] [stats.md] [bench_all OUTDIR, for wav paths in the report]  paired deux vs sw stats, non-silent clips only for SDR stats
import sys, numpy as np, pandas as pd
src = sys.argv[1] if len(sys.argv) > 1 else 'results_all.csv'; dst = sys.argv[2] if len(sys.argv) > 2 else 'stats.md'
df = pd.read_csv(src); OUT = sys.argv[3] if len(sys.argv) > 3 else 'out'
met = ['sdr', 'sisdr', 'bleed_db', 'instr_sdr']; rng = np.random.default_rng(0)
L = [f"clips in csv: {df.groupby(['set','clip']).ngroups}, silent-ref flagged (excluded): {df[df.silent==1].groupby(['set','clip']).ngroups}\n"]
ok = df[df.silent == 0]
for dm, df_, sm, sf_ in ((('deux'), 112, 'sw', 112), ('deux', 224, 'sw', 256)):
    a = ok[(ok.model == dm) & (ok.frames == df_)].set_index(['set', 'clip']); b = ok[(ok.model == sm) & (ok.frames == sf_)].set_index(['set', 'clip'])
    ix = a.index.intersection(b.index)
    for sset in ('all', 'A', 'B'):
        i = ix if sset == 'all' else ix[ix.get_level_values(0) == sset]
        if len(i) == 0: continue
        L.append(f"\n### {dm}{df_} vs {sm}{sf_}, set {sset} (n={len(i)})\n\n| metric | deux mean | deux median | sw mean | sw median | diff mean (sw-deux) | diff median | sw wins |\n|---|---|---|---|---|---|---|---|")
        for m in met:
            x, y = a.loc[i, m], b.loc[i, m]; v = x.notna() & y.notna(); x, y = x[v], y[v]; d = y - x
            L.append(f"| {m} | {x.mean():.2f} | {x.median():.2f} | {y.mean():.2f} | {y.median():.2f} | {d.mean():+.2f} | {d.median():+.2f} | {(d<0).sum()}/{len(d)} (bleed: lower wins) |" if m == 'bleed_db' else f"| {m} | {x.mean():.2f} | {x.median():.2f} | {y.mean():.2f} | {y.median():.2f} | {d.mean():+.2f} | {d.median():+.2f} | {(d>0).sum()}/{len(d)} |")
        d = (b.loc[i, 'sdr'] - a.loc[i, 'sdr']).values
        bs = rng.choice(d, (10000, len(d))).mean(1); lo, hi = np.percentile(bs, [2.5, 97.5])
        L.append(f"\nSDR diff mean {d.mean():+.2f} dB, 95% bootstrap CI [{lo:+.2f}, {hi:+.2f}] -> **{'sw can replace deux' if lo > -0.3 else 'sw cannot be shown to replace deux'}** (CI lower > -0.3)")
        if sset == 'all':
            big = [(k, v) for k, v in zip(i, d) if abs(v) > 1]
            L.append(f"\nclips with |SDR diff| > 1 dB: {len(big)}")
            for (s, c), v in sorted(big, key=lambda t: t[1]):
                L.append(f"- {s}/{c} {v:+.2f} dB: `{OUT}/{dm}_{df_}/{s}_{c}.wav` `{OUT}/{sm}_{sf_}/{s}_{c}.wav`")
open(dst, 'w').write('\n'.join(L) + '\n'); print(f"wrote {dst}")
