import { describe, expect, it } from 'vitest';
import { lineProgress, selectKaraokeLines } from './karaoke-lines';
import type { LyricLine } from './types';

const L = (start: number, end: number, text: string): LyricLine => ({ start, end, text });
const lines = [L(10, 14, 'a'), L(14, 18, 'b'), L(20, 24, 'c'), L(24, 26, ''), L(30, 34, 'd')];
const view = (t: number, n: 1 | 2) =>
  selectKaraokeLines(lines, t, n)
    .slots.slice()
    .sort((a, b) => a.index - b.index)
    .map((s) => `${s.index}:${s.state}`);
const rows = (t: number, n: 1 | 2) => selectKaraokeLines(lines, t, n).slots.map((s) => `${s.row}=${s.index}:${s.state}`);

describe('selectKaraokeLines', () => {
  it('before the first line', () => {
    expect(view(2, 1)).toEqual([]);
    expect(view(2, 2)).toEqual(['0:upcoming', '1:upcoming']);
    expect(selectKaraokeLines(lines, 2, 2).currentIndex).toBe(-1);
  });
  it('mid-song: 1 vs 2 lines', () => {
    expect(view(11, 1)).toEqual(['0:current']);
    expect(view(11, 2)).toEqual(['0:current', '1:upcoming']);
  });
  it('end == next.start has no gap', () => {
    expect(view(14, 2)).toEqual(['1:current', '2:upcoming']);
    expect(view(14, 1)).toEqual(['1:current']);
  });
  it('gap between lines', () => {
    expect(view(19, 1)).toEqual([]);
    expect(view(19, 2)).toEqual(['2:upcoming', '4:upcoming']);
  });
  it('blank line is a gap and is skipped', () => {
    expect(view(25, 1)).toEqual([]);
    expect(view(25, 2)).toEqual(['4:upcoming']);
    expect(view(22, 2)).toEqual(['2:current']); // next is blank, omitted
  });
  it('last line has no next, then nothing after its end', () => {
    expect(view(31, 2)).toEqual(['4:current']);
    expect(view(40, 1)).toEqual([]);
    expect(view(40, 2)).toEqual([]);
  });
  it('seek backwards', () => {
    expect(view(31, 2)).toEqual(['4:current']);
    expect(view(11, 2)).toEqual(['0:current', '1:upcoming']);
  });
  it('unset end stays active until next line', () => {
    const ls = [L(1, 0, 'x'), L(5, 0, 'y')];
    expect(selectKaraokeLines(ls, 4, 1).slots.map((s) => s.index)).toEqual([0]);
  });
  it('2 lines: rows are fixed, an ended line is replaced in place (no scrolling)', () => {
    expect(rows(11, 2)).toEqual(['0=0:current', '1=1:upcoming']);
    // a ended: b is current in the same row, c takes a's row.
    expect(rows(15, 2)).toEqual(['0=2:upcoming', '1=1:current']);
    expect(rows(21, 2)).toEqual(['0=2:current']); // next line is blank
    // gap after c: d (row 1) next; the ended c row (0) has nothing to show yet.
    expect(rows(19, 2)).toEqual(['0=2:upcoming', '1=4:upcoming']);
    expect(rows(31, 2)).toEqual(['1=4:current']);
  });
  it('1 line always uses row 0', () => {
    expect(rows(15, 1)).toEqual(['0=1:current']);
  });
  it('empty list', () => {
    expect(selectKaraokeLines([], 3, 2)).toEqual({ slots: [], currentIndex: -1 });
  });
});

describe('lineProgress', () => {
  it('sweeps evenly over the line time without word timing', () => {
    const l = L(10, 14, 'abcd');
    expect(lineProgress(l, 9)).toBe(0);
    expect(lineProgress(l, 10)).toBe(0);
    expect(lineProgress(l, 11)).toBe(0.25);
    expect(lineProgress(l, 12)).toBe(0.5);
    expect(lineProgress(l, 14)).toBe(1);
    expect(lineProgress(l, 20)).toBe(1);
  });
  it('follows word timing, weighted by word length', () => {
    const l: LyricLine = { start: 0, end: 10, text: 'ab cdef', words: [{ start: 0, end: 1, text: 'ab ' }, { start: 5, end: 9, text: 'cdef' }] };
    expect(lineProgress(l, 0.5)).toBeCloseTo(1.5 / 7);
    expect(lineProgress(l, 3)).toBeCloseTo(3 / 7); // waiting between words
    expect(lineProgress(l, 7)).toBeCloseTo((3 + 2) / 7);
    expect(lineProgress(l, 9.5)).toBe(1);
  });
  it('a line without a duration is done once it starts', () => {
    expect(lineProgress(L(5, 0, 'x'), 4)).toBe(0);
    expect(lineProgress(L(5, 0, 'x'), 5)).toBe(1);
  });
});
