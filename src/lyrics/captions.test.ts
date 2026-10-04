import { describe, expect, it } from 'vitest';
import { captionWords, cleanCaptionText, parseJson3 } from './captions';

const ASR = {
  events: [
    { tStartMs: 0, dDurationMs: 5000, id: 1 },
    { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: 'hello' }, { utf8: ' darkness', tOffsetMs: 400 }, { utf8: ' my', tOffsetMs: 900 }] },
    { tStartMs: 3000, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: '[Music]' }] },
    { tStartMs: 5000, dDurationMs: 2000, segs: [{ utf8: 'old' }, { utf8: ' friend', tOffsetMs: 500 }] },
  ],
};

describe('parseJson3', () => {
  it('parses ASR events with word offsets and skips annotations / append events', () => {
    const cues = parseJson3(JSON.stringify(ASR));
    expect(cues.map((c) => c.text)).toEqual(['hello darkness my', 'old friend']);
    expect(cues[0].words).toEqual([
      { start: 1, text: 'hello' },
      { start: 1.4, text: 'darkness' },
      { start: 1.9, text: 'my' },
    ]);
    expect(cues[1]).toMatchObject({ start: 5, end: 7 });
  });

  it('parses manual tracks as one cue per event without words', () => {
    const cues = parseJson3({ events: [{ tStartMs: 2500, dDurationMs: 1500, segs: [{ utf8: '♪ Is this the real life?\nIs this just fantasy? ♪' }] }] });
    expect(cues).toEqual([{ start: 2.5, end: 4, text: 'Is this the real life? Is this just fantasy?' }]);
  });

  it('never throws on junk', () => {
    expect(parseJson3('')).toEqual([]);
    expect(parseJson3('not json')).toEqual([]);
    expect(parseJson3({})).toEqual([]);
    expect(parseJson3(null)).toEqual([]);
  });
});

describe('cleanCaptionText / captionWords', () => {
  it('strips bracketed annotations and notes', () => {
    expect(cleanCaptionText('♪ [Applause] la (la) la ♪')).toBe('la la');
  });

  it('spreads words evenly over cues without word timing', () => {
    expect(captionWords([{ start: 10, end: 12, text: 'a b c d' }]).map((w) => w.start)).toEqual([10, 10.5, 11, 11.5]);
  });
});
