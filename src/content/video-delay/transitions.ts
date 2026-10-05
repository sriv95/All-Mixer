/**
 * Pairs probe edges with the media event that caused them (SRI-102, debug only).
 * Pure: times are performance.now() ms. Edges outside the event's window are
 * ignored, so quiet passages in the music cannot pose as a pause or a start.
 */

export type EdgeSource = 'audio' | 'video' | 'overlay';

export interface LoggedEdge {
  source: EdgeSource;
  kind: 'on' | 'off';
  /** When it showed / was heard (audio: audibleAt). */
  t: number;
}

export interface Transition {
  kind: 'pause' | 'play';
  at: number;
  playOffsetMs?: number;
  pauseOffsetMs?: number;
  pipelineMs?: number;
  /** Edges not seen in the window, e.g. 'audioOff'. */
  missing: string[];
}

export const PRE_PAUSE_MS = 300;
export const WINDOW_MS = 1500;

/** Edge log entry with audio's input time (for pipelineMs). */
export interface PairEdge extends LoggedEdge {
  inputAt?: number;
}

export const windowFor = (kind: 'pause' | 'play', at: number): [number, number] => [kind === 'pause' ? at - PRE_PAUSE_MS : at, at + WINDOW_MS];

export function pairTransition(kind: 'pause' | 'play', at: number, edges: readonly PairEdge[]): Transition {
  const [lo, hi] = windowFor(kind, at);
  const want = kind === 'pause' ? 'off' : 'on';
  const first = (source: EdgeSource): PairEdge | undefined =>
    edges.filter((e) => e.source === source && e.kind === want && e.t >= lo && e.t <= hi).sort((a, b) => a.t - b.t)[0];
  const audio = first('audio');
  const video = first('video');
  const overlay = first('overlay');
  const missing: string[] = [];
  const tag = want === 'on' ? 'On' : 'Off';
  if (!audio) missing.push(`audio${tag}`);
  if (!video) missing.push(`video${tag}`);
  // The overlay only exists in Separate mode with a delay; absence is not an error.
  const pic = overlay?.t ?? video?.t;
  const offset = audio && pic !== undefined ? audio.t - pic : undefined;
  if (kind === 'pause') return { kind, at, pauseOffsetMs: offset, missing };
  return {
    kind,
    at,
    playOffsetMs: offset,
    pipelineMs: audio && video ? (audio.inputAt ?? audio.t) - video.t : undefined,
    missing,
  };
}
