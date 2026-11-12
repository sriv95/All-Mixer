# Model benchmark kit

Offline model comparison on CPU. The Python ports replay the app's streaming path (`src/ml/roformer.ts`, `mdx.ts`); they match the app's TS path within 0.01 dB (checked with `stream_eval*.mjs`).

Run from a scratch work dir (outputs land in cwd), with `PY=<repo>/.venv/bin/python` (`uv sync`) and `K=<repo>/spike/bench/kit`. Models come from `$MODELS_OUT` (default `<repo>/models-out`); the model's `<name>-meta.json` must sit next to `<name>.onnx`. Clips come from `<repo>/spike/clips/wav/NN/{mix,vocals,...}.wav` (gitignored).

| Script | Purpose |
|---|---|
| `bench.py` | One single-stem RoFormer (`roformer`, `deux` or a .onnx path) at N frames: writes vocal wav, prints load/RTF/RSS. |
| `bench_sw.py` | Same for the 6-stem `sw` model: writes `PREFIX_<stem>.wav` for every stem. |
| `bench_compat.py` | Same for the MDX `compat-mdx.onnx` (vocal stem; instrumental = mix - vocal). |
| `bench_all.py` | Resumable paired run, deux 112/224 and sw 112/256, over spike clips (set A) and `clips_musdb` (set B): CSV of SDR, SI-SDR, bleed. |
| `stats.py` | Paired deux-vs-sw tables and bootstrap CI from the `bench_all.py` CSV. |
| `score_sw.py` | Per-stem SDR plus sum-of-stems check for `bench_sw.py` output (needs `mix.wav`, `vocals.wav`, `drums|bass|other.wav` in cwd). |
| `sdr.py` | Whole-signal SDR of `est.wav` against `ref.wav`. |
| `prep_musdb.py` | Decodes `spike/clips/musdb7/*.stem.mp4` (needs ffmpeg) into `clips_musdb/<name>/{mix,vocals}.wav`, dropping duplicates of set A. |
| `mkinput.py` | Concatenates clips 00..04 into `mix.wav` + `vocals.wav` (the long benchmark input). |
| `mkrefs.py` | Writes `drums|bass|other.wav` and `instr.wav` references (run after `mkinput.py`). |
| `plan_table.ts` | Planner table (latency, chunk, keeps-up, CPU SDR) from GPU step times, using the app's `rof-plan` / `mdx-plan`. |

## (a) CPU chunk sweep for one model
```sh
K=spike/bench/kit; PY=.venv/bin/python; mkdir -p ~/bench-work && cd ~/bench-work   # K/PY must then be absolute
$PY $K/mkinput.py
for F in 56 112 224 336; do $PY $K/bench.py deux $F cpu out_$F.wav mix.wav && $PY $K/sdr.py vocals.wav out_$F.wav; done
```
For `sw`: `$PY $K/bench_sw.py 112 cpu out mix.wav && $PY $K/mkrefs.py && $PY $K/score_sw.py out`. For MDX: `bench_compat.py 64 out.wav mix.wav`.

## (b) Paired deux-vs-sw comparison over spike/clips
```sh
$PY $K/prep_musdb.py                                   # optional set B, writes ./clips_musdb
$PY $K/bench_all.py results_all.csv out [limit] .      # resumable; 4th arg = dir holding clips_musdb
$PY $K/stats.py results_all.csv stats.md out           # needs pandas
```

## (c) Planner table from GPU step times
`gpu_steps.json` is `{model: {frames: {p50, p95, first}}}` per model (roformer, deux, sw, compat), measured on the target GPU. Optional `table.md` / `results_compat.log` / `results_sw.log` in the work dir fill the SDR column; missing files leave it empty.
```sh
BENCH_DIR=. bun $K/plan_table.ts gpu_steps.json
```
