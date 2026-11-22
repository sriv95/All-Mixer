# kara2 round 2 (deux long-mode teacher targets) results

## Setup
- Round 2: trained on deux long-mode teacher targets, fixed 400-frame crops, init ft10500, 34000 steps.
- Eval: 49 MUSDB18-HQ test songs, `spike/finetune/eval_kara2_ft.py`, frames 228 and 718, paired 2000-resample bootstrap 95% CI.
- Run on the Mac. The logs do not print the device; the script default (no `--device` passed) is cuda, then mps, then cpu, so this was mps (inferred, not logged).
- ft10500 was re-run on the Mac as the paired reference: 228 = 11.658, 718 = 12.068. PC reference: 228 = 11.658, 718 = 12.068 (same to 3 decimals). Untuned: 228 = 11.300, 718 = 11.872.

## Results (SDR dB, mean over 49 songs; diffs with 95% CI)

| ckpt | 228 mean | 718 mean | vs untuned @228 | vs untuned @718 | vs ft10500 @228 | vs ft10500 @718 |
|---|---|---|---|---|---|---|
| ft10500 | 11.658 | 12.068 | +0.358 [+0.095, +0.711] | +0.196 [+0.022, +0.397] | ref | ref |
| r2 best_sdr | 11.720 | 11.995 | +0.420 [+0.199, +0.690] | +0.122 [-0.088, +0.355] | +0.062 [-0.053, +0.168] | -0.074 [-0.197, +0.042] |
| r2 snap_30000 | 11.720 | 11.990 | +0.420 [+0.200, +0.684] | +0.118 [-0.094, +0.351] | +0.062 [-0.056, +0.170] | -0.078 [-0.205, +0.043] |
| r2 snap_20000 | 11.680 | 11.949 | +0.380 [+0.158, +0.638] | +0.077 [-0.136, +0.314] | +0.022 [-0.108, +0.141] | -0.119 [-0.250, -0.002] |

## Gate and verdict
Replace ft10500 only if: at 228 vs ft10500 the CI lower bound > 0, AND at 718 the CI upper bound >= 0 and mean >= -0.05.

Verdict: do NOT replace ft10500. Best candidate best_sdr: 228 +0.062 [-0.053, +0.168] (lower bound < 0), 718 -0.074 [-0.197, +0.042] (mean < -0.05). snap_30000 fails the same way; snap_20000 is worse at 718 (CI excludes 0 on the negative side).
Stage 2 (fp16 export, NaN check, speed) skipped because the gate failed.

## Likely causes (hypotheses, not tested)
- Fixed 400-frame crops, so no long-chunk training; this may explain no gain at 718.
- Only the 100 MUSDB songs as training data.
- The drop at 718 (best_sdr -0.074 vs ft10500) is the part that fails the gate.

## Reproduce
From the worktree (`chain.sh` in `progress/All-Mixer/teacher-distill-results/kara2_r2/eval/`), with `E=spike/finetune/eval_kara2_ft.py`, `O=<...>/teacher-distill-results/kara2_r2/eval`:
```
.venv/bin/python -I $E --ckpt <...>/kara2-ft-results/ft10500_model.pt --out $O/ft10500.json > $O/ft10500.log 2>&1
for n in best_sdr snap_30000 snap_20000; do
  .venv/bin/python -I $E --ckpt <...>/teacher-distill-results/kara2_r2/$n.pt --ref $O/ft10500.json --out $O/$n.json > $O/$n.log 2>&1
done
```
`--ref` reuses the reference run's untuned SDRs (same device) and reports the paired ckpt-vs-ref diff and CI. Note the script's own PASS lines compare against untuned, not ft10500; the gate above is the one that counts.
