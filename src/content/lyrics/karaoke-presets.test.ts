import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRICS_PREFS, type LyricsPrefs } from '../../shared/lyrics-prefs';
import { RESET_STYLE, STYLE_PRESETS, matchedPosition, matchedStylePreset, nearestSize, stylePresets } from './karaoke-presets';

const prefs = (p: Partial<LyricsPrefs> = {}): LyricsPrefs => ({ ...DEFAULT_LYRICS_PREFS, ...p });

describe('karaoke presets', () => {
  it('the default prefs are the Default style and the Bottom position', () => {
    expect(matchedStylePreset(prefs())?.id).toBe('default');
    expect(matchedPosition(prefs())?.id).toBe('bottom');
  });

  it('a nearby dragged position matches; a far or off-center one does not', () => {
    expect(matchedPosition(prefs({ karaokePosition: { x: 0.505, y: 0.125 } }))?.id).toBe('top');
    expect(matchedPosition(prefs({ karaokePosition: { x: 0.5, y: 0.3 } }))).toBeUndefined();
    expect(matchedPosition(prefs({ karaokePosition: { x: 0.2, y: 0.5 } }))).toBeUndefined();
  });

  it('My style is listed last and matched; an off-step size matches by its nearest step', () => {
    const mine = { ...STYLE_PRESETS[1].style, karaokeColor: '#123456' };
    expect(stylePresets(prefs({ karaokeMyStyle: mine })).map((p) => p.id)).toEqual(['default', 'bigYellow', 'cleanBox', 'cyanGlow', 'mine']);
    expect(matchedStylePreset(prefs({ ...mine, karaokeMyStyle: mine }))?.id).toBe('mine');
    expect(matchedStylePreset(prefs({ ...STYLE_PRESETS[1].style, karaokeFontSize: 140 }))?.id).toBe('bigYellow');
    expect(nearestSize(110)).toBe(100);
  });

  it('Reset style = the Default style + no transition', () => {
    expect(RESET_STYLE).toEqual({ ...STYLE_PRESETS[0].style, karaokeAnimation: 'none' });
  });
});
