import type { LyricLine } from './types';
import { findLineIndex } from './sync';

export interface KaraokeSlot {
  index: number;
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

/**
 * Picks the lines to show as karaoke text at time `t`. While a line is active it is `current`
 * (plus the next line as `upcoming` for 2 lines). In a gap, 2-line mode shows the next two
 * non-blank lines as `upcoming`, so a line turns `current` in the same slot; 1-line mode shows nothing.
 */
export function selectKaraokeLines(lines: readonly LyricLine[], t: number, count: 1 | 2): KaraokeView {
  const cur = findLineIndex(lines, t);
  const line = cur >= 0 ? lines[cur] : undefined;
  const hasEnd = line !== undefined && line.end > line.start;
  const active = line !== undefined && !isBlank(line.text) && (!hasEnd || t < line.end);

  const slots: KaraokeSlot[] = [];
  if (active) {
    slots.push({ index: cur, text: line.text, state: 'current' });
    if (count === 2 && cur + 1 < lines.length && !isBlank(lines[cur + 1].text)) {
      slots.push({ index: cur + 1, text: lines[cur + 1].text, state: 'upcoming' });
    }
  } else if (count === 2) {
    const a = nextNonBlank(lines, cur + 1);
    if (a >= 0) {
      slots.push({ index: a, text: lines[a].text, state: 'upcoming' });
      const b = nextNonBlank(lines, a + 1);
      if (b >= 0) slots.push({ index: b, text: lines[b].text, state: 'upcoming' });
    }
  }
  return { slots, currentIndex: cur };
}
