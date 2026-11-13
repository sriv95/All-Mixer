# Fast-model streaming bench (spike/bench/fast_*)

One harness, same setup as the app: Chrome WebGPU, onnxruntime-web, the app's own streaming code where it exists.

| Row | Path | Stream code |
|---|---|---|
| `roformer` | High quality, Kim Mel-Band RoFormer, `roformer.onnx` + `roformer-meta.json` | `src/ml/roformer.ts` RoformerStream + `rof-plan.ts` (112 frames) |
| `compat` | Default, MDX-Net `compat-mdx.onnx`, input [1,4,2048,64] | `src/ml/mdx.ts` MdxStream (n_fft 4096, hop 1024, T 64) |
| `<name>` | any other model: STFT outside the graph | generic adapter in `fast_eval.mjs`, driven by `<name>-meta.json` |

Models are looked up in `spike/ml/models/` first, then `$MODELS_OUT` (default main repo `models-out/`). `roformer` and `compat` use `models-out/roformer*` and `models-out/compat-mdx.onnx`.

## `<name>-meta.json` schema (generic adapter)

Sits next to `<name>.onnx`. The graph takes a spectrogram of one chunk and returns a spectrogram (or mask). Everything else (STFT, chunking, cross-fade, iSTFT) is done by the harness in JS. All fields required unless a default is given.

| Field | Meaning |
|---|---|
| `adapter` | `"stft_outside"` (literal) |
| `sr` | sample rate, must be 44100 (clips are 44.1 kHz stereo) |
| `n_fft`, `hop` | STFT size and hop in samples |
| `win` | `"hann"` (periodic, default), `"rect"` (all ones: torch.stft with no window, e.g. SCNet) or `"sqrt_hann"` (analysis and synthesis window); iSTFT divides by sum of squared windows, as `mdx.ts` |
| `frames` | STFT frames per chunk T (graph input is fixed to this). Chunk = `(T-1)*hop + n_fft` samples, no centre padding, 50 % overlap between chunks, periodic-Hann cross-fade (same as `mdx.ts`). Chunk length must be even. |
| `bins` | bins fed to the graph: bin 0 .. `bins-1` (bins above are zero in the output) |
| `layout` | input tensor layout: `"mdx"` = `[1,4,bins,T]`, channels ReL, ImL, ReR, ImR; or `"ch_bins_t_ri"` = `[1,2,bins,T,2]` (L,R; Re,Im last) |
| `out_layout` | output layout, same choices, default = `layout` |
| `out_kind` | `"complex"` (output is the spectrum of the stem) or `"mask"` (real mask, same shape as input, multiplied elementwise onto the Re/Im input) |
| `out_stem` | `"vocals"` or `"instrumental"`. The other stem is `mix - estimate` in time domain |
| `normalized` | optional bool, default false: torch `normalized=True` (spectrum scaled by 1/sqrt(n_fft), output scaled back); needed by SCNet |
| `compensate` | scalar multiplied onto the output spectrum (default 1.0) |
| `dtype` | `"fp32"` or `"fp16"`: dtype of the graph input/output tensors (harness casts fp16 with Uint16 packing via ORT `float16` Tensor) |
| `input_name`, `output_name` | optional, default first input / first output of the graph |

Example (MDX-like): `{"adapter":"stft_outside","sr":44100,"n_fft":4096,"hop":1024,"win":"hann","frames":64,"bins":2048,"layout":"mdx","out_kind":"complex","out_stem":"vocals","compensate":1.0,"dtype":"fp32"}`

## Run

```
# once: writes spike/bench/results/fast_work/clips_{mix,voc,acc}.f32 + clips.json (144 clips, 2 s silence between; 2 flagged silent-ref, so 142 scored)
PY=/Users/sriv/Space/Repos/All-Mixer/.venv/bin/python
$PY -I spike/bench/fast_prep.py
node spike/bench/fast_eval.mjs <roformer|compat|name> [clips=144]    # appends one row to spike/bench/results/fast_bench.jsonl
$PY -I spike/bench/fast_report.py                                  # table, paired delta vs roformer, planner min delay
```

Row fields: `model, clips, hop, chunk_s, step_p50_ms, step_p90_ms, rtf, sdr_v[], sdr_i[]` (per clip, order of `clips.json`), plus `sdr_v_mean`, `sdr_i_mean`. RTF = step p50 ms / (ms of audio the step emits).

n_fft need not be a power of two (Bluestein in `AnyFFT`, kim2 n_fft 7680).
