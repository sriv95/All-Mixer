# Fast vocal model candidates (M1 8 GB, Chrome WebGPU, ORT-web)

Goal: speed first (same as roformer or faster), quality second, delay up to 3 s acceptable.

| model | ONNX size, precision | chunk (frames, s) | WebGPU step p50 ms | RTF | min delay on M1 | vocal SDR | instr SDR | paired delta vs roformer, vocal [95% CI] | paired delta vs roformer, instr [95% CI] | weights licence | WebGPU / export problems |
|---|---|---|---|---|---|---|---|---|---|---|---|
| roformer (Kim Mel-Band RoFormer, High quality) | 461 MB fp16 (shipped `models-out/roformer.onnx`, 460,772,871 B) | 112, 1.11 | 735 | 0.82 | 2.00 s (planner chunk 1.14 s) | 9.27 | 13.24 | reference | reference | MIT per HF card https://huggingface.co/KimberleyJSN/melbandroformer (summary-level only, raw metadata 401) | none, shipped |
| compat (MDX-Net 9482, Default) | 30 MB fp32 | 64, 1.56 | 153 | 0.20 | 1.79 s (chunk 1.56 s), approx of `mdx-plan.ts` | 6.34 | 10.38 | -2.93 [-3.27, -2.58] | -2.86 [-3.18, -2.50] | unverified | none, shipped |
| kim2 (Kim Vocal 2, fp32) | 67 MB fp32 | 64, 1.64 | 720 | 0.88 | 2.00 s (planner chunk 1.28 s) * | 10.38 | 14.32 | +1.11 [+0.90, +1.33] | +1.08 [+0.86, +1.30] | unverified (see below) | n_fft 7680 not a power of two, needs Bluestein or other FFT; dynamic frames axis made by `export_kim2.py` |
| kim2_fp16 | 33 MB fp16 | 64, 1.64 | 600 | 0.73 | 2.00 s (planner chunk 1.37 s) * | 10.38 | 14.32 | +1.11 [+0.89, +1.34] | +1.08 [+0.87, +1.30] | unverified (see below) | same as kim2; fp16 weights, fp32 IO; same SDR as fp32 |
| kim2_fp16_t128 | 33 MB fp16 | 128, 3.12 | 1143 | 0.73 | 2.00 s (planner chunk 1.39 s) * | 10.62 | 14.55 | +1.35 [+1.15, +1.55] | +1.31 [+1.11, +1.52] | unverified (see below) | same as kim2; step is 2x per chunk, RTF same |
| scnet_vocals (SCNet Tran, vocals) | 43 MB fp32 | 128 fixed, 3.04 | 883 | 0.58 | 3.04 s (fixed chunk) | 9.96 | 13.93 | +0.69 [+0.41, +1.02] | +0.69 [+0.41, +0.99] | unverified, non-commercial in effect (MUSDB18 only) | fp16 overflows (fp32 only); STFT win rect + normalized=True; vocals = source 3 (channels 12:16) |
| mdx23c_t128_fp16 (MDX23C) | 224 MB fp16 | 128 fixed, 3.13 | 1629 | 1.04 | cannot run live (RTF >= 1) | 10.82 | 14.74 | +1.55 [+1.31, +1.81] | +1.50 [+1.24, +1.72] | unverified | exported T=128 (native 256), fp16 weights with fp32 IO; too slow on M1 |
| mdx23c_t128 | 448 MB fp32 | 128 fixed, 3.13 | 2325 | 1.48 | cannot run live (RTF >= 1) | 10.82 | 14.74 | +1.55 [+1.31, +1.81] | +1.50 [+1.26, +1.76] | unverified | too slow, 448 MB |

\* kim2* have a dynamic frames axis, so the RoFormer planner port (`vocal_plan.min_delay`, port of `src/ml/rof-plan.ts`) value stands. Fixed-T exports (scnet_vocals, mdx23c_t128, mdx23c_t128_fp16) show the exported chunk. RTF >= 1 shows "cannot run live". The compat delay is an approximation of `src/ml/mdx-plan.ts`. The roformer ONNX is fp16: the harness loads `models-out/roformer.onnx` (460,772,871 B), which `KNOWLEDGES.md` records as the shipped fp16 file (not fp32 as earlier labelled).

SDRs are means over 142 clips; deltas are paired bootstrap (2000 resamples, seed 0). Numbers: `results/fast_logs/report.txt`.

## Licence detail

- Kim Vocal 2: unverified. HF card unreachable (401). The UVR README (https://github.com/Anjok07/ultimatevocalremovergui/blob/master/README.md) asks third parties using its models to credit UVR under MIT. That is intent, not a weights licence.
- MDX23C: unverified. ZFTurbo code is MIT (https://github.com/ZFTurbo/Music-Source-Separation-Training). The v1.0.0 release states no weights licence, and the training data is unverified.
- SCNet Tran: unverified. The v1.0.14 release notes say "obtained on MUSDB18 dataset only", and MUSDB18 is non-commercial (https://zenodo.org/records/1117371), so non-commercial in effect (inference). Code MIT (starrytong/SCNet).
- roformer: MIT per the HF card above (summary-level only).
- compat: unverified (not stated in KNOWLEDGES or repo docs).

## Verdicts

- roformer: reference, 735 ms, vocal 9.27 dB.
- compat: 5x faster, 3 dB worse, stays as the GPU-fallback default.
- kim2: faster than roformer by only 15 ms, better than roformer; superseded by kim2_fp16.
- kim2_fp16: best fit for the goal, see recommendation.
- kim2_fp16_t128: best Kim quality (+1.35 dB) but 1143 ms per 3.12 s chunk, i.e. a longer chunk for the same RTF 0.73; viable only if a 3 s delay is accepted.
- scnet_vocals: fastest of the big models by RTF (0.58) and +0.69 dB, but 3.04 s chunk, fp32 only, non-commercial in effect.
- mdx23c_t128_fp16: best quality (+1.55 dB) but RTF 1.04, cannot run live on M1.
- mdx23c_t128: RTF 1.48, cannot run live.

## Recommendation

Ship kim2_fp16: step p50 600 ms vs roformer 735 ms (RTF 0.73 vs 0.82), vocal +1.11 dB [+0.89, +1.34], instrumental +1.08 dB [+0.87, +1.30], 33 MB vs 461 MB. Licence is unverified and must be resolved before shipping. Shipping needs `src/ml/mdx.ts` param changes (currently n_fft 4096, 2048 bins, T=64, compensate 1.0, `src/ml/mdx.ts:15-22`): n_fft 7680 (non-power-of-two, needs Bluestein or another FFT, as in `fast_eval.mjs`), dim_f 3072 bins, T (64 or 128), compensate 1.009. Fallback if a 3 s delay is fine: kim2_fp16_t128 (+1.35 dB).

## Method

- Clips: `spike/clips/wav` 00-49 plus musdb7 = 144 decoded; 2 dropped by name ("PR - Happy Daze", "PR - Oh No"; source `worktrees/All-Mixer-bench/results_all.csv` and `stats.md`); 2 more have a silent vocal reference, so 142 are scored.
- Machine: M1 8 GB, Chrome WebGPU, onnxruntime-web, same streaming code as the app (`src/ml/roformer.ts` and `rof-plan.ts` for roformer, `mdx.ts` for compat, a generic JS STFT adapter for the rest).
- Harness: `spike/bench/fast_eval.mjs`, `fast_prep.py`, `fast_run_all.sh`, `fast_report.py`, `fast_README.md` (meta schema), exporters `export_kim2.py`, `export_mdx23c.py`, `export_scnet_vocals.py`.
- Weights: Kim Vocal 2 https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/Kim_Vocal_2.onnx, params from https://raw.githubusercontent.com/TRvlvr/application_data/main/mdx_model_data/model_data.json keyed by MD5 of last 10 MB 970b3f9492014d18fefeedfe4773cb42 (n_fft 7680, dim_f 3072, dim_t 256 native, compensate 1.009), frames axis made dynamic. MDX23C: ZFTurbo v1.0.0 `model_vocals_mdx23c_sdr_10.17.ckpt` + `config_vocals_mdx23c.yaml`, commit 6fdad13, T=128 export. SCNet: ZFTurbo v1.0.14 `model_scnet_tran_sdr_8.9272.ckpt`, vocals = source 3.
- Reproduce (from worktree root, `PY=/Users/sriv/Space/Repos/All-Mixer/.venv/bin/python`):
  `$PY -I spike/bench/fast_prep.py`, then `bash spike/bench/fast_run_all.sh`, then `$PY -I spike/bench/fast_report.py`.
