/**
 * Caption alignment (D2): use YouTube timed text to fix LRCLIB timing for this
 * particular video and to add word-level timing.
 *
 * LRCLIB timestamps follow the album audio. Music videos often add an intro or
 * cut, so we estimate one global offset by letting every (caption word, LRC
 * word) pair with the same text vote for `captionTime - lrcTime`; the densest
 * cluster of votes wins. Mismatched pairs (common words) spread across all
 * offsets and only raise the noise floor.
 */
import type { LyricLine, LyricWord, SyncedLyrics } from './types';
import { captionWords, type CaptionCue, type CaptionWord } from './captions';
import { applyOffset } from './sync';

export const MAX_OFFSET_S = 90;
const BIN_S = 0.25;
/** Votes are summed over ±WINDOW_BINS bins (±0.5 s) to tolerate caption jitter. */
const WINDOW_BINS = 2;
const MIN_VOTES = 6;

/** Lowercase, strip accents and punctuation. Returns '' for tokens that carry no information. */
export function normWord(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

interface TimedToken {
  t: number;
  w: string;
}

/** LRC words with times; lines without word timing spread their words evenly over the line. */
export function lrcTokens(lines: readonly LyricLine[]): TimedToken[] {
  const out: TimedToken[] = [];
  for (const l of lines) {
    if (l.words) {
      for (const w of l.words) for (const tok of tokenize(w.text)) out.push({ t: w.start, w: tok });
      continue;
    }
    const toks = tokenize(l.text);
    const dur = Math.max(0.5, Math.min(l.end - l.start, 8));
    toks.forEach((w, i) => out.push({ t: l.start + (dur * i) / toks.length, w }));
  }
  return out;
}

function tokenize(s: string): string[] {
  return s.split(/\s+/).map(normWord).filter(Boolean);
}

export interface OffsetEstimate {
  offset: number;
  /** Votes in the winning window. */
  votes: number;
  /** Winning votes divided by the best window at least 3 s away; >1.5 is a clear peak. */
  peakRatio: number;
}

/** Best global offset (seconds, add to LRC times) or null when the evidence is weak. */
export function estimateOffset(lines: readonly LyricLine[], words: readonly CaptionWord[]): OffsetEstimate | null {
  const lrc = lrcTokens(lines);
  const byWord = new Map<string, number[]>();
  for (const tok of lrc) {
    const list = byWord.get(tok.w);
    if (list) list.push(tok.t);
    else byWord.set(tok.w, [tok.t]);
  }

  const nBins = Math.round((2 * MAX_OFFSET_S) / BIN_S) + 1;
  const hist = new Float64Array(nBins);
  for (const cw of words) {
    const w = normWord(cw.text);
    const times = w ? byWord.get(w) : undefined;
    if (!times) continue;
    // Rare words are stronger evidence than "the" / "I"; weight by 1/frequency.
    const weight = 1 / times.length;
    for (const t of times) {
      const d = cw.start - t;
      if (Math.abs(d) > MAX_OFFSET_S) continue;
      hist[Math.round((d + MAX_OFFSET_S) / BIN_S)] += weight;
    }
  }

  const win = new Float64Array(nBins);
  let acc = 0;
  for (let i = 0; i < nBins + WINDOW_BINS; i++) {
    if (i < nBins) acc += hist[i];
    if (i - 2 * WINDOW_BINS - 1 >= 0) acc -= hist[i - 2 * WINDOW_BINS - 1];
    const c = i - WINDOW_BINS;
    if (c >= 0 && c < nBins) win[c] = acc;
  }

  let best = 0;
  for (let i = 1; i < nBins; i++) if (win[i] > win[best]) best = i;
  const minGap = Math.round(3 / BIN_S);
  let runnerUp = 0;
  for (let i = 0; i < nBins; i++) if (Math.abs(i - best) >= minGap) runnerUp = Math.max(runnerUp, win[i]);

  const votes = win[best];
  const peakRatio = runnerUp > 0 ? votes / runnerUp : Infinity;
  if (votes < MIN_VOTES || peakRatio < 1.5) return null;

  // Refine to the weighted centre of the winning window.
  let sum = 0;
  let wsum = 0;
  for (let i = Math.max(0, best - WINDOW_BINS); i <= Math.min(nBins - 1, best + WINDOW_BINS); i++) {
    sum += hist[i] * (i * BIN_S - MAX_OFFSET_S);
    wsum += hist[i];
  }
  const offset = Math.round((sum / wsum) * 100) / 100;
  return { offset, votes, peakRatio };
}

/**
 * Give lines without word timing per-word times from ASR caption words.
 * Words are matched in order (LCS) within the line's time window; unmatched
 * words are interpolated. Lines with fewer than half their words matched are
 * left unchanged.
 */
export function addWordTiming(lines: readonly LyricLine[], words: readonly CaptionWord[]): LyricLine[] {
  const cap = words.map((w) => ({ t: w.start, w: normWord(w.text) })).filter((w) => w.w);
  return lines.map((line) => {
    if (line.words) return line;
    const parts = splitKeepSpace(line.text);
    const toks = parts.map((p) => normWord(p));
    const real = toks.filter(Boolean).length;
    if (real === 0) return line;

    const lo = line.start - 0.75;
    const hi = line.end + 0.25;
    const window = cap.filter((c) => c.t >= lo && c.t < hi);
    const pairs = lcs(toks, window.map((c) => c.w));
    if (pairs.length * 2 < real) return line;

    const times: (number | undefined)[] = new Array(parts.length).fill(undefined);
    for (const [i, j] of pairs) times[i] = Math.min(Math.max(window[j].t, line.start), line.end);
    // Keep the first word on the line start so the line and its first word highlight together.
    times[0] = line.start;
    fillGaps(times, line.end);

    const out: LyricWord[] = parts.map((text, i) => ({
      text,
      start: times[i]!,
      end: i + 1 < parts.length ? times[i + 1]! : line.end,
    }));
    return { ...line, words: out };
  });
}

/** Split "a b  c" into ["a ", "b  ", "c"] so that join('') round-trips. */
function splitKeepSpace(s: string): string[] {
  return s.match(/\S+\s*/g) ?? [];
}

/** Index pairs of a longest common subsequence of two token lists ('' never matches). */
function lcs(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] && a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] && a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Linear interpolation of undefined entries; forces non-decreasing order. times[0] must be set. */
function fillGaps(times: (number | undefined)[], end: number): void {
  for (let i = 1; i < times.length; i++) {
    if (times[i] !== undefined && times[i]! < times[i - 1]!) times[i] = times[i - 1];
  }
  let i = 1;
  while (i < times.length) {
    if (times[i] !== undefined) {
      i++;
      continue;
    }
    let k = i;
    while (k < times.length && times[k] === undefined) k++;
    const from = times[i - 1]!;
    // Leave the last words some room before the line end.
    const to = k < times.length ? times[k]! : Math.max(from, end - 0.3);
    const steps = k - i + 1;
    for (let s = i; s < k; s++) times[s] = from + ((to - from) * (s - i + 1)) / steps;
    i = k;
  }
}

/** Lines from manual (non-ASR) captions, for videos with lyric captions but no LRCLIB match. */
export function linesFromCaptions(cues: readonly CaptionCue[]): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const c of cues) {
    const prev = lines[lines.length - 1];
    if (prev && prev.text === c.text && c.start - prev.end < 0.5) {
      prev.end = Math.max(prev.end, c.end);
      continue;
    }
    lines.push({ start: c.start, end: c.end, text: c.text });
  }
  return lines;
}

export interface CaptionTrackData {
  cues: CaptionCue[];
  /** Auto-generated (speech recognition) track. */
  asr: boolean;
}

/**
 * Apply caption evidence to LRCLIB lines: global offset first, then word timing
 * from ASR captions. Lines that already carry enhanced-LRC word timing keep it.
 */
export function alignWithCaptions(lyrics: SyncedLyrics, captions: CaptionTrackData | null): SyncedLyrics {
  if (!captions || captions.cues.length === 0) return lyrics;
  const words = captionWords(captions.cues);
  const est = estimateOffset(lyrics.lines, words);
  let lines = lyrics.lines;
  let offset = lyrics.offset;
  if (est && Math.abs(est.offset) >= 0.2) {
    lines = applyOffset(lines, est.offset);
    offset += est.offset;
  }
  // Without a good offset the line windows miss the caption words, so few lines get word timing; that is fine.
  if (captions.asr) {
    lines = addWordTiming(lines, words);
  }
  return { ...lyrics, lines, offset, hasWordTiming: lines.some((l) => l.words) };
}
