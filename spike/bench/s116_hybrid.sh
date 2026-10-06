#!/bin/sh
# SRI-116 stage 1b: Karaoke hybrids (MDX T=64 + Spleeter). Needs clips/*/s94_m64 (bench/s94_mdx.sh). PY=/path/to/python with museval + onnxruntime
PY=${PY:-python3}; cd "$(dirname "$0")/.."
(cd ml && $PY hybrid_stream.py 2>&1 | grep -v onnxruntime >/dev/null)
for t in h1_c2 h1_spl h2 h3_p2_g0.5 h3_p2_g1.0 h3_p4_g0.5 h3_p4_g1.0 h4; do $PY bench/metrics.py s116_$t >> bench/results/metrics.jsonl; done
