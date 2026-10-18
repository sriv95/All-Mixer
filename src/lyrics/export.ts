import type { LyricLine, Lyrics, TrackInfo } from './types';

/** `[mm:ss.xx]`; centiseconds are rounded first so 59.999 s becomes `[01:00.00]`. */
function lrcTime(seconds: number): string {
  const cs = Math.round(Math.max(0, seconds) * 100);
  const p = (n: number) => String(n).padStart(2, '0');
  return `[${p(Math.floor(cs / 6000))}:${p(Math.floor((cs % 6000) / 100))}.${p(cs % 100)}]`;
}

/** Plain text of the lyrics, one line per row. */
export function lyricsToText(lyrics: Lyrics): string {
  return lyrics.kind === 'plain' ? lyrics.text : lyrics.lines.map((l) => l.text).join('\n');
}

/** A `.lrc` file body: title / artist tags, then one timestamped line per lyric line. */
export function linesToLrc(lines: readonly LyricLine[], track?: Pick<TrackInfo, 'title' | 'artist'>): string {
  const tags = track ? [`[ti:${track.title}]`, `[ar:${track.artist}]`] : [];
  return [...tags, ...lines.map((l) => `${lrcTime(l.start)}${l.text}`)].join('\n') + '\n';
}
