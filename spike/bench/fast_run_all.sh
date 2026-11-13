#!/bin/bash
# Full fast-model bench chain. Run from worktree root. One log per model, one retry on crash.
PY=/Users/sriv/Space/Repos/All-Mixer/.venv/bin/python
mkdir -p spike/bench/results/fast_logs
for m in roformer compat kim2 kim2_fp16 kim2_fp16_t128 scnet_vocals mdx23c_t128_fp16 mdx23c_t128; do
  for try in 1 2; do
    node spike/bench/fast_eval.mjs $m > spike/bench/results/fast_logs/$m.$try.log 2>&1 && break
    echo "$m try $try failed"
  done
done
$PY -I spike/bench/fast_report.py | tee spike/bench/results/fast_logs/report.txt
