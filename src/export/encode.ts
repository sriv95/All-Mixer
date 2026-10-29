import { Mp3Encoder } from '@breezystack/lamejs';
import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny';
import { EXPORT_SAMPLE_RATE, TRACK_LABEL, type TrackId } from '../shared/export';
import { trackFile } from './mix';
import { zip } from './zip';

export interface ExportFile {
  name: string;
  blob: Blob;
}

/** Where the audio of every track and the picture go. Built from a recording that is cut in chunks; the sink does not care about the cuts. */
export interface Sink {
  /** The picture surface (MP4 only): draw a frame, then `addFrame`. */
  canvas?: OffscreenCanvas;
  /** Samples of one track, `start` = the index of its first sample. Pieces of a track come in order. */
  addAudio(track: TrackId, l: Float32Array, r: Float32Array, start: number): Promise<void>;
  addFrame?(seconds: number, duration: number): Promise<void>;
  /** What the MP4 was encoded with, for the progress line. */
  describe(): string;
  finish(): Promise<ExportFile>;
  cancel(): Promise<void>;
}

const MP3_KBPS = 192;
const AUDIO_BITRATE = 192_000;
/** Bits per pixel and frame of the MP4: about 2.8 Mb/s at 720p30. */
const BITS_PER_PIXEL = 0.1;
export const VIDEO_FPS = 30;

/**
 * Samples the AAC encoder of Chrome (macOS) emits before the first real one. Without a correction the sound would start this
 * late against the picture: the audio goes in this much early, and the negative part is trimmed by the MP4's edit list.
 * shortcut: one value for every platform, measured with a flash-and-beep clip; the encoders of other systems may differ by a few ms.
 */
const AAC_PRIMING = 2112;

function sample(l: Float32Array, r: Float32Array, start: number, shift = 0): AudioSample {
  const data = new Float32Array(l.length * 2);
  data.set(l, 0);
  data.set(r, l.length);
  return new AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: EXPORT_SAMPLE_RATE, timestamp: (start - shift) / EXPORT_SAMPLE_RATE });
}

/** Samples per call of the MP3 encoder (a multiple of the 1152-sample frame, about 0.8 s): the page gets a breath in between. */
const MP3_STEP = 1152 * 32;
/** A turn for the page between two encoder steps. A message, not a timer: a hidden tab runs timers once a second. */
export const breathe = (): Promise<void> =>
  new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(0);
  });
const pcm16 = (x: Float32Array): Int16Array => Int16Array.from(x, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))));

/**
 * MP3: a file per track. One track is the file itself; several are a zip of numbered files in a folder named like the export.
 * LAME in JavaScript (lamejs), on the page's own thread in short steps: the page's CSP does not let a content script start the
 * Web Worker that the WebAssembly MP3 encoders use, and the browser has no MP3 encoder of its own.
 */
export async function mp3Sink(tracks: readonly TrackId[], name: string): Promise<Sink> {
  const encoders = new Map(tracks.map((id) => [id, { encoder: new Mp3Encoder(2, EXPORT_SAMPLE_RATE, MP3_KBPS), parts: [] as Uint8Array<ArrayBuffer>[] }]));
  return {
    async addAudio(track, l, r) {
      const e = encoders.get(track)!;
      for (let at = 0; at < l.length; at += MP3_STEP) {
        const out = e.encoder.encodeBuffer(pcm16(l.subarray(at, at + MP3_STEP)), pcm16(r.subarray(at, at + MP3_STEP)));
        if (out.length) e.parts.push(new Uint8Array(out));
        await breathe();
      }
    },
    describe: () => `MP3 ${MP3_KBPS} kb/s`,
    async finish() {
      const files = tracks.map((id, i) => {
        const e = encoders.get(id)!;
        return { name: `${trackFile(id, i)}.mp3`, blob: new Blob([...e.parts, new Uint8Array(e.encoder.flush())], { type: 'audio/mpeg' }) };
      });
      if (files.length === 1) return { name: `${name}.mp3`, blob: files[0].blob };
      const entries = await Promise.all(files.map(async (f) => ({ name: `${name}/${f.name}`, data: new Uint8Array(await f.blob.arrayBuffer()) })));
      return { name: `${name}.zip`, blob: new Blob([zip(entries)], { type: 'application/zip' }) };
    },
    async cancel() {},
  };
}

/** Even sizes (H.264 needs them) of the 16:9 picture at `height`. */
export function pictureSize(height: number): { w: number; h: number } {
  const h = Math.max(2, Math.round(height / 2) * 2);
  return { h, w: Math.round((h * 16) / 9 / 2) * 2 };
}

/**
 * MP4: the picture (the karaoke text) and one audio stream per track, none for a silent one. Stream 0 is the mix and the default stream (what a player plays); the stems follow,
 * each with its name. H.264 + AAC when the browser can encode them, else the best it can (VP9 / AV1, Opus).
 */
export async function mp4Sink(tracks: readonly TrackId[], name: string, size: { w: number; h: number }): Promise<Sink> {
  const format = new Mp4OutputFormat();
  const videoCodec: VideoCodec | null = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'].filter((c) => format.getSupportedVideoCodecs().includes(c as VideoCodec)) as VideoCodec[], { width: size.w, height: size.h });
  if (!videoCodec) throw new Error('This browser cannot encode video for an MP4');
  const audioCodec: AudioCodec | null = tracks.length ? await getFirstEncodableAudioCodec(['aac', 'opus'].filter((c) => format.getSupportedAudioCodecs().includes(c as AudioCodec)) as AudioCodec[], { numberOfChannels: 2, sampleRate: EXPORT_SAMPLE_RATE }) : null;
  if (tracks.length && !audioCodec) throw new Error('This browser cannot encode audio for an MP4');
  const output = new Output({ format, target: new BufferTarget() });
  const canvas = new OffscreenCanvas(size.w, size.h);
  const video = new CanvasSource(canvas, { codec: videoCodec, bitrate: Math.round(size.w * size.h * VIDEO_FPS * BITS_PER_PIXEL) });
  output.addVideoTrack(video, { frameRate: VIDEO_FPS });
  const sources = new Map<TrackId, AudioSampleSource>();
  tracks.forEach((id, i) => {
    const source = new AudioSampleSource({ codec: audioCodec!, bitrate: AUDIO_BITRATE });
    sources.set(id, source);
    output.addAudioTrack(source, { name: TRACK_LABEL[id], languageCode: 'und', disposition: { default: i === 0 } });
  });
  await output.start();
  return {
    canvas,
    async addAudio(track, l, r, start) {
      const s = sample(l, r, start, audioCodec === 'aac' ? AAC_PRIMING : 0);
      try {
        await sources.get(track)!.add(s);
      } finally {
        s.close();
      }
    },
    addFrame: (seconds, duration) => video.add(seconds, duration),
    describe: () => `${videoCodec.toUpperCase()} ${size.h}p${audioCodec ? ` + ${audioCodec.toUpperCase()}` : ''}`,
    async finish() {
      video.close();
      for (const s of sources.values()) s.close();
      await output.finalize();
      return { name: `${name}.mp4`, blob: new Blob([(output.target as BufferTarget).buffer!], { type: 'video/mp4' }) };
    },
    cancel: () => output.cancel().catch(() => {}),
  };
}
