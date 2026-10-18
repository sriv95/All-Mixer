# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"All Mixer!": Chrome MV3 extension for youtube.com and music.youtube.com. Two features: (1) volume boost / Separate mode (live vocal vs instrumental mixing, ML stem separation on WebGPU), (2) synced lyrics / karaoke text. Package manager is **bun**; tests are **vitest** (`bun run test`, never bare `bun test`).

## Commands

```sh
bun install
bun run test                          # vitest run (happy-dom); src/**/*.test.ts + scripts/**/*.test.mjs
bun run test -- src/ml/karaoke.test.ts          # one file
bun run test -- -t "name fragment"              # one test by name
bun run lint                          # eslint . (spike/, scripts/qa-* ignored)
bun run typecheck                     # tsc --noEmit
uv sync                               # Python env (.venv) for the model scripts
bun run fetch-model                   # downloads public/ml/vocals.onnx + mdx.onnx (gitignored)
bun run export-roformer               # optional: builds models-out/{roformer,deux}.onnx (gitignored, not part of the extension; name/--force args)
bun run model-manifest roformer=1 deux=1  # models-out/hf/ = what to upload to the Hugging Face model repo (see scripts/model-manifest.mjs)
bun run build                         # typecheck + 4 vite builds -> dist/
bun run dev                           # watch build of the content script only
```

- `bun run build` fails if `public/ml/vocals.onnx` / `mdx.onnx` are missing. `mdx.onnx` conversion uses `.venv/bin/python` from `uv sync` (override with `PY=/path/to/python`). The RoFormer models ("High quality" = `roformer`, "Best quality" = `deux`) are not packed into the build: the user downloads the selected one from a public Hugging Face repo (`MODEL_BASE_URL` in `src/shared/model-store.ts`) into OPFS; `src/background/model-manager.ts` downloads and checks for newer versions (manifest.json, one version per model), the popup shows the button, the ML worker reads the chunks. `chrome.storage.local['debug.modelBaseUrl']` points it at a local server for QA.
- Build is 4 separate vite runs because the artifacts differ: main (popup, `ml.html`, background service worker, ES), content script (single IIFE), MAIN-world page bridge (IIFE, `ENTRY=page`), separator AudioWorklet (one ES module). After a rebuild, reload the extension in `chrome://extensions` and reload the YouTube tab.
- CI (`.github/workflows/ci.yml`) runs only lint + typecheck + test, and only after a PR merges to `main` (or a `package.json` push). It never builds, since the models are not in git.
- Release: add `## [x.y.z] - date` to `CHANGELOG.md` and bump `version` in `package.json` (single source; the build stamps it into `dist/manifest.json`, so do not edit the version in `public/manifest.json`). Changelog entries describe user-visible behavior in plain language, under `## [Unreleased]` until released. See README "Release".
- Commit style: `type(scope, SRI-NNN): message` (Linear ticket ids appear in code comments and commits too).
- Python parity tests (`scripts/parity-mdx.test.mjs`) are skipped unless `PARITY_DIR` is set; see the file header.

## Architecture

Runtime pieces and how they talk (message types in `src/shared/messages.ts`):

- **Background service worker** (`src/background`): keeps per-tab settings in `chrome.storage.session` (`TabStore`), forwards popup changes to the tab's content script, and fetches/caches LRCLIB lyrics (`LyricsCache` in `chrome.storage.local`) so the content script never needs cross-origin fetches.
- **Popup** (`src/popup`): Default / Separate tabs; writes `MixerSettings` (`src/shared/settings.ts`) via the background. Reads status from the content script.
- **Content script** (`src/content/content.ts`): composition root. Wires `watchMainVideo` → `MasterChain` (audio graph) + `EngineSelector` (ML on/off decision) + `DelayedVideo` (picture delay) + `AvProbe` (debug) + `initLyrics`. Lives for the whole tab so settings survive SPA navigation.
- **Page bridge** (`src/page/bridge.ts`): runs in the MAIN world at `document_start` to read the player response and caption timed text, which isolated-world content scripts cannot reach. Content side talks to it via `src/content/lyrics/bridge-client.ts` using the shared protocol in `src/shared/bridge.ts`.
- **All YouTube / YT Music selectors and SPA events live in `src/content/youtube-dom.ts`** (with fixtures in `src/content/__fixtures__/`). Change selectors only there.

### Audio / Separate mode (the part that needs several files to understand)

1. `MasterChain` (`src/content/audio/master-chain.ts`): `<video>` → MediaElementSource → direct gain path and separator-worklet path, crossfaded → master gain (0–6×) → limiter → destination. The page's audio is untouched until gain ≠ 100 % or Separate is first used; after that the element stays routed through Web Audio (irreversible). AudioContext may need a user gesture first.
2. `src/worklet/` (`separator-processor.ts` + `core.ts`, protocol in `protocol.ts`): the AudioWorklet delay line/mixer. Runs on the original mix (no delay) until ML is ready, then outputs ML stems with a fixed latency (`ML_LATENCY_SAMPLES`, ≈1.97 s). `protocol.ts` is shared by both sides, so it must not touch DOM/worklet globals; its constants fix the block geometry that the ML code depends on.
3. ML host chain: `MlHost` (`content/audio/ml-host.ts`) creates a hidden extension iframe `ml/ml.html` (web-accessible) because that origin gets a real WebGPU adapter. `ml-page.ts` starts `ml-worker.ts` and hands over a `MessagePort`; blocks then flow worklet ↔ worker directly, bypassing the page. The worker runs ONNX Runtime Web (webgpu EP only): MDX-Net 9482 for the vocal and the Spleeter vocal model for a mask (`pipeline.ts`, `mdx.ts`, `stream.ts`). `karaoke.ts` builds the Karaoke stem (instrumental = mix − vocal with Spleeter mask, dip-fill gate, MDX-presence gate); it must stay allocation-free in the hot path (tests enforce this).
4. `EngineSelector` (`engine-select.ts`): decides warming / on / unavailable / stopped. A warm-up benchmark (p90 gate) and runtime deadline misses fall back to the original mix.
5. `DelayedVideo` (`content/video-delay/`): because audio is delayed in Separate mode, the picture is delayed by the same amount (rVFC frame queue drawn on a canvas over the `<video>`). Lyrics follow the *presented* time, not `currentTime`.

### Lyrics (`src/lyrics/` pure logic, `src/content/lyrics/` UI)

Pure modules (LRC parse, LRCLIB client/match, caption parse, word alignment, line sync) are in `src/lyrics/`. `src/content/lyrics/init.ts` wires `LyricsController` (source order: manual captions → LRCLIB synced → auto captions → other captions → LRCLIB plain; user can pin a source) to surfaces: floating panel / karaoke overlay on youtube.com, the native Lyrics tab on YT Music. `CaptionBoot` briefly turns CC on to load captions (also on mode toggle) and restores it. Per-tab lyrics prefs: `src/shared/lyrics-prefs.ts`.

## Non-shipping directories

- `spike/`: Python/JS research benches for the ML pipeline (reference implementations the TS code is checked against; has its own `package.json`, incl. Playwright). Not linted.
- `scripts/qa-*`, `scripts/sri*/`, `qa/`, `docs/`: QA harness output (screenshots/JSON) and write-ups per ticket. `scripts/qa-*.mjs` are gitignored local harnesses; the other committed `scripts/*.mjs` (`fetch-*`, `onnx-dyn-dim`, `smoke-*`) are real tooling. `smoke-*.mjs` load `dist/` in Playwright with network access.
- Debug hooks (`debug.mlStallMs`, `debug.mlTiming`) are described in README "Debug".
