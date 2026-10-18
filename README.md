# All Mixer!

Chrome extension (Manifest V3) for youtube.com and music.youtube.com.

## Build

```sh
bun install
uv sync            # Python env for the model scripts (.venv, from pyproject.toml)
bun run fetch-model      # public/ml/vocals.onnx + mdx.onnx (needed to build)
bun run export-roformer  # models-out/{roformer,deux}.onnx, optional: only to publish a new model version (~1.4 GB of checkpoints, ~1 min each)
bun run build      # typecheck + vite build → dist/
bun run test       # unit tests (vitest + happy-dom)
bun run lint
```

Use `bun run test`, not `bun test`. `bun test` starts Bun's own test runner; this repo uses vitest.

## Load in Chrome

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → pick the `dist/` folder.
3. Reload any YouTube / YT Music tabs that were open before loading.
4. Click the toolbar icon on a YouTube tab.

## Layout

| Path | What |
|---|---|
| `public/manifest.json` | MV3 manifest (copied to `dist/`) |
| `src/background/` | Service worker. Per-tab settings in `chrome.storage.session` (`tab:<id>`), forwards changes to the tab |
| `src/content/content.ts` | Content script entry (built as one IIFE by `vite.content.config.ts`) |
| `src/content/youtube-dom.ts` | **All** YouTube / YT Music selectors and SPA events (risk R3). Change selectors only here |
| `src/content/audio/` | Default-mode graph: `<video>` → MediaElementSource → Gain (0–6×) → limiter (compressor + soft clipper, ceiling ≈ −0.2 dBFS) → output |
| `src/popup/` | Popup: Default / Separate tabs |
| `src/shared/` | Settings model and message types |

## Notes

- Page audio is untouched until the master slider leaves 100 %. After that the `<video>` stays routed through Web Audio for the life of the tab (Web Audio cannot undo this); 100 % is unity gain.
- If Chrome's autoplay policy keeps the AudioContext suspended, the extension waits for one click / key press on the page before routing audio, so the video is never muted. The popup shows a hint.
- Settings are per browser tab and survive SPA navigation and reloads; they are cleared when the tab closes.
- Separate mode uses the ML engine (MDX-Net 9482 vocal model plus a Spleeter mask for Karaoke, on WebGPU; 1.97 s audio delay, the video is delayed to match). Until it is running, or when it cannot run, the original mix plays and the popup says why.
- Separate tab, Model menu (experimental): "Default" is MDX-Net + Spleeter. "High quality" is a Mel-Band RoFormer (unwa's `mel_band_roformer_kim_ft_unwa`, 440 MB) and "Best quality" is becruily's Deux (240 MB, 12 layers, vocal stem only; needs a good GPU: ~1.0 s per step for 1.1 s of audio on an M1, so it cannot keep up there at any delay and reports "too slow on this device"). Each replaces MDX-Net and Spleeter with one fp16 transformer and gives a cleaner voice/instrumental split; 1.99 s delay. They are not in the extension package: the popup offers a one-time download of the selected model from the public Hugging Face repo `MODEL_BASE_URL` (`src/shared/model-store.ts`) into the extension's own storage (OPFS), and an Update button when the repo's `manifest.json` names a newer version of it. Geometry per model is in `src/worklet/protocol.ts` (`GEOMETRY`); the STFT, mask scatter and iSTFT are in `src/ml/roformer.ts`. `spike/bench/rof_bench.mjs <model> <frames> <inputs>` times an exported core on WebGPU.
- RoFormer chunk length (Separate tab, Advanced section, shown for High / Best quality): the model sees a chunk of audio per step. The **Delay limit** slider (2 to 15 s, 1 s steps, default 2 s) is a ceiling: the audio delay (and the picture delay) never exceeds it, and the planner (`src/ml/rof-plan.ts`) picks the longest block that fits the limit and that this GPU keeps up with. A longer limit gives the model more context (a longer chunk separated violin from the vocal better in testing). Pressing **Apply** after moving it restarts the warm-up (10 to 40 s; the original mix plays meanwhile). The picture delay queue shrinks the video resolution to stay within its memory budget at long delays. Measured on an M1 (Kim FT): 2 s = 1.15 s chunk, 6 s = 3.4 s chunk, 15 s = 7.8 s chunk. If the GPU cannot keep up at the chosen limit the popup says so.

## Publish a new RoFormer model version

The models (`roformer` = High quality, `deux` = Best quality) are not in the extension; users download them from the public Hugging Face repo `sriv95/all-mixer-models` (`MODEL_BASE_URL` in `src/shared/model-store.ts`). Every model has its own version in `manifest.json`; users get an Update button in the popup when it names a newer one for that model. No extension release is needed, unless the file contract changed (see below).

```sh
uvx --from huggingface_hub hf auth login          # once; needs a token with write access
bun run export-roformer [roformer|deux] [--force] # models-out/<name>.onnx + <name>-meta.json (new weights: edit the checkpoint in scripts/export-roformer.py)
bun run model-manifest roformer=2 deux=2          # every model with its version (the new one bumped) -> models-out/hf/manifest.json + v<n>/
uvx --from huggingface_hub hf upload sriv95/all-mixer-models models-out/hf/v2 v2    # new version folder first
uvx --from huggingface_hub hf upload sriv95/all-mixer-models models-out/hf/manifest.json manifest.json   # manifest last
```

- Upload the manifest last: users are offered the update as soon as it names the new version. A manifest in the old single-model shape (extension builds before 2026-10-18) is not understood. Format 2 (the `frames` axis of the graph is dynamic) needs this extension version or later; extension builds with format 1 keep the model they have installed and show "needs a newer version" for a first download.
- Old `vN/` folders can stay in the repo; the extension only downloads the version that `manifest.json` names.
- If the new model changes the contract with `src/ml/roformer.ts` (chunk length, mel bands, graph inputs/outputs), bump `MODEL_FORMAT` in `src/shared/model-store.ts` and `FORMAT` in `scripts/model-manifest.mjs`, and release the extension first. Extensions with another format ignore the manifest and show "needs a newer version" instead of updating.
- Check the weights' license before publishing (the repo is public). Deux is CC BY-NC 4.0: non-commercial, with attribution (the repo's model card says so). Test with `chrome.storage.local.set({'debug.modelBaseUrl': 'http://localhost:8765'})` in the service-worker console against a local static server with CORS and Range support.

## Debug

- Force ML deadline misses (QA): in the extension service-worker console run `chrome.storage.local.set({'debug.mlStallMs': 400})`, then reload the YouTube tab. After `debug.mlStallAfterMs` (default 5000 ms, after warm-up) every ML block is held 400 ms, far past the block deadline, so 3 misses happen within about 2 s. Clear with `chrome.storage.local.remove(['debug.mlStallMs','debug.mlStallAfterMs'])`.
- ML timing log (QA): either `localStorage['all-mixer-ml-timing']='1'` on the ml.html page (iframe console), or `chrome.storage.local.set({'debug.mlTiming': true})`, then reload the YouTube tab. Also logs the warm-up p50/p90/p95 (gate on p90) on every start, pass or fail, with `retry` when the second attempt was needed. For a RoFormer it also logs the planned chunk, block, overlap and delay, and the RMS of every vocal block against its input block (`NOT FINITE` = broken output).

## Release

1. Add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md`.
2. Set the same `version` in `package.json` and push to `main`.

`.github/workflows/release.yml` then builds the extension, creates tag `vx.y.z` and a GitHub release with `all-mixer-vx.y.z.zip` and the changelog section as notes. The build writes the `package.json` version into `dist/manifest.json`, so do not edit the version in `public/manifest.json`. The version must be 1–4 dot-separated numbers (Chrome rule; no `-beta`). If the tag already exists, the workflow does nothing. To re-run by hand: Actions → Release → Run workflow.
