# Changelog

All notable changes to All Mixer! are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

To release: add a `## [x.y.z] - YYYY-MM-DD` section below, then bump `version` in `package.json` and push to `main`.
CI builds the extension, creates tag `vx.y.z` and a GitHub release with this section as the notes.

## [Unreleased]

### Removed

- The Light (DSP) separation engine and the Auto / Light / Quality selector in the popup. A stored `separationQuality` setting is ignored.

### Changed

- Separate mode always uses the ML engine. While it warms up, or when it cannot run (no WebGPU, model load failure, too slow, context not at 44.1 kHz) or stops after missed deadlines, the original mix plays unprocessed with no added delay, and the popup says why. Switching to Default and back retries ML.

## [0.1.0] - 2026-10-05

First release. Chrome extension (Manifest V3) for youtube.com and music.youtube.com.

### Added

- **Volume boost (Default mode).** Master slider from 0 % to 600 % with a limiter (compressor and soft clipper, ceiling about −0.2 dBFS). Page audio is not touched until the slider leaves 100 %.
- **Vocal / instrumental mixing (Separate mode).** Separate sliders for vocals and instrumental, with Karaoke, A cappella and Reset presets.
  - Two separation engines: a light DSP separator (AudioWorklet) and an ML separator (Spleeter 2-stems vocals model, ONNX Runtime Web on WebGPU).
  - Engine choice Auto / Light / Quality. Auto measures the device at warm-up and falls back to DSP if the ML engine misses its deadlines.
  - A cappella mode sharpens the vocal stem for less instrumental bleed.
  - The popup shows engine status, warm-up and the added delay.
- **Video delay.** In Separate mode the video is delayed with a canvas overlay so picture and processed audio stay in sync.
- **Synced lyrics.**
  - Lyrics from LRCLIB (plain and enhanced LRC with word timing), with track matching and a fetch cache. Placeholder or vandalised records are rejected. Fan uploads in "Title - Artist" order are also tried.
  - Fallback to the video's own captions, re-aligned to the audio, also when CC is turned on later.
  - YouTube Music: lyrics in the player's Lyrics tab, which is enabled when the site has none.
  - YouTube: floating side panel you can drag, resize and use in full screen. Highlight, auto-scroll and click-to-seek. Keyboard scroll in the panel does not reach the YouTube player.
- **Per-tab settings.** Settings are kept per browser tab, survive SPA navigation and reloads, and are cleared when the tab closes.
