# Fast audio: reading what the player already downloaded

## Problem

Export (MP3) and Preload Audio record the playing `<video>` in real time (`captureStream`), so a 3.5 minute song takes 3.5 minutes
before the model even has everything. The model itself runs faster than real time on most GPUs (the 3:33 test song took 66 s of
model time on an M1), so the recording is the bottleneck. A "paste a link, get an MP3" site is fast because it downloads the
audio stream instead of playing it.

## Options

| | A. Fetch the stream URL ourselves (what `yt-dlp` does) | B. Copy what the player appends to its MediaSource | C. Record faster (`playbackRate` 2) |
|---|---|---|---|
| Speed | Network speed | Network speed (the player downloads at network speed, we make it download all of it) | 2× at best |
| Quality | Original | Original (the same bytes the player plays) | Loses everything above half the Nyquist (about 11 kHz at 2×) |
| Works on YouTube today | Signed URLs, `n` throttling parameter and PO tokens: it breaks every few weeks and needs the cipher logic | The player has already done all that | Yes |
| Terms of service | Clearly a downloader | Reads media the player received; the real-time recording we ship already captures the same sound | Same as today |
| Complexity | High, and it never stops changing | Medium: a page hook, a WebM parser, a decode | Low |

**Decision: B**, with the real-time recording kept as the fallback for everything it cannot do.

## How it works

1. `src/page/audio-tap.ts` runs in the page's main world at `document_start` (inside the page bridge). It wraps
   `URL.createObjectURL`, `MediaSource.addSourceBuffer` and `SourceBuffer.appendBuffer`, and keeps a copy of every audio
   append (`audio/webm`, Opus: what Chrome gets from YouTube). The player gets the same bytes it always did.
   * `ClusterStore` sorts the appends into the init segment and Clusters by Cluster timecode. A segment arrives in pieces
     and a seek can cut one short, so a Cluster counts as whole only when the bytes received equal the size in its header;
     the whole copy wins over a short one.
   * `Coverage` unions the player's `sourceBuffer.buffered` after every `updateend`: it remembers what was buffered even after
     the player evicts it.
   * The tap gives up (and the export records) for an `audio/mp4` track, a changed init segment (a different format), an append
     with a `timestampOffset` (ads share the element), data that is no Cluster, or more than 160 MB.
2. `src/export/fast-audio.ts` (in the export engine) pauses the video and, until the tap covers the whole video, seeks to the
   first part that is missing and waits for the player to fetch it. On a normal connection the player fetches 10 to 60 s of audio
   per seek; a 3:33 song took 7 to 8 seeks and under a second.
3. The tap hands back one file (init segment, Clusters in order), decoded with `OfflineAudioContext(…, 44100).decodeAudioData`
   at the export rate, so no resampler is needed. A decoded length that is not the video's length (±1 s) means a hole or a
   second timeline: the result is dropped and the export records.
4. `record()` in `src/export/engine.ts` then feeds the sound to the same chunking and `OfflineSeparator` the recording
   used. The video gets its place back (position, speed, muted, playing) as soon as the read is done, so the user can go on
   watching while the model works. If the video changes during the read, the run stops like a recording does.

Not used for videos over 20 minutes (the whole sound is decoded at once:
353 KB per second of Float32 stereo; `FAST_MAX_S`), and on other sites than YouTube / YouTube Music. `chrome.storage.local`
key `debug.noFastAudio` = `true` turns it off (QA of the recording path).

## Limits

* Opus (WebM) only. A player that gets AAC (`audio/mp4`) records as before. *shortcut:* add an fMP4 parser when that is common.
* The video must be the one that was loaded with the extension active (the tap installs at `document_start`); a tab opened before
  the extension was installed or reloaded records until it is reloaded.
* The timeline is the container's: a sample at media time `t` is `t` seconds into the decoded sound. The recording had the
  capture latency of `captureStream` on top (tens of milliseconds, not constant).
* It reads a copy of the player's audio. Anything that stops the player from fetching (offline, a paused-by-the-site player,
  an ad) ends in the recording fallback or in the ad message the recording shows.

## Tests

* Unit: `webm.test.ts`, `audio-tap.test.ts` (Clusters in pieces, repeated, cut short, format changes, limits), `fast-audio.test.ts`
  (the seek loop, every reason for null, stall, cancel, ad), `engine.fast.test.ts` (the engine with a fake player and model: the
  whole sound reaches the separator once and in order, the video is given back, every fallback, cancel, back-pressure).
* Browser (`scripts/smoke-fast-audio.mjs`, real youtube.com, the built extension): the copy covers the video and decodes to its
  length; its sound sits on the sound the player plays (cross-correlation at 0 s and at 70 % of the video); Preload through the
  popup uses the `fetching` stage and ends in a cache that plays in step; with `COMPARE=1` the same preload with the recording.
  `scripts/smoke-export.mjs` for MP3 and MP4 (`NOAUDIO=1` for the silent MP4).
