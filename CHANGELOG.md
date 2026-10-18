# Changelog

All notable changes to All Mixer! are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

To release: add a `## [x.y.z] - YYYY-MM-DD` section below, then bump `version` in `package.json` and push to `main`.
CI builds the extension, creates tag `vx.y.z` and a GitHub release with this section as the notes.

## [Unreleased]

## [Unreleased]

### Added

- Toolbar badge: the extension icon shows what Separate mode is doing without opening the popup. Gray dots while it warms up, black "ON" while it separates, a red "!" on white when it stops (for example the device is too slow). The tooltip says the same in words. The extension now has an icon.
- Popup: when Separate mode stops because the device is too slow, buttons offer the fix: switch to the Default model, raise the delay limit, or try again.

### Changed

- Popup: new look (soft cards, pressed tracks, icons) and a clearer state banner for Separate mode: warming up, separating with the delay, stopped. Default and Separate are now tabs.
- High / Best quality: the warm-up remembers the speed of your GPU, so the next one skips the speed test and is about 40 % shorter (on an M-series Mac at an 8 s limit: 24 s, then 14 s). The chunk it plans is still timed and checked, and a speed that no longer holds is measured again.
- Separate mode: turning it off and on again within 3 minutes starts at once, with no warm-up (the model stays loaded in the tab meanwhile, up to about 0.5 GB of GPU memory). Other settings or a longer wait warm up again.
- Popup: when the tab needs a reload (no All Mixer! running in it yet), the Separate mode checkbox is hidden and the popup says to reload the tab.
- Separate mode: while the model warms up (the video is held for 10 to 40 s), the player's loading spinner shows over the picture, with "Preparing vocal separation… 12 s" under it. The player keeps showing "playing" meanwhile (no paused look), and pressing pause during the wait pauses for real and the video stays paused after it. The other waits say what they are for too.
- Separate mode: the time and the seek bar of YouTube and YouTube Music now show what you see and hear, not the video position that runs ahead by the delay. This holds across chapter boundaries and for screen readers (English labels), and the bar is left alone while you drag it.
- Separate mode: when a video ends, the next one (autoplay / queue) starts only after the delayed last seconds have played, with the player's loading spinner shown meanwhile. Pausing during that wait stops it at once.
- Separate mode: after a seek or a new video, the player's loading spinner shows from the seek, over the loading, until the sound is really out of the speakers (it follows the audio, so a Bluetooth delay is covered too). Pause hides it and play brings it back while the sound is still missing.
- Popup: the Vocal, Instrumental and Drums sliders now go from 0 to 100 %. Only Global Volume boosts.
- Popup: the Default / Separate tabs are replaced by a **Separate mode** checkbox. Checked shows the Separate settings.
- Separation: **Split instrumental** adds its delay on top of the Delay limit, so the limit no longer jumps to 8 s.
- Popup: **Global Volume** (0 to 600 %, 100 % in the middle of the slider) sits at the top and boosts both modes, with its own Reset. It replaces Master volume, which was Default mode only. The Reset preset leaves it alone.
- Popup: the **Others** slider now goes from 0 to 100 %.

## [0.3.0] - 2026-10-18

### Added

- Separation: **Split instrumental** (Separate tab > Advanced, off by default). A second model (SCNet Tran Small, 41 MB, one-time download) takes the drums out of the instrumental. New **Drums** and **Others** sliders (0 to 600 %) sit inside the Instrumental slider: Instrumental 50 % with Drums 100 % plays the drums at 50 %. Adds about 4 s of delay with the Default model (6.2 s in all on an M1). With High / Best quality it needs a fast GPU and a delay limit of 8 s or more (the popup raises it); on an M1 it says "too slow".
- Separation: High quality (RoFormer, Kim fine-tune) and Best quality (Deux RoFormer) in the Model menu, next to Default. They separate the voice much more cleanly but need a fast GPU. Each is a one-time download (440 MB / 240 MB) from a public Hugging Face repo, kept in the extension's storage; the popup offers updates. The extension package is about 0.45 GB smaller.
- Separation: a **Delay limit** slider (2 to 15 s, default 2 s) in the Advanced section. The delay never exceeds it, and a longer limit gives the model a longer chunk (more context, fewer joins). It works for the Default model too (3 s or more). **Apply** re-runs the warm-up (10 to 40 s, video paused meanwhile).
- Separation: Karaoke / A cappella now use MDX-Net 9482 for the vocal (a cleaner voice, no mask buzz); Karaoke removes the leftover voice with the Spleeter mask. Added delay is 1.97 s (was 0.30 s); the video is delayed to match. Without WebGPU, or if it cannot keep up, the original mix plays.
- Popup: the Model menu, its download line and the Delay limit moved into an **Advanced** section at the bottom of the Separate tab.
- Volume boost and Separate mode now work on any site with a video or audio player, not only YouTube. Lyrics stay on YouTube and YouTube Music.
- Lyrics: a "Lyrics source" menu (Auto / LRCLIB / YouTube captions) in the footer; Auto names the source in use. The caption language menu lists every track, including auto-generated ones.
- Lyrics: "Lyrics timing" (-2 s to +2 s) and timing keys (`[` and `]`, 0.1 s) shift synced lyrics for the current video. Remembered per video.
- Lyrics: "Find other lyrics…" (LRCLIB search), "Use my own lyrics…" (paste or load a `.lrc` / `.txt`), "Copy lyrics" and "Save as .lrc".
- Karaoke text: a "Custom Karaoke Text" group with Color, Size, Font, Outline, Background, Style presets (plus "My style" and "Reset style"), Line transition, Position and Lyrics-only view. Right-click the text for a menu of presets.
- Karaoke text: the current line turns blue from left to right while it is sung. A "Reset position" button puts the text back.

### Changed

- youtube.com: CC turns on for a moment to load captions after a page load and after switching between Default and Separate mode, then returns to how it was.
- Karaoke keeps more of the instrumental while someone sings: the Spleeter mask applies in a frequency band only while the MDX vocal is present there.
- Karaoke text: when no line is sung, the text is hidden; the next line shows only in the last 3 s before it starts. With 2 lines the rows stay in place.
- The ♪ button shows or hides the lyrics; choose karaoke text or the lyrics window in "Lyrics display". Lyrics settings are grouped in one "Lyrics" row in the player's menu.
- Lyrics panel: the text grows with the panel, lines are centered, and a "Centered / Free scroll" button unlocks scrolling.
- Lyrics: new automatic order: manual captions, LRCLIB synced, auto-generated captions, other captions, LRCLIB plain.

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
