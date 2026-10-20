# All Mixer!

Chrome extension for YouTube and YouTube Music.

- **Boost sound.** Global volume goes up to 600 %, with a limiter that keeps the sound clean.
- **Separate mode.** Mix the vocal and the instrumental of any song live: turn the singer down for karaoke, or turn the band down to hear the voice. Optional Split instrumental gives drums, guitar, bass and piano their own levels.
- **Pitch.** Shift the pitch up or down by up to 6 semitones. The speed stays the same.
- **Synced lyrics.** Lyrics follow the song on YouTube and YouTube Music, as a floating panel, a karaoke overlay, or the native Lyrics tab.

## Install

1. Download `all-mixer-vX.Y.Z.zip` from the [latest release](../../releases/latest) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the unzipped folder.
4. Reload any open YouTube tabs, then click the toolbar icon.

## Use

1. Open a video on youtube.com or music.youtube.com and click the All Mixer! icon.
2. Move **Global Volume** to boost the sound.
3. Tick **Separate mode** to mix vocal and instrumental. The first time, the popup offers a one-time model download for the higher quality models. Separate mode needs a computer with a GPU (WebGPU).
4. Under **Advanced** you can change the model, the delay limit, the GPU and Split instrumental.

Separate mode delays the sound by about 2 seconds; the picture is delayed by the same time so they stay in sync. A longer delay limit gives a cleaner split.

## Privacy

Everything runs on your computer. The extension only contacts the lyrics service LRCLIB (for lyrics) and Hugging Face (to download the models you choose).

## For developers

Build, architecture, model publishing and debug notes are in [src/README.md](src/README.md).
