import type { TapData, TapStatus } from '../shared/bridge';
import { EXPORT_SAMPLE_RATE } from '../shared/export';

// The YouTube player downloads a video's audio far faster than it plays it. The page bridge keeps a copy of what the player
// appends (src/page/audio-tap.ts); this module makes the player download all of it (seek to the first part it lacks, wait, repeat),
// then decodes the copy. The export / preload then runs on that sound at once instead of recording the video in real time.

/** The page side of the tap, through the bridge (src/content/lyrics/bridge-client.ts). */
export interface AudioTap {
  status(url: string): Promise<TapStatus | null>;
  take(url: string): Promise<TapData | null>;
}

export interface Pcm {
  l: Float32Array;
  r: Float32Array;
}

// shortcut: the whole sound is decoded at once (353 KB per second of stereo Float32), so longer videos are recorded; decode in windows to lift this.
export const FAST_MAX_S = 1200;
/** A hole or an edge this small is not one (the audio track can end a little before the video does). */
const TOL_S = 0.4;
/** The seek lands this far before the hole, so the segment that holds its first sample is requested. */
const BACK_S = 0.3;
const POLL_MS = 100;
/** The player did not bring any new audio for this long after a seek. */
const STALL_MS = 8000;
const TRIES_PER_HOLE = 3;
/** The decoded sound may differ from the video's duration by this much (rounding of the last segment). */
const DURATION_SLACK_S = 1;

/** Where the audio we hold first stops being whole: the end of the first range from 0, or the start of an incomplete segment. Null = whole. */
export function firstHole(s: Pick<TapStatus, 'covered' | 'incomplete'>, durationS: number): number | null {
  let t = 0;
  for (const [a, b] of s.covered) {
    if (a > t + TOL_S) break;
    t = Math.max(t, b);
  }
  const edge = t >= durationS - TOL_S ? null : t;
  const cut = s.incomplete[0];
  return cut === undefined ? edge : edge === null ? cut : Math.min(edge, cut);
}

export interface FastDeps {
  video: HTMLVideoElement;
  tap: AudioTap;
  signal: AbortSignal;
  /** 0–1 of the video's audio that is held. */
  progress(fraction: number): void;
  /** A message when the player is not playing the video itself (an ad); it ends the run with that error. */
  problem?: () => string | null;
  /** Tests. */
  decode?: (data: ArrayBuffer) => Promise<{ duration: number; channels: Float32Array[] }>;
  sleep?: (ms: number) => Promise<void>;
}

const decodeAudio = async (data: ArrayBuffer): Promise<{ duration: number; channels: Float32Array[] }> => {
  const buf = await new OfflineAudioContext(2, 1, EXPORT_SAMPLE_RATE).decodeAudioData(data);
  return { duration: buf.duration, channels: Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i)) };
};

/**
 * The whole sound of the video at EXPORT_SAMPLE_RATE, or null when it cannot be had this way (no tap, an MP4 audio track, the
 * player did not deliver a part, the decoded length does not fit): the caller then records the video. The video is left paused,
 * muted and moved around: the caller puts it back.
 */
export async function fastAudio(d: FastDeps): Promise<Pcm | null> {
  const { video: v, tap, signal } = d;
  const dur = v.duration;
  const url = v.currentSrc;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!url || !Number.isFinite(dur) || dur <= 0 || dur > FAST_MAX_S) return null;
  v.pause();
  v.muted = true;
  let tries = 0;
  let lastHole = -1;
  for (;;) {
    if (signal.aborted) return null;
    const s = await tap.status(url);
    if (!s?.usable) return null;
    const hole = firstHole(s, dur);
    d.progress(hole === null ? 1 : Math.min(1, hole / dur));
    if (hole === null) break;
    if (Math.abs(hole - lastHole) < TOL_S) {
      if (++tries >= TRIES_PER_HOLE) return null;
    } else {
      lastHole = hole;
      tries = 0;
    }
    v.currentTime = Math.max(0, Math.min(hole - BACK_S, dur - 1));
    // Wait for the player to bring audio past the hole.
    for (const t0 = Date.now(); ; ) {
      await sleep(POLL_MS);
      if (signal.aborted) return null;
      const problem = d.problem?.();
      if (problem) throw new Error(problem);
      const now = await tap.status(url);
      if (!now?.usable) return null;
      const next = firstHole(now, dur);
      if (next === null || Math.abs(next - hole) >= TOL_S) break;
      if (Date.now() - t0 > STALL_MS) break;
    }
  }
  const file = await tap.take(url);
  if (!file || signal.aborted) return null;
  let pcm: { duration: number; channels: Float32Array[] };
  try {
    pcm = await (d.decode ?? decodeAudio)(file.data);
  } catch {
    return null;
  }
  // A missing segment shows as a shorter sound; a second timeline in the same source (an ad) as a longer one.
  if (Math.abs(pcm.duration - dur) > DURATION_SLACK_S || pcm.channels.length === 0) return null;
  const l = pcm.channels[0]!;
  return { l, r: pcm.channels[1] ?? l };
}
