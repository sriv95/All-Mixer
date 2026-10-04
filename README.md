# All Mixer!

Chrome extension (Manifest V3) for youtube.com and music.youtube.com.

## Build

```sh
npm install
npm run build      # typecheck + vite build → dist/
npm test           # unit tests (vitest + happy-dom)
npm run lint
```

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
- Separate mode is a placeholder (unity gain) until the separation engine lands.
