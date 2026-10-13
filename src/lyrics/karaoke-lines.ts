import type { LyricLine } from './types';
import { findLineIndex } from './sync';

export interface KaraokeSlot {
  index: number;
  /** Fixed row (2-line mode): a line keeps its row until the next line of the same parity replaces it. Always 0 in 1-line mode. */
  row: 0 | 1;
  text: string;
  state: 'current' | 'upcoming';
}

export interface KaraokeView {
  slots: KaraokeSlot[];
  /** Index of the current line, -1 if none. */
  currentIndex: number;
}

const isBlank = (text: string): boolean => text.trim() === '';

function nextNonBlank(lines: readonly LyricLine[], from: number): number {
  for (let i = Math.max(0, from); i < lines.length; i++) if (!isBlank(lines[i].text)) return i;
  return -1;
}

/** Number of non-blank lines before each line, per lyrics array (rows alternate over non-blank lines only). */
const ordinals = new WeakMap<readonly LyricLine[], number[]>();
function ordinalOf(lines: readonly LyricLine[], index: number): number {
  let o = ordinals.get(lines);
  if (!o) {
    o = [];
    let n = 0;
    for (const l of lines) {
      o.push(n);
      if (!isBlank(l.text)) n++;
    }
    ordinals.set(lines, o);
  }
  return o[index] ?? 0;
}

/** An idle line is shown this many seconds before it starts; before that the text is hidden. */
const KARAOKE_LEAD_SECONDS = 3;

/**
 * Estimated time a line takes to sing. LRC lines end where the next one starts, so a line before an
 * instrumental break looks "ongoing" for the whole break. Generous on purpose: it is only used to
 * end a line early when the rest of the gap is long enough to hide the text.
 */
function estimatedSungSeconds(text: string): number {
  return 2 + 0.2 * text.trim().length;
}

/**
 * Picks the lines to show as karaoke text at time `t`.
 * - While a line is ongoing it is `current` (plus the next line as `upcoming` for 2 lines).
 * - When idle (no ongoing line) only the next non-blank line can show, as `upcoming`, in both modes:
 *   never two idle lines, so it is clear which line comes next. It turns `current` in the same row.
 * - It shows only in the last KARAOKE_LEAD_SECONDS before it starts. A longer idle time shows nothing.
 *   A line with no real end (end == next start) counts as over after its estimated sung time, but only
 *   if more than KARAOKE_LEAD_SECONDS of idle time is left, so a line is never cut while it may be sung.
 * In 2-line mode the rows are fixed: lines alternate between row 0 and row 1, so a line that ended is
 * replaced in place by the line after next, and nothing scrolls up.
 */
export function selectKaraokeLines(lines: readonly LyricLine[], t: number, count: 1 | 2): KaraokeView {
  const cur = findLineIndex(lines, t);
  const line = cur >= 0 ? lines[cur] : undefined;
  const hasEnd = line !== undefined && line.end > line.start;
  const next = nextNonBlank(lines, cur + 1);
  const estimatedEnd = line !== undefined ? line.start + estimatedSungSeconds(line.text) : 0;
  const cutEarly = line !== undefined && next >= 0 && t >= estimatedEnd && lines[next].start - estimatedEnd > KARAOKE_LEAD_SECONDS;
  const active = line !== undefined && !isBlank(line.text) && (!hasEnd || t < line.end) && !cutEarly;
  const rowOf = (i: number): 0 | 1 => (count === 2 ? ((ordinalOf(lines, i) % 2) as 0 | 1) : 0);
  const slot = (i: number, state: KaraokeSlot['state']): KaraokeSlot => ({ index: i, row: rowOf(i), text: lines[i].text, state });

  const slots: KaraokeSlot[] = [];
  if (active) {
    slots.push(slot(cur, 'current'));
    if (count === 2 && cur + 1 < lines.length && !isBlank(lines[cur + 1].text)) slots.push(slot(cur + 1, 'upcoming'));
  } else if (next >= 0 && lines[next].start - t <= KARAOKE_LEAD_SECONDS) {
    slots.push(slot(next, 'upcoming'));
  }
  slots.sort((x, y) => x.row - y.row);
  return { slots, currentIndex: cur };
}
