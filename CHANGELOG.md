# Changelog

All notable changes to All Mixer! are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

To release: add a `## [x.y.z] - YYYY-MM-DD` section below, then bump `version` in `package.json` and push to `main`.
CI builds the extension, creates tag `vx.y.z` and a GitHub release with this section as the notes.

## [Unreleased]

### Added

- Separate mode now works on GPUs without fp16 support (for example AMD RX 590): the popup offers "Download supported models", a one-time download of the Default model in a form those GPUs can run. The High quality, Best Vocal, Focus Instrumental Splitting and Guitar split models are not supported on such GPUs, and the popup says so.
- **Export.** A new Export section under Advanced (Separate tab) saves the video you are watching as an **MP3** or as an **MP4 with the karaoke text drawn on the picture**. Both start with the Audio options from your current settings (model, split switches, global volume, vocal, instrumental and split levels); you can change them for the export without changing what you hear, and Match live brings them back. **Single track** saves the mix. **Separate tracks** saves the mix (with your levels) and each raw stem: a .zip of MP3 files (an MP3 file holds one track), or one MP4 with several audio streams (the mix first, so every player plays it; VLC, mpv and DaVinci Resolve list the others). The MP4 has Karaoke text options (colour, size, font, outline, background, lines, position, picture size) with a preview. A progress bar shows the chunk, the time and the percent, and Cancel stops it. On a GPU without fp16 the model row offers the fp32 Default download, as in Advanced. The sound is processed in chunks of at most 15 seconds and the tab must stay open. An MP4 records the video while it plays (muted, from the start), so it takes about as long as the video; an MP3 does not (see Faster Export and Preload).
- **Preload Audio mode.** When Separate mode stops because the device is too slow to keep up live ("ML missed its deadline"), the popup offers **Switch to Preload Audio**. It separates the whole video first and then plays it from memory, so a slower GPU still works, with no audio delay. The popup shows the progress (chunk, time, percent) and Cancel, and the tab must stay open while it loads. The vocal and instrumental sliders still work live. **Advanced > Processing** switches between **Live** and **Preload audio** at any time; the Export section opens in Preload mode. A video too long to keep in memory (over 900 MB of stems) is refused with an **Export instead** button. Pitch shift does not apply to preloaded audio, and an ad or a playback speed other than 1× plays the original sound meanwhile.
- **Faster Export and Preload.** On YouTube the MP3 export and Preload Audio no longer wait for the video to play through: the extension takes the audio the player has already downloaded (it makes the player load all of it first, which takes a few seconds) and processes that at once. A 3:33 song that took 3:33 to read now takes about 3 seconds before the model starts. It falls back to the real-time recording by itself when it cannot (an MP4 export, which needs the picture; videos over 20 minutes; a player that uses an AAC audio track; the tab was open before the extension was installed or reloaded).
- **Focus Instrumental Model button.** The Split instrumental section has a button that switches to the Focus Instrumental Splitting model in one tap.

### Fixed

- Separate mode on a GPU without fp16 support no longer shows a shader error; it says what is missing.
- The "Try the high performance GPU" button no longer shows when the GPU in use is already the fastest one.

## [1.0.0] - 2026-10-25

First official release. This sums up everything built in 0.1.0 to 0.5.0, plus the new look below.

### Added

- **Volume boost.** Global Volume goes from 0 % to 600 % in Default and Separate mode, with a limiter that keeps the sound clean. The page's audio is not touched until you move the slider. It works on any site with a video or audio player, not only YouTube.
- **Pitch.** A − / + control shifts the pitch up or down by up to 6 semitones with the speed unchanged. Separate mode can shift the vocal and the instrumental separately.
- **Separate mode (live vocal / instrumental mixing).** Vocal and Instrumental sliders from 0 to 100 %, with Karaoke, Half karaoke, A cappella and Reset presets and a five-second Undo. The separation runs on your GPU (WebGPU) and adds about 2 seconds of delay. The video is delayed by the same time so picture and sound stay in sync, and the time and seek bar show what you hear. If your device cannot keep up, or has no WebGPU, the original sound plays and the popup says why, with buttons to fix it (Default model, higher delay limit, retry).
- **Four separation models.** Default (MDX-Net and Spleeter, built in), High quality (RoFormer, Kim fine-tune), Best Vocal (Deux RoFormer) and Focus Instrumental Splitting (vocal, drums, guitar, bass, piano and others, each with its own level). The RoFormer models are a one-time download from Hugging Face. The popup offers updates and an Uninstall model link.
- **Split instrumental.** Optional Drums and Guitar switches take those instruments out of the instrumental, each with its own level. They add delay on top of the Delay limit.
- **Advanced settings.** Model, GPU (Automatic, High performance or Low power), Delay limit (2 to 15 s; a longer limit gives a cleaner split) and Change pitch separately. Warm-up remembers your GPU speed, and turning Separate mode off and on within 3 minutes restarts at once.
- **Synced lyrics on YouTube and YouTube Music.** Lyrics come from LRCLIB, with the video's own captions (manual, then auto-generated) as a fallback. On YouTube Music they show in the player's Lyrics tab; on YouTube in a floating panel or as karaoke text over the video. You can pick the lyrics source and the caption language, shift the lyrics timing (−2 s to +2 s, or the `[` and `]` keys), search other lyrics, paste your own, copy them or save them as `.lrc`.
- **Karaoke text.** The sung line fills with colour from left to right. Colour, size, font, outline, background, line transition, position and style presets are yours to change, with a right-click menu and a Lyrics-only view.
- **Toolbar badge.** It shows the state of Separate mode: gray dots while warming up, "ON" while separating, and a red "!" when it stops. The tooltip says the same.
- **Popup.** Default and Separate tabs, dark mode that follows the system, hints, a compact view, animations that follow "Reduce motion", and a link to the GitHub repository at the bottom. Settings are kept per browser tab and survive page navigation and reloads.

### Changed

- New app icon
- The extension name in the manifest is now "All Mixer! - Karaoke and Live Vocal/Instrumental Separation".

## [0.5.0] - 2026-10-20

### Added

- Models: **Uninstall model** link deletes a downloaded model from disk.
- Split instrumental: Guitar switch and level (45 MB download, about 6 s more delay). Model by becruily, non-commercial use only.
- Model: **Focus Instrumental Splitting** splits vocal, drums, guitar, bass, piano and others, each with its own level (343 MB, fast GPU). It has no licence from its author.
- GPU: Advanced setting to pick Automatic, High performance or Low power. The slow-GPU alert offers the high performance GPU.
- Pitch: − / + control shifts pitch up to 6 semitones in Default and Separate mode. Separate mode can shift vocal and instrumental separately.

### Changed

- Model menu: "Best quality" is now "Best Vocal".
- Separate mode: audio and picture are about 23 ms later (pitch stage).

### Fixed

- Popup: Separate banner reads the frame that plays the media, follows a stop or failure, and shows "Separation unavailable" when the engine gives up.
- Toolbar badge: red "!" when the separator fails after going live.
- Separate mode: playback waits for separation after a new song, pause or seek instead of playing the original sound.
- Separate mode: time shows the full length at the end of a video.

## [0.4.0] - 2026-10-19

### Added

- Toolbar badge shows Separate mode state: gray dots while warming up, "ON" while separating, red "!" when it stops. The tooltip says the same. The extension now has an icon.
- Popup: dark mode (follows the system), hints, and a compact view (remembered).
- Popup: "Undo" for five seconds after a preset.
- Popup: when Separate mode stops because the device is too slow, buttons offer the fix: Default model, higher delay limit, or retry.

### Changed

- Lyrics settings on YouTube: two sections, "Lyrics source" and "Lyrics display". "Find other lyrics" and "Use my own lyrics" are now source choices.
- Popup: new look and animations (follow "Reduce motion"), and a clearer Separate state banner.
- Popup: a **Separate mode** checkbox replaces the Default / Separate tabs. It is hidden when the tab needs a reload.
- Popup: **Global Volume** (0 to 600 %) replaces Master volume and boosts both modes. Vocal, Instrumental, Drums and Others sliders go from 0 to 100 %.
- High / Best quality: warm-up remembers your GPU speed, so the next one is about 40 % shorter.
- Separate mode: turning it off and on within 3 minutes restarts at once, with no warm-up.
- Separate mode: **Split instrumental** adds its delay on top of the Delay limit.
- Separate mode: the loading spinner and a "Preparing vocal separation…" message show during warm-up, seeks, new videos and the end of a video. Pause works during these waits.
- Separate mode: the time and seek bar show what you hear, not the video position that runs ahead by the delay.

### Fixed

- Lyrics: a long settings list scrolls instead of running off the top.
- Lyrics: YouTube settings match YouTube's own submenus in spacing, width and slide animation.
- Lyrics: a brief LRCLIB server error (HTTP 5xx) is retried once.

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
