# SRI-14 spike: delay the video to match delayed audio (D1)

- `delayed-video.js`: prototype. rVFC captures each frame (`createImageBitmap` at display size, or `new VideoFrame`), a rAF loop draws the frame whose `expectedDisplayTime + delay` has passed onto a canvas laid over the `<video>`.
- `bench.html` + `run.mjs`: local bench (1080p60 / 720p30 VP9 test clips, D = 50/150/300/500 ms, delay changes, seek, pause, resize).
- `yt-probe.mjs`: injects the prototype into a real youtube.com / music.youtube.com watch page.
- `results-2026-10-04.json`: raw numbers. The summary and decision are in the SRI-14 comment.

```sh
# test clips (no audio needed, any VP9 webm works)
ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=60 -t 30 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 6M clips/v1080p60.webm
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30  -t 30 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 3M clips/v720p30.webm
CLIPS=$PWD/clips PW=/path/to/node_modules/playwright HEADFUL=1 node spike/avsync/run.mjs       # matrix + events
CLIPS=$PWD/clips PW=/path/to/node_modules/playwright HEADFUL=1 node spike/avsync/run.mjs cpu   # interleaved CPU
PW=/path/to/node_modules/playwright node spike/avsync/yt-probe.mjs 'https://www.youtube.com/watch?v=…' 300
```
