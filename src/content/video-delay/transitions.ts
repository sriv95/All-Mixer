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

export const MARGIN_MS = 1000;
/** A play edge may precede the event stamp by a hair (expectedDisplayTime is rounded); never by a whole frame or two. */
export const PLAY_SLACK_MS = 50;

/** Window end offset: WINDOW_MS, or more when the overlay delay and separator latency push the edges later. */
export const windowSpanMs = (delayMs = 0, latencyMs = 0): number =>
  delayMs > 0 || latencyMs > 0 ? Math.max(WINDOW_MS, Math.max(0, delayMs) + Math.max(0, latencyMs) + MARGIN_MS) : WINDOW_MS;

export const windowFor = (kind: 'pause' | 'play', at: number, delayMs = 0, latencyMs = 0): [number, number] => [
  kind === 'pause' ? at - PRE_PAUSE_MS : at,
  at + windowSpanMs(delayMs, latencyMs),
];

/**
 * Pairing rule: a transition takes the first edge of each source that matches its kind
 * (play: 'on', pause: 'off') inside its window, and each edge is taken by at most one
 * transition (`used`, filled here). Overlapping windows (a quick pause/play, or a second
 * play event) therefore never pair the same canvas or video frame twice.
 */
export function pairTransition(
  kind: 'pause' | 'play',
  at: number,
  edges: readonly PairEdge[],
  delayMs = 0,
  latencyMs = 0,
  used: Set<PairEdge> = new Set(),
): Transition {
  const [lo0, hi] = windowFor(kind, at, delayMs, latencyMs);
  const lo = kind === 'play' ? lo0 - PLAY_SLACK_MS : lo0;
  const want = kind === 'pause' ? 'off' : 'on';
  const first = (source: EdgeSource): PairEdge | undefined => {
    const e = edges.filter((x) => x.source === source && x.kind === want && x.t >= lo && x.t <= hi && !used.has(x)).sort((a, b) => a.t - b.t)[0];
    if (e) used.add(e);
    return e;
  };
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
