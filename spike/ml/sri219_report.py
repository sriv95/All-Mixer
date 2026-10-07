"""SRI-219: per-config worst dip (SRI-209 metric: max of V frame dB within +-4 frames minus V at the frame, listed times) and
comparison with the in-Chrome acappella frames (scripts/qa-sri203-result.json). Usage: python sri219_report.py <dir> <t0> <chrome-result.json> <out.json>"""
import sys, json, glob, pathlib
import numpy as np
d, t0, chrome, outf = sys.argv[1], float(sys.argv[2]), sys.argv[3], sys.argv[4]
DIPS = [102.5, 104.3, 104.5, 107.5, 111.25, 119.75, 120.5, 125.8, 126.0, 126.25, 126.5, 127.75]
at = lambda t: int(round((t - t0) / 0.25))
ch = {round(r['vid'] - t0, 2): r['rms'] for r in json.load(open(chrome))['acappella']['rows']}
chf = {int(round(t / 0.25)): v for t, v in ch.items()}
base = np.array(json.load(open(f'{d}/shift0.json')))
rows = {}
for f in [g for g in sorted(glob.glob(f'{d}/*.json')) if not g.endswith('report.json')]:
    k = pathlib.Path(f).stem; v = np.array(json.load(open(f)))
    dips = {t: float(v[max(0, at(t) - 4):at(t) + 5].max() - v[at(t)]) for t in DIPS}
    w = [i for i in range(at(125.75), at(126.5) + 1)]
    r = dict(worst_dip=max(dips.values()), worst_at=max(dips, key=dips.get), dips=dips,
             min_vs_shift0_125_8_126_5=float(min(v[i] - base[i] for i in w)),   # how far V falls below the shift-0 V in the Chrome-dip frames
             chrome_gap_125_8_126_5=float(np.mean([abs(v[i] - chf[i]) for i in w if i in chf])),
             chrome_gap_all=float(np.mean([abs(v[i] - chf[i]) for i in range(at(102), at(127.8)) if i in chf and i < len(v)])))
    rows[k] = r
json.dump(rows, open(outf, 'w'), indent=1)
print(f'{"cfg":14}{"worst":>7}{"@":>8}{"min-vs-0":>10}{"gap125.8-126.5":>16}{"gapAll":>8}')
for k, r in rows.items(): print(f'{k:14}{r["worst_dip"]:7.1f}{r["worst_at"]:8}{r["min_vs_shift0_125_8_126_5"]:10.1f}{r["chrome_gap_125_8_126_5"]:16.1f}{r["chrome_gap_all"]:8.2f}')
