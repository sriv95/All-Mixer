// Recording of what the player plays. HTMLMediaElement.captureStream() gives the audio, read as AudioData with
// MediaStreamTrackProcessor, which needs no AudioContext (and so no click on the page). The capture keeps working while the
// element is muted and after the live audio graph took the element over. The picture is not taken from the captured video
// track: its frames carry the capture clock, not the media time. requestVideoFrameCallback gives each frame with its media time.

type CapturableMedia = HTMLMediaElement & { captureStream?: () => MediaStream };

export interface Capture {
  audio: ReadableStreamDefaultReader<AudioData>;
  stop(): void;
}

export function openCapture(video: HTMLMediaElement): Capture {
  const Processor = (globalThis as unknown as { MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<AudioData> } }).MediaStreamTrackProcessor;
  const capture = (video as CapturableMedia).captureStream;
  if (!Processor || !capture) throw new Error('This browser cannot record the player (captureStream / MediaStreamTrackProcessor)');
  let stream: MediaStream;
  try {
    stream = capture.call(video);
  } catch (e) {
    throw new Error(`The player cannot be recorded: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  const [track] = stream.getAudioTracks();
  if (!track) throw new Error('The video has no audio to record');
  const audio = new Processor({ track }).readable.getReader();
  return {
    audio,
    stop() {
      void audio.cancel().catch(() => {});
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

/** The first two channels of an AudioData as planar floats (a mono source is used for both). */
export function planar(data: AudioData): [Float32Array, Float32Array] {
  const n = data.numberOfFrames;
  const l = new Float32Array(n);
  data.copyTo(l, { planeIndex: 0, format: 'f32-planar' });
  if (data.numberOfChannels < 2) return [l, l.slice()];
  const r = new Float32Array(n);
  data.copyTo(r, { planeIndex: 1, format: 'f32-planar' });
  return [l, r];
}

/** The newest frames of the picture, each with its media time. The picture follows the sound: a frame is held until the output clock passes it. */
export class FrameStore {
  private frames: { t: number; bitmap: ImageBitmap }[] = [];

  constructor(private readonly keep = 36) {}

  push(bitmap: ImageBitmap, t: number): void {
    this.frames.push({ t, bitmap });
    while (this.frames.length > this.keep) this.frames.shift()!.bitmap.close();
  }

  /** The newest frame shown at or before `seconds` (the oldest one if the picture starts later). */
  at(seconds: number): ImageBitmap | null {
    if (!this.frames.length) return null;
    let best = this.frames[0];
    for (const f of this.frames) if (f.t <= seconds) best = f;
    return best.bitmap;
  }

  close(): void {
    for (const f of this.frames) f.bitmap.close();
    this.frames = [];
  }
}

/** Every frame the player presents goes into `store`, scaled to `w` × `h` on the way (a 1080p source costs no more than the output). Returns the stop function. */
export function watchPicture(video: HTMLVideoElement, store: FrameStore, w: number, h: number): () => void {
  let on = true;
  let handle = 0;
  const onFrame: VideoFrameRequestCallback = (_now, meta) => {
    if (!on) return;
    const t = meta.mediaTime;
    void createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' }).then(
      (bitmap) => (on ? store.push(bitmap, t) : bitmap.close()),
      () => {},
    );
    handle = video.requestVideoFrameCallback(onFrame);
  };
  handle = video.requestVideoFrameCallback(onFrame);
  return () => {
    on = false;
    video.cancelVideoFrameCallback(handle);
  };
}
