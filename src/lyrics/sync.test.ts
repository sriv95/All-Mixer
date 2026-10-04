import { describe, expect, it } from 'vitest';
import { applyOffset, findLineIndex, findWordIndex } from './sync';
import type { LyricLine } from './types';

const lines: LyricLine[] = [
  { start: 1, end: 3, text: 'a', words: [{ start: 1, end: 2, text: 'a ' }, { start: 2, end: 3, text: 'b' }] },
  { start: 3, end: 6, text: 'c' },
  { start: 6, end: 11, text: 'd' },
];

describe('findLineIndex', () => {
  it('finds the last line with start <= t', () => {
    expect(findLineIndex(lines, 0.5)).toBe(-1);
    expect(findLineIndex(lines, 1)).toBe(0);
    expect(findLineIndex(lines, 2.99)).toBe(0);
    expect(findLineIndex(lines, 3)).toBe(1);
    expect(findLineIndex(lines, 100)).toBe(2);
    expect(findLineIndex([], 5)).toBe(-1);
  });
});

describe('findWordIndex', () => {
  it('finds words, -1 when none or before first', () => {
    expect(findWordIndex(lines[0], 0.5)).toBe(-1);
    expect(findWordIndex(lines[0], 1.5)).toBe(0);
    expect(findWordIndex(lines[0], 2)).toBe(1);
    expect(findWordIndex(lines[1], 4)).toBe(-1);
  });
});

describe('applyOffset', () => {
  it('shifts lines and words into a new array without clamping', () => {
    const out = applyOffset(lines, -2);
    expect(out).not.toBe(lines);
    expect(out[0].start).toBe(-1);
    expect(out[0].words![1]).toEqual({ start: 0, end: 1, text: 'b' });
    expect(lines[0].start).toBe(1);
    expect(out[1].words).toBeUndefined();
  });
});
