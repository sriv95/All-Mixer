#!/bin/sh
# SRI-116 margin sweep: H3 p=2, g in 0.6/0.7/0.8, plus per-clip vocal_leak for c0/g0.5/sweep (bench/results/perclip/*.json)
PY=${PY:-python3}; cd "$(dirname "$0")/.."
(cd ml && $PY hybrid_stream.py --sweep 2>&1 | grep -v onnxruntime >/dev/null)
for t in s94_c0 s116_h3_p2_g0.5 s116_h3_p2_g0.6 s116_h3_p2_g0.7 s116_h3_p2_g0.8; do
  $PY bench/metrics.py $t > bench/results/perclip/_m.json
  case $t in s116_h3_p2_g0.[678]) cat bench/results/perclip/_m.json >> bench/results/metrics.jsonl;; esac
done
rm bench/results/perclip/_m.json
$PY - <<'P'
import json,glob,os
r={os.path.basename(f)[:-5]:json.load(open(f)) for f in glob.glob('bench/results/perclip/*.json')}
c0=r['s94_c0']
for k,v in sorted(r.items()):
    ks=[c for c in v if v[c] is not None and c0.get(c) is not None]
    print(k, sum(v[c]<=c0[c] for c in ks), '/', len(ks))
P
