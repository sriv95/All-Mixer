# SRI-219: offline MDX vs in-Chrome MDX on "lovely" (why 11.7 dB vs 31 dB?)

Offline: `spike/ml/mdx_stream.py` `separate()` (T=64) on the SRI-211 Default capture (`qa203-lovely-reference.st.f32`, 44.1 kHz stereo, 60 s).
Chrome: `src/ml/mdx.ts`, `src/ml/pipeline.ts`, `src/ml/ml-worker.ts`, `src/worklet/core.ts` (read only) and the SRI-203 acappella capture (`scripts/qa-sri203-result.json`).
Scripts: `spike/ml/sri219_sweep.py`, `sri219_overlap.py`, `sri219_report.py`; results `scripts/qa-sri219-*.json`.

## Finding
**The two numbers differed because SRI-209 measured the wrong frames, not because of a Chrome-only factor.**
The SRI-209 run used `t0 = 69.033` (videoSec0 of the SRI-211 capture) for the dip times (102.5 … 127.75), which are on the SRI-203 clock (`sec0 = 71.5387`). Both captures hold the same audio at the same *clip* index (frame-by-frame best lag = 0 frames, mean sq. error 6 dB²), so the video stamp of the SRI-211 capture is 2.5 s too early. SRI-209 therefore looked 2.5 s before the real dip frames. With `t0 = 71.5387`, the same offline stream gives **32.1 dB at 126.0 s** (Chrome: 31 dB).
Second reason the SRI-203 offline stem showed no dip: it used a different segment-grid phase (see sweep: at shift 384/512 the 126.0 frame is -25 dB, at shift 0/128 it is -51 dB; Chrome -50.0).

## 1. Differences, offline stream vs Chrome runtime
| Item | Offline `mdx_stream.py` | Chrome runtime | Same? |
|---|---|---|---|
| Segment T / length | T=64, N=68608 | `MDX_T=64`, `MDX_SEGMENT=68608` | yes |
| STFT | n_fft 4096, hop 1024, periodic Hann, no centre pad, float64 | same, Float64 FFT, input tensor float32 | yes |
| Hop / cross-fade | hop N/2, periodic Hann over N, sums to 1 | `ML_BLOCK=N/2`, `cw` periodic Hann over N, tail added | yes |
| iSTFT norm | scipy NOLA (1/Σw², edges left as is) | `norm` = 1/Σw² where >1e-10 else 1 | yes |
| DC / Nyquist | bin 2048 = 0, DC imag dropped | same (`k>0`) | yes |
| Start phase | left pad H, segment grid at clip sample 0 | grid starts at `streamStart` = worklet `pos` when ML engages (arbitrary vs the music; reset on seek/play) | **no** |
| Sample rate | 44.1 kHz | ML refused unless ctx = 44.1 kHz (`mlAllowed`), no resampler | yes |
| Input level | capture as is | pre-gain mix; the capture has master 101 % (x1.01) | ~ (0.09 dB) |
| Channels | stereo (L,R) | stereo (L,R) | yes (SRI-203 offline used mono-dup) |
| Model numerics | CPU ORT fp32 | WebGPU EP, Metal, fp32 weights (same model file bytes class) | not emulable; checked by data |
| Chunk boundaries | whole clip at once | 128-sample quanta into 34304-sample blocks, transferred without copy; misses 0, posted 104 / returned 102 (2 in flight at end) | yes (no loss) |
| Worker reset | none | `pipeline.reset()` on epoch/start mismatch (none seen: misses 0) | n/a |
| Normalisation | none | none | yes |
| Phase of Chrome acappella run | n/a | est. from wl `posted` events: 130-ish samples (min over 80 events; upper bound, 93 ms sampling) | ≈ shift 0 |

## 2. Emulated offline (same metric as SRI-209, 12 times 102.5-127.75 s on the SRI-203 clock; dip = max of V dB within ±4 frames − V dB at the frame)
Chrome reference frame (126.03 s): -50.0 dB (SRI-203 acappella tap). `gap` = mean |offline − Chrome| over 125.78-126.53 s.
| Config | Worst dip (dB) | at | V @126.03 (dB) | gap 125.8-126.5 (dB) | Reproduces Chrome |
|---|---|---|---|---|---|
| shift 0 (Chrome-like phase) | 32.1 | 126.0 | -50.9 | 1.2 | **yes** |
| shift 128 | 30.6 | 126.0 | -49.5 | 0.8 | yes |
| shift 256 | 22.7 | 104.5 | -39.5 | 5.7 | partly (dip 22.7) |
| shift 384 | 22.1 | 104.5 | -25.2 | 12.5 | dip ≥20 at 104.5, not at 126 |
| shift 512 | 21.9 | 104.5 | -24.2 | 13.6 | dip ≥20 at 104.5, not at 126 |
| shift 768 | 22.1 | 104.5 | -37.2 | 6.2 | partly |
| shift 2048 / 4096 / 6800 / 8700 | 22.1 / 23.1 / 25.0 / 23.1 | 104.5 / 126.0 / 126.3 / 104.3 | -34.9 / -41.8 / -40.9 / -25.9 | 8.3 / 5.1 / 4.7 / 12.5 | dip ≥20 at every phase |
| shift 12000 / 17152 / 22000 / 28000 | 29.2 / 33.1 / 25.9 / 24.0 | 126.0 | -48.1 / -52.5 / -44.8 / -42.9 | 2.3 / 1.0 / 4.7 / 7.4 | yes at 12000, 17152 |
| input gain 1/1.01 (shift 0) | 32.3 | 126.0 | -51.2 | 1.1 | yes (level is not a factor) |
| input rounded to fp16 (shift 0) | 32.1 | 126.0 | -50.9 | 1.2 | yes (no change) |
| mono (L=R=mean) | 38.6 | 126.0 | -59.1 | 7.1 | deeper, not Chrome |
| 75 % overlap (hop N/4), shift 0 | 33.1 | 126.0 | -52.2 | 0.9 | dip stays |
| 75 % overlap, shift 512 / 2048 | 21.8 / 23.0 | 104.5 / 126.3 | -30.1 / -40.3 | 9.2 / 5.0 | dip stays |
Over all 229 Chrome frames in the clip, median |offline shift0 − Chrome| = 0.38 dB (SRI-203 rows vs `sri219` shift 0).

Caveat: Chrome's real grid phase is only known as "≈0 to a few thousand samples" (worklet stats are sampled every 93 ms). shift 0 and 128 match Chrome best; I did not test finer than the list above.

## 3. Factors
| Factor | Offline worst dip | Reproduces Chrome |
|---|---|---|
| Wrong frame times in SRI-209 (t0 69.033 instead of 71.5387) | 32.1 (was 11.7) | **yes, this was the gap** |
| Segment grid phase | 21.9-33.1 over 14 phases; at 126 s frame V ranges -24 … -52 | yes (decides how deep the 126 s dip is) |
| Input level (x0.990) | 32.3 | no effect |
| fp16 input rounding | 32.1 | no effect |
| 75 % overlap | 21.8-33.1 | no effect on the dip |
| Mono vs stereo | 38.6 | no (worse) |
| Sample rate, T, window, normalisation, chunking, drops | identical by code read; Chrome misses 0 | n/a |
Remaining Chrome-only items (not emulable offline): WebGPU/Metal kernel numerics. Data say they are not needed: median 0.38 dB difference over 229 frames. Shadow need not test them for this issue.

## Recommendation
No Chrome-only factor: the deep dips (22-33 dB at 104.5 and 126.0 s on this clip) are the MDX model's own output for those contexts, deeper or shallower by segment grid phase, and not fixed by more overlap, level, or fp16. Change the vocal source for those frames (e.g. a model/ensemble decision for Marquess), not the window or level. 

Side result (corrected frames, `scripts/qa-sri219-filldip-t0fix.json`, SRI-209 variants on t0 71.5387): base worst dip 32.1; dip-fill variants 18.3-21.5 dB, but pause leak mean 2.1-5.2 dB, max 16.3-23.7 dB. So SRI-209's "dip fill does not help" does not hold on the right frames: it cuts the dip by 10-14 dB at the cost of leak in pauses (needs a gate; SRI-209's PAUSE times are also on the SRI-203 clock and were used with the same wrong t0 there, so SRI-209 leak numbers are for wrong frames too).
