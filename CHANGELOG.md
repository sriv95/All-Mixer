# Changelog

All notable changes to All Mixer! are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

To release: add a `## [x.y.z] - YYYY-MM-DD` section below, then bump `version` in `package.json` and push to `main`.
CI builds the extension, creates tag `vx.y.z` and a GitHub release with this section as the notes.

## [Unreleased]

### Added

- Separation: the Karaoke / A cappella ML engine now uses MDX-Net 9482 (T = 64, 50 % overlap, WebGPU) for the vocal, so A cappella is a cleaner voice with no mask buzz. Karaoke keeps the MDX instrumental and removes the leftover voice with the Spleeter vocal mask (H3, power 2, margin 0.8). Added audio delay in Separate mode is now 1.97 s (was 0.30 s); the video is delayed to match, and lyrics follow. Without WebGPU, or if it cannot keep up, the original mix plays as before. New model: `public/ml/mdx.onnx` (fp16, 14.9 MB; `bun run fetch-model`), credited in `ml/THIRD_PARTY_NOTICES.txt`.
- Lyrics: a "Lyrics source" menu (Auto / LRCLIB / YouTube captions) in the lyrics footer. The pick is kept for the tab. If the picked source has nothing for a video, the automatic order is used and the footer says so.
- Lyrics: the caption language menu lists every caption track (auto-generated ones are labelled) and an "Auto-translate" group with YouTube's machine translations of the song's captions.

### Changed

- Lyrics panel: the text grows when the panel is made wider, lines are centered, and the current line stays in the middle (also when the panel is resized). A "Centered / Free scroll" button in the footer unlocks scrolling. The YT Music Lyrics tab is unchanged.
- Lyrics: new automatic order: manual song captions, LRCLIB synced, YouTube auto-generated captions, other captions, LRCLIB plain. Plain LRCLIB lyrics now rank below auto-generated captions.

## [0.2.0] - 2026-10-06

### Added

- A cappella: a per-frame gate on the sharpened vocal stem mutes frames where the vocal kept almost no energy (instrumental-only gaps), so less instrumental leaks through. Vocal quality is unchanged (bench: gap leak −41.2 → −61.5 dB).
- Lyrics: when LRCLIB has no synced lyrics, the video's subtitles are shown. When there are no subtitles and no LRCLIB lyrics, the auto-generated transcript is shown, with word highlight. On YouTube Music the transcript stays in the floating panel, so the Lyrics tab keeps YT Music's own lyrics.
- Lyrics: a caption language menu in the lyrics footer when the lyrics come from captions and the video has more than one caption track. The picked language is preferred on the next videos in the same tab.

### Removed

- The Light (DSP) separation engine and the Auto / Light / Quality selector in the popup. A stored `separationQuality` setting is ignored.

### Changed

- A cappella: the vocal mask power is now 4 (was 2.25), so less instrumental leaks into the vocal. On the 50-clip bench the median instrumental interference drops from −18.38 to −21.54 dB; Karaoke and latency are unchanged.
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
