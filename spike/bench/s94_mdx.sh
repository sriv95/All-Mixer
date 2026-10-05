#!/bin/sh
# SRI-100 step 3: MDX-Net 9482 streaming candidates. PY=/path/to/python with museval + onnxruntime
PY=${PY:-python3}; cd "$(dirname "$0")/.."
for T in 32 64; do $PY ml/mdx_stream.py s94_m$T --T $T 2>&1 | grep 'added delay'; $PY bench/metrics.py s94_m$T >> bench/results/metrics.jsonl; done
