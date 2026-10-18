# Changelog

All notable changes to All Mixer! are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

To release: add a `## [x.y.z] - YYYY-MM-DD` section below, then bump `version` in `package.json` and push to `main`.
CI builds the extension, creates tag `vx.y.z` and a GitHub release with this section as the notes.

## [Unreleased]

### Added

- Separation: the Model menu in the Separate tab now has "Default" (MDX-Net 9482 + Spleeter, as before), "High quality" (a Mel-Band RoFormer, unwa's Kim fine-tune) and "Best quality" (becruily's Deux RoFormer, for a good GPU). They separate the voice much more cleanly (on the test song High quality's vocal stem is 5 dB stronger than Default's, so less voice is left in Karaoke and less music in A cappella). They run once per block on WebGPU with fp16 weights; the added delay is about 2 s (Default: 1.97 s) unless you choose a longer one below. They need a fast GPU: one step takes ~0.73 s (High quality) or ~1.0 s (Best quality) on an M1 against a 0.75 s limit at 2 s, and the popup says "too slow on this device" if the warm-up does not fit. The models (about 440 MB and 240 MB) are not part of the extension: when you pick one, the popup offers a one-time download from a public Hugging Face repo (progress is shown; a stopped download resumes). The model is kept in the extension's own storage. When a newer version is published, the popup shows an Update button; the old version keeps working until the new one is complete. The extension package is about 0.45 GB smaller. Maintainers: `bun run export-roformer`, `bun run model-manifest roformer=<n> deux=<n>`, upload `models-out/hf` (see `scripts/model-manifest.mjs`).
- Separation: for High / Best quality the Separate tab has a **Delay limit** slider (2 to 15 s, 1 s steps, default 2 s). The audio delay never exceeds it, and a longer limit lets the model take a longer chunk of the song at once (fewer joins between chunks, more context): in testing Best quality stopped leaking violin into the vocal with a longer chunk. The chunk is planned from the speed of your GPU (about 1.2 s at 2 s, 3.4 s at 6 s, 7.8 s at 15 s on an M1 with High quality). Moving the slider and pressing **Apply** re-runs the warm-up, which takes 10 to 40 s while the original mix plays. The models were re-exported with a variable chunk length, so they are a new download (the old 1.99 s files are replaced); a GPU that cannot keep up at the chosen limit says so in the popup.
- Popup: the Model menu, its download / update line and the Delay limit slider moved into an **Advanced** section at the bottom of the Separate tab (closed by default, remembered once opened, and open when a non-default model is in use). A model update is shown there.
- Separation: the Karaoke / A cappella ML engine now uses MDX-Net 9482 (T = 64, 50 % overlap, WebGPU) for the vocal, so A cappella is a cleaner voice with no mask buzz. Karaoke keeps the MDX instrumental and removes the leftover voice with the Spleeter vocal mask (H3, power 2, margin 0.8). Added audio delay in Separate mode is now 1.97 s (was 0.30 s); the video is delayed to match, and lyrics follow. Without WebGPU, or if it cannot keep up, the original mix plays as before. New model: `public/ml/mdx.onnx` (fp16, 14.9 MB; `bun run fetch-model`), credited in `ml/THIRD_PARTY_NOTICES.txt`.
- Lyrics: a "Lyrics source" menu (Auto / LRCLIB / YouTube captions) in the lyrics footer. The pick is kept for the tab. If the picked source has nothing for a video, the automatic order is used and the footer says so.
- Lyrics: in the "Lyrics source" setting, the Auto option names the source in use, e.g. "Auto (LRCLIB)" or "Auto (YouTube auto captions)".
- Karaoke text: a "Custom Karaoke Text" group in the lyrics settings (youtube.com) with a Color (White by default, Yellow, Cyan, Green, Pink, Orange, or any color from the color picker) and the Size, which moved there from the main lyrics settings.
- Lyrics: a "Lyrics timing" setting (-2 s to +2 s) shifts synced lyrics, karaoke text and the lyrics window for the current video when they run early or late. "+" shows the lyrics later. The shift is remembered per video.
- Karaoke text: more styling in "Custom Karaoke Text": Font (YouTube, Sans-serif, Serif, Monospace), Outline (None, Thin, Normal, Thick) and Background (a dark box behind the text, 25-75 %).
- Karaoke text: a "Style preset" setting in "Custom Karaoke Text" (Default, Big yellow, Clean box, Cyan glow) sets color, size, font, outline and background in one tap. It reads "Custom" after you change any of them.
- Karaoke text: a "Line transition" setting in "Custom Karaoke Text" (None, Fade, Slide up) animates a line when it changes. A line that stays does not animate, and nothing animates when your system asks to reduce motion. Default: None.
- Lyrics: "Copy lyrics" in the lyrics settings copies the lyrics as plain text, and "Save as .lrc" downloads synced lyrics as an `.lrc` file (with title and artist tags). Both show a short "Copied" / "Saved" in place of the button text.
- Lyrics: "Find other lyrics…" in the lyrics settings opens a search of LRCLIB (filled from the video's artist and title) for when the lyrics are for the wrong song or version, or missing. The results show length, synced or plain, and how far off the video's length they are. Picking one is kept for that video and sets Lyrics source to LRCLIB. "Back to automatic" removes the pick.
- Lyrics: "Use my own lyrics…" in the lyrics settings lets you paste lyrics or load a `.lrc` / `.txt` file for the current video (lines with `[mm:ss.xx]` timestamps become synced lyrics). They are kept for that video, set Lyrics source to LRCLIB, and "Back to automatic" removes them.
- Lyrics: timing keys. While synced lyrics are shown, `]` shows them 0.1 s later and `[` 0.1 s earlier, with a short on-screen message. Keys typed in a text field are ignored. "Timing keys" in the lyrics settings turns this off. A timing between the menu steps (e.g. +0.3 s) now shows in the Lyrics timing list.
- Karaoke text: "My style". "Save the current look as My style" in the Style preset setting keeps your color, size, font, outline and background as one more preset (one slot; saving again replaces it).
- Karaoke text: right-click the text for a menu of presets: Position (Top, Middle, Bottom), Style (the Style presets and My style) and Lyrics-only view. The same Position choices are in "Custom Karaoke Text" (it reads "Custom (dragged)" after you drag the text).
- Karaoke text: "Lyrics-only view" (in "Custom Karaoke Text", or the right-click menu) dims and blurs the video and shows the text large in the middle, for listening. Dragging is off while it is on. It only dims when synced lyrics are shown.
- Karaoke text: "Reset style" in the Style preset setting restores the stock look and no line transition.
- Lyrics: the caption language menu lists every caption track, including auto-generated ones, which are labelled (e.g. "English (auto-generated)").
- Karaoke text: the current line turns blue from left to right while it is sung, over the line's own time (by word timing when known). A "Reset position" button in the lyrics settings puts the text back at its default place.

### Changed

- youtube.com: switching between Default and Separate mode now turns CC on for a moment to load the captions again, and turns it off again if it was off before. If CC was already on, it stays on.
- Karaoke keeps more of the instrumental while someone sings. The Spleeter vocal mask is now applied in a frequency band only while the MDX vocal is present in that band (last 4 s), so backing music is no longer thinned out in sung parts where the MDX vocal is silent. On the test song at 125.8-127 s the dip shrinks by 1.61 dB (150 Hz-1 kHz), 1.04 dB (1-4 kHz) and 2.51 dB (above 4 kHz). A cappella and the added delay are unchanged. `KARAOKE_PRES_GATE` in `src/ml/karaoke.ts` switches it off (0).
- Karaoke text (1 and 2 lines): when no line is being sung, the text is hidden. The next line shows only in the last 3 s before it starts, and it is the only line shown then (never two idle lines). A line before a long instrumental break no longer stays on screen for the whole break.
- Karaoke text, 2 lines: the two rows stay in place. When a line ends, the next line replaces it in the same row; nothing scrolls up.
- The ♪ button now shows or hides the lyrics. It no longer switches between karaoke text and the lyrics window; choose that in the settings ("Lyrics display"). Closing the lyrics window hides the lyrics.
- youtube.com: the lyrics settings are grouped in one "Lyrics" row (with the ♪ icon) in the player's settings menu. YouTube's own captions stay hidden while lyrics show, but pressing the CC button shows them again for that video.
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
