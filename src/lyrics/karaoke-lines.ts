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
 * (plus the next line as `upcoming` for 2 lines). In a gap, 2-line mode shows the next two
 * non-blank lines as `upcoming`, so a line turns `current` in the same row; 1-line mode shows nothing.
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
    if (a >= 0) {
      slots.push(slot(a, 'upcoming'));
      const b = nextNonBlank(lines, a + 1);
      if (b >= 0) slots.push(slot(b, 'upcoming'));
    }
  }
  slots.sort((x, y) => x.row - y.row);
  return { slots, currentIndex: cur };
}

/**
 * How much of a line has been sung at `t`, 0..1: by word timing when the line has it (so the sweep
 * follows the singer), else evenly over the line's own time.
 */
export function lineProgress(line: LyricLine, t: number): number {
  const words = line.words;
  if (words && words.length > 0) {
    const total = words.reduce((n, w) => n + w.text.length, 0);
    if (total > 0) {
      let before = 0;
      for (const w of words) {
        if (t < w.start) break;
        const span = w.end - w.start;
        const frac = span > 0 ? Math.min(1, (t - w.start) / span) : 1;
        before += w.text.length * frac;
        if (frac < 1) break;
      }
      return Math.min(1, Math.max(0, before / total));
    }
  }
  const span = line.end - line.start;
  if (span <= 0) return t >= line.start ? 1 : 0;
  return Math.min(1, Math.max(0, (t - line.start) / span));
}
