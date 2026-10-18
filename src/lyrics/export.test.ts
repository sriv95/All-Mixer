import { describe, expect, it } from 'vitest';
import { linesToLrc, lyricsToText } from './export';
import type { Lyrics } from './types';

const synced: Lyrics = {
  kind: 'synced',
  source: 'lrclib',
  offset: 0,
  hasWordTiming: false,
  lines: [
    { start: 1.5, end: 3, text: 'one' },
    { start: 61.234, end: 70, text: 'two' },
    { start: 599.999, end: 605, text: 'three' },
  ],
};

describe('lyrics export', () => {
  it('text: one row per line for synced, as is for plain', () => {
    expect(lyricsToText(synced)).toBe('one\ntwo\nthree');
    expect(lyricsToText({ kind: 'plain', source: 'lrclib', text: 'a\nb' })).toBe('a\nb');
  });

  it('lrc: timestamps [mm:ss.xx], rounded without carrying 60 s, title and artist tags', () => {
    if (synced.kind !== 'synced') throw new Error('fixture');
    expect(linesToLrc(synced.lines, { title: 'Song', artist: 'Band' })).toBe('[ti:Song]\n[ar:Band]\n[00:01.50]one\n[01:01.23]two\n[10:00.00]three\n');
    expect(linesToLrc(synced.lines.slice(0, 1))).toBe('[00:01.50]one\n');
  });
});
