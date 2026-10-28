# Preload Audio mode: design and decision

## Problem

Live Separate mode runs the ML model against the clock. A GPU that is too slow misses block deadlines, the engine stops
("ML missed its deadline", `EngineSelector` state `stopped`) and the original mix plays. The user has no way to still get
separated sound from that device.

## What we want

On that error, offer **Preload Audio**: process the whole clip up front, keep only the audio, play from that cache. No deadline,
so a slow GPU works; it only takes longer before playback. The Advanced section gets a Live / Preload switch to go back.
Preload mode also points to the Export section.

## Options

| | A. Reuse the MP3 path (record, separate, mix, encode MP3, `decodeAudioData`, play) | B. Same pipeline, stems kept as PCM in memory | C. Fetch the media and decode it offline |
|---|---|---|---|
| Quality | Lossy: 192 kbps MP3 encode and a decode, on top of the model | Lossless (Float32) | Lossless |
| Speed | Record (real time) + lamejs encode (slow, runs on the page thread) + decode | Record (real time) only | Faster than real time |
| Memory | Blob + decoded buffer + stems in flight | Stems as `AudioBuffer`: 0.35 MB/s per stem | Same as B |
| Live levels (vocal/instrumental sliders) | No: the mix is baked in, a slider needs a new export | **Yes**: the stems are cached, the player mixes with the live formula | Yes |
| Complexity | Low code, but two codecs and a round trip for nothing | Low: one sink replaced by a callback | High, and not possible (below) |
| Works on YouTube | Yes | Yes | **No**: the player feeds MSE (`blob:` URL); the stream URLs are signed and rotating, and fetching them is both fragile and against the site's terms |

Other ideas rejected: caching the already mixed result (levels would need a re-run), persisting the cache to OPFS/IndexedDB
(not asked; the page-memory cache dies with the tab, which is what "cache" means here), driving the existing worklet from the
cache (keeps its 2 s delay, needs a media-time to stream-position map that seeks and pauses would break).

## Decision: B

* **Reuse the export engine's recording and separation unchanged** (`runExport` core: `captureStream` recording in 15 s chunks,
  `OfflineSeparator` with the context running across chunk borders, backlog back-pressure that pauses the video when the model
  is behind). The only change is the sink: instead of mixing and encoding, `onSlice` receives every `StemSlice`.
* **Cache stems, not a mix.** `stemsOfSlice` (`src/export/mix.ts`, beside `mixSlice`) turns a slice into the same stems the
  Export "Separate tracks" mode names (`vocals`, parts, `others` / `instrumental`). They go raw into one `AudioBuffer` per stem
  (44.1 kHz, the model and context rate, so no resampler). No limiter at this stage; the live chain's limiter is after the mix.
* **Play with a small `PreloadPlayer`**: one `AudioBufferSourceNode` per stem, each through a gain node
  (`vocal`, `instrumental · part`, `instrumental · others`, the live formula of the worklet and `mixSlice`) into a new bus of
  `MasterChain`, so the global volume and the limiter still apply. It follows the `<video>` (play, pause, seek, waiting, ended)
  and resyncs on drift above 80 ms. The page's own audio path is muted while the cache plays (gain 0 on `direct`).
* The picture-delay overlay already matches the graph's device latency in Separate mode; the cache adds no processing delay.

### Cost and limits (said in the UI)

* Preload takes about the length of the clip (the recording is real time, muted, from 0:00; the model keeps up or the video waits).
  It cannot be faster on YouTube (option C). The export has the same cost.
* Memory: `stems × length × 0.35 MB/s` (2 stems, 4 min = 170 MB; Focus Instrumental Splitting has 6 stems). Above
  `PRELOAD_MAX_BYTES` (900 MB) the start is refused with the numbers; the banner then offers **Export instead** (opens the Export section, which does not keep the stems in memory) and Use Live mode.
* Pitch shift does not apply to the cache (shortcut: the pitch stage lives in the live worklet). Speeds other than 1× play the
  original audio. An ad (different length) plays the original audio. Both are shown in the popup when they happen.
* The cache is per video (`v=` id + length) and per model / split setting; changing the split switches or model marks it
  "preloaded with other settings" and offers a new preload. It is dropped when the tab goes to another video.

## UX

* Banner `stopped` / too slow: new button **Switch to Preload Audio**.
* Preload mode: banner with a progress bar and the small detail text (`Chunk 3/14 · 0:42 / 3:30 · 2 of 14 processed`),
  **Cancel**; when ready "Playing from the preloaded audio"; on error the reason with **Try again** / **Use Live mode**.
* Advanced: **Processing** switch, Live | Preload audio.
* Preload mode opens the Export section (it is always in the Separate tab; here it is revealed and the banner points at it).
* Preload and export both record the video, so one runs at a time.

## Test plan

Unit: `stemsOfSlice`, settings normalisation, status/view, player scheduling with fake nodes, runner state machine.
Browser (Playwright + built extension on youtube.com): stall the model (`debug.mlStallMs`) to get the real "missed deadline",
click the new button, watch the progress, check playback from the cache (player state, audio level, drift), toggle back to
Live, check the Export section. Screenshots in the PR.
