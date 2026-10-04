import { describe, expect, it } from 'vitest';
import { parseLrc } from './lrc';

describe('parseLrc', () => {
  it('parses mm:ss.xx, mm:ss.xxx and mm:ss', () => {
    const l = parseLrc('[00:01.50]a\n[00:02.250]b\n[00:03]c');
    expect(l.map((x) => [x.start, x.text])).toEqual([[1.5, 'a'], [2.25, 'b'], [3, 'c']]);
  });

  it('expands multiple timestamps and sorts', () => {
    const l = parseLrc('[01:20.00][00:10.00]chorus\n[00:30.00]verse');
    expect(l.map((x) => [x.start, x.text])).toEqual([[10, 'chorus'], [30, 'verse'], [80, 'chorus']]);
  });

  it('sets end to next start and last line to start + duration', () => {
    const l = parseLrc('[00:01.00]a\n[00:04.00]b');
    expect(l[0].end).toBe(4);
    expect(l[1].end).toBe(9);
    expect(parseLrc('[00:01.00]a', { lastLineDuration: 2 })[0].end).toBe(3);
  });

  it('parses enhanced word timing', () => {
    const [line] = parseLrc('[00:12.00]<00:12.00>Hello <00:12.50>world\n[00:14.00]x');
    expect(line.text).toBe('Hello world');
    expect(line.words).toEqual([
      { start: 12, end: 12.5, text: 'Hello ' },
      { start: 12.5, end: 14, text: 'world' },
    ]);
    expect(line.words!.map((w) => w.text).join('')).toBe(line.text);
  });

  it('applies the offset tag (positive = sooner)', () => {
    const l = parseLrc('[offset:+500]\n[00:10.00]<00:10.00>a <00:11.00>b');
    expect(l[0].start).toBe(9.5);
    expect(l[0].words![1].start).toBe(10.5);
    expect(parseLrc('[offset:-250]\n[00:01.00]a')[0].start).toBe(1.25);
  });

  it('ignores other metadata', () => {
    const l = parseLrc('[ar:Artist]\n[ti:Title]\n[length:03:20]\n[00:01.00]a');
    expect(l).toHaveLength(1);
  });

  it('keeps empty timed lines', () => {
    const l = parseLrc('[00:01.00]a\n[00:05.00]\n[00:08.00]b');
    expect(l[1]).toEqual({ start: 5, end: 8, text: '' });
  });

  it('handles CRLF, BOM and garbage without throwing', () => {
    const l = parseLrc('﻿[00:01.00]a\r\nnot lrc\r\n[xx:yy]z\r\n[00:02.00]b\r\n');
    expect(l.map((x) => x.text)).toEqual(['a', 'b']);
    expect(parseLrc('')).toEqual([]);
    expect(() => parseLrc(undefined as unknown as string)).not.toThrow();
  });

  it('parses an LRCLIB-style sample and trims the leading space', () => {
    const l = parseLrc("[ar:The Weeknd]\n[00:17.12] I've been tryna call\n[00:20.50] I've been on my own\n");
    expect(l[0]).toEqual({ start: 17.12, end: 20.5, text: "I've been tryna call" });
  });
});
