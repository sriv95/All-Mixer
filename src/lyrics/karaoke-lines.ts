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

/**
 * Picks the lines to show as karaoke text at time `t`. While a line is active it is `current`
 * (plus the next line as `upcoming` for 2 lines). In a gap, 2-line mode shows only the next
 * non-blank line as `upcoming` (never two idle lines, so it is clear which line comes next), and it
 * turns `current` in the same row; 1-line mode shows nothing.
 * In 2-line mode the rows are fixed: lines alternate between row 0 and row 1, so a line that ended is
 * replaced in place by the line after next, and nothing scrolls up.
 */
export function selectKaraokeLines(lines: readonly LyricLine[], t: number, count: 1 | 2): KaraokeView {
  const cur = findLineIndex(lines, t);
  const line = cur >= 0 ? lines[cur] : undefined;
  const hasEnd = line !== undefined && line.end > line.start;
  const active = line !== undefined && !isBlank(line.text) && (!hasEnd || t < line.end);
  const rowOf = (i: number): 0 | 1 => (count === 2 ? ((ordinalOf(lines, i) % 2) as 0 | 1) : 0);
  const slot = (i: number, state: KaraokeSlot['state']): KaraokeSlot => ({ index: i, row: rowOf(i), text: lines[i].text, state });

  const slots: KaraokeSlot[] = [];
  if (active) {
    slots.push(slot(cur, 'current'));
    if (count === 2 && cur + 1 < lines.length && !isBlank(lines[cur + 1].text)) slots.push(slot(cur + 1, 'upcoming'));
  } else if (count === 2) {
    const a = nextNonBlank(lines, cur + 1);
    if (a >= 0) slots.push(slot(a, 'upcoming'));
  }
  slots.sort((x, y) => x.row - y.row);
  return { slots, currentIndex: cur };
}
