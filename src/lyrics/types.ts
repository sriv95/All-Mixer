/**
 * Lyrics engine data model (F1 / F2). Shared by the parser, the LRCLIB client,
 * the caption aligner and the renderers. All times are in seconds of media time
 * (i.e. `video.currentTime`), after any offset has been applied.
 */

export interface LyricWord {
  /** Start time of this word, seconds. */
  start: number;
  /** End time (start of the next word, or the line end), seconds. */
  end: number;
  /** Word text including any trailing space, so `words.map(w => w.text).join('')` equals the line text. */
  text: string;
}

export interface LyricLine {
  /** Start time, seconds. Lines are sorted by `start`. */
  start: number;
  /** End time (start of the next line, or start + a few seconds for the last line), seconds. */
  end: number;
  text: string;
  /** Present only when word-level timing is known (enhanced LRC or auto-captions). */
  words?: LyricWord[];
}

export type LyricsSource = 'lrclib' | 'youtube-captions';

export interface SyncedLyrics {
  kind: 'synced';
  lines: LyricLine[];
  source: LyricsSource;
  /** Seconds added to every LRC timestamp to match this video (caption alignment). 0 when unknown. */
  offset: number;
  /** True when at least one line has `words`. */
  hasWordTiming: boolean;
}

export interface PlainLyrics {
  kind: 'plain';
  text: string;
  source: LyricsSource;
}

export type Lyrics = SyncedLyrics | PlainLyrics;

/** What we know about the playing track, used to query LRCLIB. */
export interface TrackInfo {
  videoId: string;
  title: string;
  artist: string;
  album?: string;
  /** Seconds, from the <video> / player response. */
  duration: number;
}
