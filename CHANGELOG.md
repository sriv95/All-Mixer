# Changelog

All notable changes to All Mixer! are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

To release: add a `## [x.y.z] - YYYY-MM-DD` section below, then bump `version` in `package.json` and push to `main`.
CI builds the extension, creates tag `vx.y.z` and a GitHub release with this section as the notes.

## [Unreleased]

### Added

- Separate mode now works on older GPUs without fp16 support (for example AMD RX 590). The popup offers "Download supported models", a one-time download of the Default model for these GPUs. The other models do not work on them, and the popup says so.
- **Export.** A new Export section under Advanced (Separate tab) saves the video you watch as:
  - an **MP3** of the sound
  - an **MP4** of the karaoke text on a black background, with or without the sound (**Include audio**)

  The sound starts from your current settings (model, levels, split switches). You can change them for the export without changing what you hear, and **Match live** brings them back. **Single track** saves the mix. **Separate tracks** saves the mix plus each raw part: a .zip of MP3 files, or one MP4 with several audio streams (the mix plays first in every player). The MP4 has options for the text (colour, size, font, outline, background, lines, position) with a preview, and for quality. A progress bar shows the time and the percent, and Cancel stops it. Keep the tab open while it works.
- **Preload Audio mode.** If your device is too slow to separate live, the popup offers **Switch to Preload Audio**. It separates the whole video first, then plays it from memory, so a slower GPU still works and there is no audio delay. The popup shows the progress and Cancel. Keep the tab open while it loads. The vocal and instrumental sliders still work live. Switch between **Live** and **Preload audio** any time in **Advanced > Processing**. A video too long for memory is refused, with an **Export instead** button. Pitch shift does not work on preloaded audio. During an ad, or at a playback speed other than 1×, the original sound plays.
- **Faster Export and Preload.** On YouTube, Export and Preload Audio no longer wait for the video to play through. They use the audio the player already downloaded, so a 3:33 song starts processing in about 3 seconds instead of 3:33. If this is not possible, they record in real time instead (videos over 20 minutes, some audio formats, or a tab opened before the extension was installed or reloaded).
- **Focus Instrumental Model button.** One tap in the Split instrumental section switches to the Focus Instrumental Splitting model.

### Fixed

- On a GPU without fp16 support, Separate mode now says what is missing instead of showing a shader error.
- The "Try the high performance GPU" button no longer shows when you already use the fastest GPU.

## [1.0.0] - 2026-10-25

First official release. It includes everything from 0.1.0 to 0.5.0, plus the new look below.

### Added

- **Volume boost.** Raise the volume up to 600 % without distortion. Works on any site with a video or audio player, not only YouTube. Audio stays untouched until you move the slider.
- **Pitch.** Shift the pitch up or down by up to 6 semitones. The speed stays the same. In Separate mode you can shift the vocal and the instrumental separately.
- **Separate mode.** Mix the vocal and the instrumental live, from 0 to 100 % each. Presets: Karaoke, Half karaoke, A cappella and Reset, with a five-second Undo. It runs on your GPU (WebGPU) and adds about 2 seconds of delay. The video is delayed by the same time, so picture and sound stay in sync. If your device is too slow or has no WebGPU, the original sound plays. The popup says why and offers a fix.
- **Four models.** Default (built in), High quality, Best Vocal and Focus Instrumental Splitting (vocal, drums, guitar, bass, piano and others, each with its own level). The last three are a one-time download. The popup offers updates and an Uninstall model link.
- **Split instrumental.** Optional Drums and Guitar switches take those instruments out of the instrumental, each with its own level. They add more delay.
- **Advanced settings.** Choose the model and the GPU (Automatic, High performance or Low power). Set the Delay limit (2 to 15 s; a longer limit gives a cleaner split). Change pitch separately. If you turn Separate mode off and on within 3 minutes, it restarts at once.
- **Synced lyrics on YouTube and YouTube Music.** Lyrics come from LRCLIB, or from the video's captions if LRCLIB has none. On YouTube Music they show in the Lyrics tab. On YouTube they show in a floating panel or as karaoke text over the video. You can:
  - pick the lyrics source and the caption language
  - shift the timing (−2 s to +2 s, or the `[` and `]` keys)
  - search for other lyrics or paste your own
  - copy the lyrics or save them as `.lrc`
- **Karaoke text.** The sung line fills with colour from left to right. You can change the colour, size, font, outline, background, transition and position, or pick a style preset. Right-click the text for a menu. A Lyrics-only view is available.
- **Toolbar badge.** It shows the state of Separate mode: gray dots while it warms up, "ON" while it works, and a red "!" when it stops.
- **Popup.** Default and Separate tabs, dark mode that follows your system, hints and a compact view. Animations follow "Reduce motion". Settings are kept per browser tab and survive page changes and reloads.

### Changed

- New app icon.
- The extension name is now "All Mixer! - Karaoke and Live Vocal/Instrumental Separation".

## [0.5.0] - 2026-10-20

### Added

- **Uninstall model** link deletes a downloaded model from your disk.
- Split instrumental: Guitar switch and level (45 MB download, about 6 s more delay). Model by becruily, for non-commercial use only.
- **Focus Instrumental Splitting** model. It splits vocal, drums, guitar, bass, piano and others, each with its own level (343 MB, needs a fast GPU). Its author gives no licence.
- Advanced setting to pick the GPU: Automatic, High performance or Low power. The slow-GPU alert offers the high performance GPU.
- Pitch control (− / +) shifts the pitch up to 6 semitones in Default and Separate mode. Separate mode can shift vocal and instrumental separately.

### Changed

- "Best quality" is now called "Best Vocal".
- Sound and picture in Separate mode are about 23 ms later because of the pitch feature.

### Fixed

- The Separate banner in the popup now follows a stop or a failure. It shows "Separation unavailable" when the engine gives up.
- The toolbar badge shows a red "!" when Separate mode fails after it started.
- After a new song, a pause or a seek, playback waits for separation instead of playing the original sound.
- At the end of a video, the time now shows the full length.

## [0.4.0] - 2026-10-19

### Added

- The toolbar badge shows the state of Separate mode: gray dots while it warms up, "ON" while it works, and a red "!" when it stops. The extension now has an icon.
- Popup: dark mode (follows your system), hints, and a compact view (remembered).
- Popup: "Undo" for five seconds after you pick a preset.
- Popup: when Separate mode stops because the device is too slow, buttons offer a fix: the Default model, a higher delay limit, or a retry.

### Changed

- Lyrics settings on YouTube now have two sections: "Lyrics source" and "Lyrics display". "Find other lyrics" and "Use my own lyrics" are now source choices.
- Popup: new look, new animations (they follow "Reduce motion") and a clearer Separate banner.
- Popup: a **Separate mode** checkbox replaces the Default / Separate tabs. It is hidden when the tab needs a reload.
- Popup: **Global Volume** (0 to 600 %) replaces Master volume and boosts both modes. The Vocal, Instrumental, Drums and Others sliders go from 0 to 100 %.
- High / Best quality: the warm-up remembers your GPU speed, so the next one is about 40 % shorter.
- If you turn Separate mode off and on within 3 minutes, it restarts at once with no warm-up.
- Split instrumental adds its delay on top of the Delay limit.
- During warm-up, seeks, new videos and the end of a video, a spinner and "Preparing vocal separation…" show. Pause works during these waits.
- The time and seek bar show what you hear, not the video position that runs ahead by the delay.

### Fixed

- Lyrics: a long settings list scrolls instead of running off the top.
- Lyrics: YouTube settings now match YouTube's own menus in spacing, width and animation.
- Lyrics: a short LRCLIB server error is retried once.

## [0.3.0] - 2026-10-18

### Added

- **Split instrumental** (Separate tab > Advanced, off by default). A second model (41 MB, one-time download) takes the drums out of the instrumental. New **Drums** and **Others** sliders (0 to 600 %) sit inside the Instrumental slider. For example, Instrumental 50 % with Drums 100 % plays the drums at 50 %. It adds about 4 s of delay with the Default model. With High / Best quality it needs a fast GPU and a delay limit of 8 s or more (the popup raises it). On an M1 it says "too slow".
- **High quality** and **Best quality** models in the Model menu, next to Default. They separate the voice much more cleanly but need a fast GPU. Each is a one-time download (440 MB / 240 MB) from a public Hugging Face repo. The popup offers updates. The extension package is about 0.45 GB smaller.
- **Delay limit** slider (2 to 15 s, default 2 s) in Advanced. The delay never goes above it, and a longer limit gives a cleaner split. It works for the Default model too (3 s or more). **Apply** re-runs the warm-up (10 to 40 s, with the video paused).
- Karaoke / A cappella now give a cleaner voice, without the buzzing. Karaoke removes the leftover voice. The added delay is 1.97 s (was 0.30 s), and the video is delayed to match. Without WebGPU, or if your device cannot keep up, the original mix plays.
- Popup: the Model menu, its download line and the Delay limit moved into an **Advanced** section at the bottom of the Separate tab.
- Volume boost and Separate mode now work on any site with a video or audio player, not only YouTube. Lyrics stay on YouTube and YouTube Music.
- Lyrics: a "Lyrics source" menu (Auto / LRCLIB / YouTube captions) in the footer. Auto shows which source it uses. The caption language menu lists every track, including auto-generated ones.
- Lyrics: "Lyrics timing" (−2 s to +2 s) and timing keys (`[` and `]`, 0.1 s) shift synced lyrics for the current video. The timing is remembered per video.
- Lyrics: "Find other lyrics…", "Use my own lyrics…" (paste or load a `.lrc` / `.txt`), "Copy lyrics" and "Save as .lrc".
- Karaoke text: a "Custom Karaoke Text" group with Color, Size, Font, Outline, Background, Style presets (plus "My style" and "Reset style"), Line transition, Position and Lyrics-only view. Right-click the text for a menu of presets.
- Karaoke text: the current line turns blue from left to right while it is sung. A "Reset position" button puts the text back.

### Changed

- youtube.com: CC turns on for a moment to load captions after a page load and after you switch between Default and Separate mode. Then it returns to how it was.
- Karaoke keeps more of the instrumental while someone sings.
- Karaoke text: when no line is sung, the text is hidden. The next line shows only in the last 3 s before it starts. With 2 lines, the rows stay in place.
- The ♪ button shows or hides the lyrics. Choose karaoke text or the lyrics window in "Lyrics display". Lyrics settings are grouped in one "Lyrics" row in the player's menu.
- Lyrics panel: the text grows with the panel, lines are centered, and a "Centered / Free scroll" button unlocks scrolling.
- Lyrics: new automatic order: manual captions, LRCLIB synced, auto-generated captions, other captions, LRCLIB plain.

## [0.2.0] - 2026-10-06

### Added

- Lyrics: when LRCLIB has no synced lyrics, the video's subtitles show. With no subtitles either, the auto-generated transcript shows, with word highlight. On YouTube Music the transcript stays in the floating panel, so the Lyrics tab keeps YouTube Music's own lyrics.
- Lyrics: a caption language menu in the footer when the lyrics come from captions and the video has more than one caption track. Your pick is used for the next videos in the same tab.

### Removed

- The Light separation engine and the Auto / Light / Quality selector in the popup.

### Changed

- A cappella: less of the instrumental leaks into the vocal.
- Separate mode always uses the ML engine. While it warms up, or when it cannot run (no WebGPU, model load failure, too slow, wrong audio sample rate) or stops after missed deadlines, the original mix plays with no delay, and the popup says why. Switch to Default and back to try again.

## [0.1.0] - 2026-10-05

First release. Chrome extension for youtube.com and music.youtube.com.

### Added

- **Volume boost.** A Master slider from 0 % to 600 % with a limiter that keeps the sound clean. Page audio is not touched until the slider leaves 100 %.
- **Vocal / instrumental mixing (Separate mode).** Separate sliders for vocal and instrumental, with Karaoke, A cappella and Reset presets. The popup shows the status, the warm-up and the added delay.
- **Video delay.** In Separate mode the video is delayed so picture and processed sound stay in sync.
- **Synced lyrics.**
  - Lyrics from LRCLIB, including word timing, with track matching. Placeholder and vandalised records are rejected.
  - If LRCLIB has no lyrics, the video's own captions are used, also when you turn CC on later.
  - YouTube Music: lyrics show in the player's Lyrics tab, which is enabled when the site has none.
  - YouTube: a floating side panel you can drag, resize and use in full screen. It has highlight, auto-scroll and click-to-seek. Scrolling with the keyboard in the panel does not reach the YouTube player.
- **Per-tab settings.** Settings are kept per browser tab, survive page changes and reloads, and are cleared when the tab closes.
