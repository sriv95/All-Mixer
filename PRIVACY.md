# Privacy Policy

**All Mixer! - Karaoke and Live Vocal/Instrumental Separation**
Last updated: 2026-10-25

All Mixer! runs on your computer. It has no account, no server of its own, no analytics and no ads. The developer does not receive any data from you.

## What the extension does with your audio

Volume boost, pitch shifting and Separate mode process the sound of the page you are on, on your computer. The audio, and the vocal and instrumental parts made from it, never leave your device and are never recorded or stored.

The extension runs on all websites so that it can find the video or audio player on the page and change its sound. It does not read, collect or send the text, forms, cookies, passwords or browsing history of any page.

## What the extension sends over the network

Only two services are contacted:

1. **LRCLIB (`lrclib.net`), for synced lyrics.** On YouTube and YouTube Music, the extension sends the title, artist, album (if known) and duration of the current video to look up lyrics. Nothing else is sent, and the request has no account or identifier. LRCLIB is a third-party service with its own policy.
2. **Hugging Face (`huggingface.co`), to download models.** When you choose a higher quality model, the extension downloads its file once from the project's public model repository. The request is a plain file download. No data about you or your audio is sent.

The extension also reads captions from the YouTube page you are watching, to show lyrics when LRCLIB has none. Those captions are read in your browser and not sent anywhere else.

## What the extension stores on your device

- **Settings per tab** (volume, pitch, vocal and instrumental levels, model, and similar): kept in the browser session and cleared when the browser closes.
- **Lyrics cache and lyrics preferences** (display mode, font size, timing offset): kept in the extension's local storage so the same song loads faster.
- **Downloaded models and their version**: kept in the browser's private file storage for the extension.
- **A GPU speed result**: used to choose a safe delay for Separate mode.

All of this stays on your device. Removing the extension deletes it.

## What we do not do

- We do not sell or share user data.
- We do not use data for advertising, profiling or credit decisions.
- We do not use remote code. All code is in the extension package. Downloaded models are data files and are not executed as scripts.

## Permissions

- **`storage`**: saves the settings, lyrics cache and model information above.
- **Access to all websites**: lets the extension find the media player on any site and change its volume, pitch and vocal/instrumental mix. It also reads the YouTube player data needed for lyrics.

## Children

The extension does not knowingly collect any data from anyone, including children.

## Changes

If this policy changes, the new version is published here with a new date. The full history is in the repository's git log.

## Contact

Open an issue at <https://github.com/sriv95/All-Mixer/issues>.
