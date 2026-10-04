import { describe, expect, it } from 'vitest';
import { addWordTiming, alignWithCaptions, estimateOffset, linesFromCaptions, normWord } from './align';
import type { CaptionCue, CaptionWord } from './captions';
import { parseLrc } from './lrc';
import type { SyncedLyrics } from './types';

const LRC = `[00:10.00]Is this the real life
[00:14.00]Is this just fantasy
[00:18.00]Caught in a landslide
[00:22.00]No escape from reality
[00:26.00]Open your eyes
[00:29.00]Look up to the skies and see`;

/** ASR-like words for the LRC above, shifted by `shift` s, with small jitter and a few recognition errors. */
function asrWords(shift: number): CaptionWord[] {
  const lines = parseLrc(LRC);
  const out: CaptionWord[] = [];
  lines.forEach((l, li) => {
    const ws = l.text.split(' ');
    ws.forEach((w, i) => {
      const jitter = ((li * 7 + i * 3) % 5) * 0.06 - 0.12;
      const text = w === 'landslide' ? 'lanslide' : w; // ASR mistake
      out.push({ start: l.start + shift + i * 0.45 + jitter, text });
    });
  });
  out.push({ start: 2 + shift, text: 'mama' }, { start: 40 + shift, text: 'the' });
  return out;
}

function synced(lines = parseLrc(LRC)): SyncedLyrics {
  return { kind: 'synced', lines, source: 'lrclib', offset: 0, hasWordTiming: false };
}

describe('normWord', () => {
  it('strips accents, case and punctuation', () => {
    expect(normWord('Café,')).toBe('cafe');
    expect(normWord('—')).toBe('');
  });
});

describe('estimateOffset', () => {
  it.each([0, 7.5, -3.25, 42])('recovers a shift of %s s', (shift) => {
    const est = estimateOffset(parseLrc(LRC), asrWords(shift));
    expect(est).not.toBeNull();
    expect(Math.abs(est!.offset - shift)).toBeLessThan(0.6);
  });

  it('returns null when captions are unrelated', () => {
    const words = 'we are never ever getting back together like ever'.split(' ').map((text, i) => ({ start: i, text }));
    expect(estimateOffset(parseLrc(LRC), words)).toBeNull();
  });

  it('returns null with no captions', () => {
    expect(estimateOffset(parseLrc(LRC), [])).toBeNull();
  });
});

describe('addWordTiming', () => {
  it('adds monotonic word timing inside each line and round-trips the text', () => {
    const lines = addWordTiming(parseLrc(LRC), asrWords(0));
    for (const l of lines) {
      expect(l.words).toBeDefined();
      expect(l.words!.map((w) => w.text).join('')).toBe(l.text);
      expect(l.words![0].start).toBe(l.start);
      for (let i = 0; i < l.words!.length; i++) {
        const w = l.words![i];
        expect(w.start).toBeGreaterThanOrEqual(l.start);
        expect(w.end).toBeLessThanOrEqual(l.end);
        expect(w.end).toBeGreaterThanOrEqual(w.start);
        if (i > 0) expect(w.start).toBeGreaterThanOrEqual(l.words![i - 1].start);
      }
    }
    // "landslide" was mis-recognised and is interpolated between its neighbours.
    const caught = lines[2].words!;
    expect(caught[3].start).toBeGreaterThan(caught[2].start);
  });

  it('leaves lines alone when captions do not match', () => {
    const lines = addWordTiming(parseLrc(LRC), [{ start: 10.2, text: 'banana' }]);
    expect(lines.every((l) => !l.words)).toBe(true);
  });

  it('keeps existing enhanced-LRC word timing', () => {
    const lines = parseLrc('[00:01.00]<00:01.00>a <00:01.50>b\n[00:03.00]c d');
    const out = addWordTiming(lines, [{ start: 1.9, text: 'a' }, { start: 3.1, text: 'c' }, { start: 3.6, text: 'd' }]);
    expect(out[0]).toBe(lines[0]);
    expect(out[1].words!.map((w) => w.start)).toEqual([3, 3.6]);
  });
});

describe('alignWithCaptions', () => {
  it('shifts LRC lines and adds word timing from ASR captions', () => {
    const cues: CaptionCue[] = [{ start: 0, end: 60, text: 'x', words: asrWords(12) }];
    const out = alignWithCaptions(synced(), { cues, asr: true });
    expect(Math.abs(out.offset - 12)).toBeLessThan(0.6);
    expect(Math.abs(out.lines[0].start - 22)).toBeLessThan(0.6);
    expect(out.hasWordTiming).toBe(true);
  });

  it('only shifts with manual captions', () => {
    const cues = parseLrc(LRC).map((l) => ({ start: l.start + 5, end: l.end + 5, text: l.text }));
    const out = alignWithCaptions(synced(), { cues, asr: false });
    expect(Math.abs(out.offset - 5)).toBeLessThan(0.6);
    expect(out.hasWordTiming).toBe(false);
  });

  it('returns input unchanged without captions', () => {
    const s = synced();
    expect(alignWithCaptions(s, null)).toBe(s);
  });
});

describe('linesFromCaptions', () => {
  it('merges repeated adjacent cues', () => {
    expect(
      linesFromCaptions([
        { start: 1, end: 2, text: 'a' },
        { start: 2.1, end: 3, text: 'a' },
        { start: 3, end: 4, text: 'b' },
      ]),
    ).toEqual([
      { start: 1, end: 3, text: 'a' },
      { start: 3, end: 4, text: 'b' },
    ]);
  });
});
