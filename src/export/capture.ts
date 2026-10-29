// Recording of what the player plays. HTMLMediaElement.captureStream() gives the audio, read as AudioData with
// MediaStreamTrackProcessor, which needs no AudioContext (and so no click on the page). The capture keeps working while the
// element is muted and after the live audio graph took the element over.

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
