# All Mixer!

Chrome extension (Manifest V3) for youtube.com and music.youtube.com.

## Build

```sh
bun install
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

## Debug

- Force ML deadline misses (QA): in the extension service-worker console run `chrome.storage.local.set({'debug.mlStallMs': 400})`, then reload the YouTube tab. After `debug.mlStallAfterMs` (default 5000 ms, after warm-up) every ML block is held 400 ms, far past the block deadline, so 3 misses happen within about 2 s. Clear with `chrome.storage.local.remove(['debug.mlStallMs','debug.mlStallAfterMs'])`.

## Release

1. Add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md`.
2. Set the same `version` in `package.json` and push to `main`.

`.github/workflows/release.yml` then builds the extension, creates tag `vx.y.z` and a GitHub release with `all-mixer-vx.y.z.zip` and the changelog section as notes. The build writes the `package.json` version into `dist/manifest.json`, so do not edit the version in `public/manifest.json`. The version must be 1–4 dot-separated numbers (Chrome rule; no `-beta`). If the tag already exists, the workflow does nothing. To re-run by hand: Actions → Release → Run workflow.
