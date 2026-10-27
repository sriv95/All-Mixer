# All Mixer! (developer notes)

Technical notes for developers. The user-facing README is [../README.md](../README.md).

Chrome extension (Manifest V3): volume boost and Separate mode on any site; synced lyrics on youtube.com and music.youtube.com.

## Build

```sh
bun install
uv sync            # Python env for the model scripts (.venv, from pyproject.toml)
bun run fetch-model      # public/ml/vocals.onnx + mdx.onnx (needed to build)
bun run export-roformer  # models-out/{roformer,deux,sw,guitar}.onnx, optional: only to publish a new model version (~1.4 GB of checkpoints, ~1 min each)
bun run export-scnet     # models-out/drums.onnx (SCNet Tran Small, the Split instrumental model; ~170 MB checkpoint + the training repo, pinned)
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
| `src/popup/` | Popup (React + Tailwind): Global Volume, Default / Separate tabs, state banner |
| `src/shared/` | Settings model and message types |

## Notes

- Page audio is untouched until the master slider leaves 100 %. After that the `<video>` stays routed through Web Audio for the life of the tab (Web Audio cannot undo this); 100 % is unity gain.
- If Chrome's autoplay policy keeps the AudioContext suspended, the extension waits for one click / key press on the page before routing audio, so the video is never muted. The popup shows a hint.
- Settings are per browser tab and survive SPA navigation and reloads; they are cleared when the tab closes.
- Separate mode uses the ML engine (MDX-Net 9482 vocal model plus a Spleeter mask for Karaoke, on WebGPU; 1.97 s audio delay, or longer with the Delay limit in Advanced, see below; the video is delayed to match). Until it is running, or when it cannot run, the original mix plays and the popup says why.
- GPUs without WebGPU `shader-f16` (AMD Polaris, e.g. RX 590): the packed Default models and the RoFormers are fp16, so ORT's WebGPU EP fails there ("Program Transpose requires f16"). `ml-worker.ts` checks `adapter.features` first. The Default model then loads the downloaded fp32 `compat` model (`compat-mdx.onnx` + `compat-vocals.onnx`, from `bun run export-compat`, hosted like the other downloads; the popup shows "Download supported models" via `hasShaderF16` in `src/shared/gpu.ts`); every other vocal model and the Guitar split report "not supported on this GPU". Drums (SCNet) is fp32 and works. Tested on an RX 590.
- Separate tab, Model menu (experimental): "Default" is MDX-Net + Spleeter. "High quality" is a Mel-Band RoFormer (unwa's `mel_band_roformer_kim_ft_unwa`, 440 MB) and "Best Vocal" is becruily's Deux (240 MB, 12 layers, vocal stem only; needs a good GPU: ~1.0 s per step for 1.1 s of audio on an M1, so it cannot keep up there at any delay and reports "too slow on this device"). Each replaces MDX-Net and Spleeter with one fp16 transformer and gives a cleaner voice/instrumental split; 1.99 s delay. They are not in the extension package: the popup offers a one-time download of the selected model from the public Hugging Face repo `MODEL_BASE_URL` (`src/shared/model-store.ts`) into the extension's own storage (OPFS), and an Update button when the repo's `manifest.json` names a newer version of it. Geometry per model is in `src/worklet/protocol.ts` (`GEOMETRY`); the STFT, mask scatter and iSTFT are in `src/ml/roformer.ts`. `spike/bench/rof_bench.mjs <model> <frames> <inputs>` times an exported core on WebGPU.
- Focus Instrumental Splitting (fourth Model entry, `sw`): BS-RoFormer SW (jarredou's `BS-ROFO-SW-Fixed`, 6 stems: bass, drums, other, vocals, guitar, piano; 175M parameters, depth 12, 62 bands, STFT hop 512; 343 MB fp16 core, `scripts/export-roformer.py sw`) separates everything in one pass, instead of the vocal model plus the drum and guitar stages. `RoformerStream` (`src/ml/roformer.ts`) takes the hop and the number of stems from the model's meta (`stems` lists them), and `startRoformer` in `src/ml/ml-worker.ts` plans it like the other RoFormers (`planRof(…, hop)`; its speed is measured at 112 frames of hop 512, `SW_BASE_GEOMETRY`). The reply buffer has 12 planes (the vocal pair twice as for the other models, then drums, guitar, bass, piano: `PARTS`, `planesFor`), and the worklet mixes `ig · (dg · drums + gg · guitar + ag · bass + pg · piano + og · (instrumental − those))`; the Drums, Guitar, Bass, Piano and Others sliders all apply, and the Drums / Guitar switches of Split instrumental are not available with this model (the popup says so). Its cost per second of audio is about that of Best Vocal alone (an M1: 1.25 s per step for 1.3 s of audio, so it cannot keep up there; against a one-pass torch estimate the streamed stems agree at 14 to 21 dB for the vocal, drums, bass and guitar and 6 dB for the piano, `spike/bench/sw_stream_eval.mjs`). The weights have no stated licence (the model card in the Hugging Face repo says so); the repo owner decided to host them. Research: `spike/bench/sw_export.py`, `sw_bench.py` (vocals match deux / Kim, drums beat SCNet Tran by about 1 dB on the MUSDB clips), `sw_chunk.py` (short chunks), `mega_bench.py` (MVSep Mega 53 single-stem guitar models behave like SW's guitar).
- Chunk length (Separate tab, Advanced section): the model sees a chunk of audio per step. The **Delay limit** slider (2 to 15 s, 1 s steps, default 2 s) is a ceiling: the audio delay (and the picture delay) never exceeds it, and the planner (`src/ml/rof-plan.ts`) picks the longest block that fits the limit and that this GPU keeps up with. A longer limit gives the model more context (a longer chunk separated violin from the vocal better in testing). Pressing **Apply** after moving it restarts the warm-up (10 to 40 s; the video is paused meanwhile and resumes by itself). The picture delay queue shrinks the video resolution to stay within its memory budget at long delays. For the Default model the same slider sets the MDX segment (`src/ml/mdx-plan.ts`): 64 frames (1.97 s delay) up to 256 (about 6.5 s) in steps of 32 (the U-Net needs a multiple of 32), the longest whose delay fits the limit and whose step the GPU keeps up with (linear in the frames; a slower one than predicted falls back to 64). A limit under 3 s gives the shipped segment. Measured on an M1 (Kim FT): 2 s = 1.15 s chunk, 6 s = 3.4 s chunk, 15 s = 7.8 s chunk. If the GPU cannot keep up at the chosen limit the popup says so.
- Split instrumental (Separate tab, Advanced section, off by default): a drum stage (`src/ml/scnet.ts`, `src/ml/drum-engine.ts`) wraps the vocal engine in the ML worker. It runs SCNet Tran Small (ZFTurbo's Music-Source-Separation-Training, `scripts/export-scnet.py`, one fp32 graph of a fixed 128-frame / 2.94 s chunk, 41 MB, downloaded like the RoFormers as model `drums`) on the instrumental (input minus the vocal block). Chunks overlap by 0.49 s with a cross-fade; a result waits up to one chunk for its drums (`SC_LAG`), so the vocal planes are held back by the same amount and the block buffer carries two more planes (drums L / R, `MlGeometry.drums`). The worklet outputs the drums as a part of the instrumental: `ig · (dg · drums + og · (instrumental − drums))` (`separator-processor.ts`). Default model: block and offset as before plus `SC_LAG`, delay about 6.2 s on an M1 (`planMdxDrums`); RoFormers: `planRof(…, drumMs)` charges the drum runs to the step and adds `SC_LAG` on top of the Delay limit, so they need a fast GPU (an M1 cannot keep both in real time: High quality 0.72 s + drums 0.82 s per 1.1 s of audio). Drums SDR on 10 MUSDB clips (ideal instrumental in): 9.3 dB at 11 s chunks, 8.3 dB at the 3 s used here; SCNet large is better (10.8 dB) but its LSTM has no WebGPU kernel (40 s for an 11 s chunk on an M1), so it was dropped. Benchmarks and checks: `spike/bench/drums_bench.py`, `scnet_webgpu_parity.mjs`, `scnet_stage_eval.mjs` (inputs from `scnet_dump.py`).

## Publish a new RoFormer model version

The models (`roformer` = High quality, `deux` = Best Vocal, `sw` = Focus Instrumental Splitting, plus the drum and guitar split models) are not in the extension; users download them from the public Hugging Face repo `sriv95/all-mixer-models` (`MODEL_BASE_URL` in `src/shared/model-store.ts`). Every model has its own version in `manifest.json`; users get an Update button in the popup when it names a newer one for that model. No extension release is needed, unless the file contract changed (see below).

```sh
uvx --from huggingface_hub hf auth login          # once; needs a token with write access
bun run export-roformer [roformer|deux|sw|guitar] [--force] # models-out/<name>.onnx + <name>-meta.json (new weights: edit the checkpoint in scripts/export-roformer.py)
bun run model-manifest roformer=2 deux=2 sw=1 drums=1 guitar=1  # every model with its version (the new one bumped) -> models-out/hf/manifest.json + v<n>/ (the drum model is one file, drums.onnx; bun run export-scnet makes it)
uvx --from huggingface_hub hf upload sriv95/all-mixer-models models-out/hf/v2 v2    # new version folder first
uvx --from huggingface_hub hf upload sriv95/all-mixer-models models-out/hf/manifest.json manifest.json   # manifest last
```

- The drum model (`drums`, version 1) is one file: `uvx --from huggingface_hub hf upload sriv95/all-mixer-models models-out/hf/v1/drums.onnx v1/drums.onnx`, then the manifest. Its checkpoint (ZFTurbo's `model_scnet_tran_sdr_8.9272.ckpt`) has no license text of its own (the training repo is MIT): confirm it before the repo goes public with it.
- Upload the manifest last: users are offered the update as soon as it names the new version. A manifest in the old single-model shape (extension builds before 2026-10-18) is not understood. Format 2 (the `frames` axis of the graph is dynamic) needs this extension version or later; extension builds with format 1 keep the model they have installed and show "needs a newer version" for a first download.
- Old `vN/` folders can stay in the repo; the extension only downloads the version that `manifest.json` names.
- If the new model changes the contract with `src/ml/roformer.ts` (chunk length, mel bands, graph inputs/outputs), bump `MODEL_FORMAT` in `src/shared/model-store.ts` and `FORMAT` in `scripts/model-manifest.mjs`, and release the extension first. Extensions with another format ignore the manifest and show "needs a newer version" instead of updating.
- Check the weights' license before publishing (the repo is public). Deux is CC BY-NC 4.0: non-commercial, with attribution (the repo's model card says so). Test with `chrome.storage.local.set({'debug.modelBaseUrl': 'http://localhost:8765'})` in the service-worker console against a local static server with CORS and Range support.

## Debug

- Guitar split (Separate tab, Advanced > Split instrumental): a Guitar switch next to the Drums one, on its own or together with it. The guitar model is becruily's [`mel-band-roformer-guitar`](https://huggingface.co/becruily/mel-band-roformer-guitar) (guitar stem only, 45 MB, model `guitar` in the model repo, downloaded like the drum model; no licence stated, the author says free for non-commercial use only). `src/ml/guitar-stage.ts` runs the model on the instrumental (input minus the vocal, like the drum stage, so the two stages work in parallel); the reply buffer carries a plane pair per stage (drums, then guitar; `MlGeometry.drums` / `.guitar`, `planesFor`), `withStages` (`drum-engine.ts`) waits for the stage with the longest lag, and the worklet mixes `ig · (dg · drums + gg · guitar + og · (instrumental − drums − guitar))` (Drums, Guitar and Others sliders). The model needs a long chunk (against a one-pass estimate: about 5 dB SDR at 0.9 s, 9 dB at 5.9 s, 11 dB at 9.9 s), so the chunk is 5.5 s whatever the Delay limit (a 10 s chunk doubles the run, which the slack of every plan has to cover, and failed the plan on GPUs that keep up with 5.5 s); the stage adds its block plus 0.5 s to the delay on top of it (about 6 s with the default limit). A run (5.5 s block on an M1: 2.4 s guitar, 0.9 s drums) stops the ML block loop (ORT's WebGPU EP cannot run two sessions at once), so the planners (`planRof`, `planMdxDrums`) take the stages as a list, count their runs in the slack and refuse a GPU that cannot keep up (an M1 cannot do drums and guitar together: "too slow for the split"), and the worklet gets a bigger block pool (`MlGeometry.pool`). It was picked over chenCFD's `Guitar_Source_Separation` model (136 MB, hop 512): cleaner by the proxies, 1.5× faster, and less hurt by short chunks (`spike/bench/results/guitar.jsonl`). `bun run fetch-guitar` exports the model and serves it locally for QA (`debug.modelBaseUrl`). Benchmarks: `spike/bench/guitar_bench.py` (proxies on the MUSDB clips, no guitar ground truth), `guitar_ref.py` + `guitar_stage_eval.mjs` (the stage on WebGPU against a one-pass torch estimate).
- Force ML deadline misses (QA): in the extension service-worker console run `chrome.storage.local.set({'debug.mlStallMs': 400})`, then reload the YouTube tab. After `debug.mlStallAfterMs` (default 5000 ms, after warm-up) every ML block is held 400 ms, far past the block deadline, so 3 misses happen within about 2 s. Clear with `chrome.storage.local.remove(['debug.mlStallMs','debug.mlStallAfterMs'])`.
- ML timing log (QA): either `localStorage['all-mixer-ml-timing']='1'` on the ml.html page (iframe console), or `chrome.storage.local.set({'debug.mlTiming': true})`, then reload the YouTube tab. Also logs the warm-up p50/p90/p95 (gate on p90) on every start, pass or fail, with `retry` when the second attempt was needed. For a RoFormer it also logs the planned chunk, block, overlap and delay, and the RMS of every vocal block against its input block (`NOT FINITE` = broken output).

## Release

1. Add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md`.
2. Set the same `version` in `package.json` and push to `main`.

`.github/workflows/release.yml` then builds the extension, creates tag `vx.y.z` and a GitHub release with `all-mixer-vx.y.z.zip` and the changelog section as notes. The build writes the `package.json` version into `dist/manifest.json`, so do not edit the version in `public/manifest.json`. The version must be 1–4 dot-separated numbers (Chrome rule; no `-beta`). If the tag already exists, the workflow does nothing. To re-run by hand: Actions → Release → Run workflow.
