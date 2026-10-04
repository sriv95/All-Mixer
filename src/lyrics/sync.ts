import type { LyricLine, LyricWord } from './types';

/** Index of the last item with `start <= t`, or -1 when t is before the first. */
function lastStartingAtOrBefore(items: readonly { start: number }[], t: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function findLineIndex(lines: readonly LyricLine[], t: number): number {
  return lastStartingAtOrBefore(lines, t);
}

export function findWordIndex(line: LyricLine, t: number): number {
  return line.words ? lastStartingAtOrBefore(line.words, t) : -1;
}

/** Returns new lines with every line and word time shifted by `seconds` (no clamping). */
export function applyOffset(lines: readonly LyricLine[], seconds: number): LyricLine[] {
  return lines.map((l) => {
    const out: LyricLine = { ...l, start: l.start + seconds, end: l.end + seconds };
    if (l.words) {
      out.words = l.words.map((w): LyricWord => ({ ...w, start: w.start + seconds, end: w.end + seconds }));
    }
    return out;
  });
}
