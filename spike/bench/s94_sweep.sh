#!/bin/sh
# SRI-100 stage 1 Spleeter candidates. Usage: bench/s94_sweep.sh   (PY=/path/to/python with museval + onnxruntime)
PY=${PY:-python3}; cd "$(dirname "$0")/.."
BASE="--hop-frames 4 --ctx 64 --pre 3072"
AC="--voc-power 4 --voc-framegate=-30,-18"
run() { tag=$1; shift; $PY ml/spleeter_stream.py $tag $BASE "$@" 2>&1 | grep 'added delay'; $PY bench/metrics.py $tag >> bench/results/metrics.jsonl; }
for L in 8 16 32; do run s94_c1_L$L --single --lookahead $L $AC; done
for e in 1 1.5 2; do run s94_c2_e$e --two-model --lookahead 2 --voc-power $e; done
run s94_c2_e2_L8 --two-model --lookahead 8 --voc-power 2
run s94_c3_k1 --single --lookahead 2 --mask-smooth 1 $AC
run s94_c3_k2 --single --lookahead 2 --mask-smooth 2 $AC
run s94_c3_k3 --single --lookahead 3 --mask-smooth 3 $AC
run s94_c3_f3 --single --lookahead 2 --freq-smooth 3 $AC
run s94_c3_L8_k3_f3 --single --lookahead 8 --mask-smooth 3 --freq-smooth 3 $AC
