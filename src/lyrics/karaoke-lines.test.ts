import { describe, expect, it } from 'vitest';
import { selectKaraokeLines } from './karaoke-lines';
import type { LyricLine } from './types';

const L = (start: number, end: number, text: string): LyricLine => ({ start, end, text });
const lines = [L(10, 14, 'a'), L(14, 18, 'b'), L(20, 24, 'c'), L(24, 26, ''), L(30, 34, 'd')];
const view = (t: number, n: 1 | 2) => selectKaraokeLines(lines, t, n).slots.map((s) => `${s.index}:${s.state}`);

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
  it('empty list', () => {
    expect(selectKaraokeLines([], 3, 2)).toEqual({ slots: [], currentIndex: -1 });
  });
});
