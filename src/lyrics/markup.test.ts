import { describe, expect, it } from 'vitest';
import { stripMarkup } from './markup';
import { parseLrc } from './lrc';
import { cleanCaptionText, parseJson3 } from './captions';

describe('stripMarkup', () => {
  it('strips tags and keeps inner text', () => {
    expect(stripMarkup('<i>Hello</i> world')).toBe('Hello world');
    expect(stripMarkup('<font color="#fff">x</font>')).toBe('x');
    expect(stripMarkup('a<br>b<br/>c')).toBe('a b c');
    expect(stripMarkup('{\\an8}Top <b>line</b>')).toBe('Top line');
  });
  it('keeps a lone <', () => {
    expect(stripMarkup('I <3 you')).toBe('I <3 you');
    expect(stripMarkup('a < b > c')).toBe('a < b > c');
  });
  it('decodes common entities', () => {
    expect(stripMarkup('Tom &amp; Jerry &quot;x&quot; &#39;y&#39; &lt;3&nbsp;&gt;')).toBe('Tom & Jerry "x" \'y\' <3 >');
  });
});

describe('sources', () => {
  it('parseLrc', () => {
    const l = parseLrc('[00:01.00]<i>Hello</i> world\n[00:02.00]<i></i>\n[00:03.00]end');
    expect(l.map((x) => x.text)).toEqual(['Hello world', '', 'end']);
  });
  it('parseLrc enhanced words', () => {
    const l = parseLrc('[00:01.00]<00:01.00><b>Hi</b> <00:01.50>there');
    expect(l[0].text).toBe('Hi there');
  });
  it('captions', () => {
    expect(cleanCaptionText('<i>Hello</i> [Music] world')).toBe('Hello world');
    const cues = parseJson3({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '<i>Hi</i>' }] }, { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: '<i></i>' }] }] });
    expect(cues.map((c) => c.text)).toEqual(['Hi']);
  });
});
