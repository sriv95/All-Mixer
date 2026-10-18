import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LYRICS_PREFS, loadLyricsPrefs, normalizeLyricsPrefs, saveLyricsPrefs, watchLyricsPrefs } from './lyrics-prefs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeArea(init: Record<string, unknown> = {}): any {
  const store = { ...init };
  return {
    store,
    get: async (k: string) => (k in store ? { [k]: store[k] } : {}),
    set: async (o: Record<string, unknown>) => void Object.assign(store, o),
  };
}

describe('normalizeLyricsPrefs', () => {
  it('defaults for missing / garbage', () => {
    expect(normalizeLyricsPrefs(undefined)).toEqual(DEFAULT_LYRICS_PREFS);
    expect(normalizeLyricsPrefs('x')).toEqual(DEFAULT_LYRICS_PREFS);
    expect(normalizeLyricsPrefs({ lyricsDisplayMode: 'nope', karaokeLines: 3, karaokeFontSize: 'big', karaokePosition: 5 })).toEqual(DEFAULT_LYRICS_PREFS);
    expect(DEFAULT_LYRICS_PREFS.lyricsDisplayMode).toBe('karaoke');
  });
  it('keeps window and fills the rest', () => {
    expect(normalizeLyricsPrefs({ lyricsDisplayMode: 'window' })).toEqual({ ...DEFAULT_LYRICS_PREFS, lyricsDisplayMode: 'window' });
  });
  it('karaokeColor: white by default, #rrggbb kept lowercase, anything else falls back', () => {
    expect(DEFAULT_LYRICS_PREFS.karaokeColor).toBe('#ffffff');
    expect(normalizeLyricsPrefs({ karaokeColor: '#AABBCC' }).karaokeColor).toBe('#aabbcc');
    for (const bad of ['red', '#fff', '#12345g', 5, null]) expect(normalizeLyricsPrefs({ karaokeColor: bad }).karaokeColor).toBe('#ffffff');
  });

  it('lyricsOffsets: keeps valid non-zero entries, clamps to 5 s, drops junk, keeps the newest 200', () => {
    expect(DEFAULT_LYRICS_PREFS.lyricsOffsets).toEqual({});
    expect(normalizeLyricsPrefs({ lyricsOffsets: { abc: 250.4, big: 99999, zero: 0, 'bad id!': 100, str: '5', nan: NaN } }).lyricsOffsets).toEqual({ abc: 250, big: 5000 });
    expect(normalizeLyricsPrefs({ lyricsOffsets: 'x' }).lyricsOffsets).toEqual({});
    const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`v${i}`, 100]));
    const kept = Object.keys(normalizeLyricsPrefs({ lyricsOffsets: many }).lyricsOffsets);
    expect(kept).toHaveLength(200);
    expect(kept[0]).toBe('v50');
  });

  it('karaoke font, outline and background: known values kept, others default', () => {
    expect(normalizeLyricsPrefs({ karaokeFont: 'mono', karaokeOutline: 'thick', karaokeBackground: 50 })).toMatchObject({ karaokeFont: 'mono', karaokeOutline: 'thick', karaokeBackground: 50 });
    expect(normalizeLyricsPrefs({ karaokeFont: 'comic', karaokeOutline: 3, karaokeBackground: 33 })).toMatchObject({ karaokeFont: 'default', karaokeOutline: 'normal', karaokeBackground: 0 });
  });

  it('karaokeAnimation: none by default, unknown values fall back', () => {
    expect(DEFAULT_LYRICS_PREFS.karaokeAnimation).toBe('none');
    expect(normalizeLyricsPrefs({ karaokeAnimation: 'slide' }).karaokeAnimation).toBe('slide');
    expect(normalizeLyricsPrefs({ karaokeAnimation: 'spin' }).karaokeAnimation).toBe('none');
  });

  it('lyricsTimingKeys: on by default, only a boolean is taken', () => {
    expect(DEFAULT_LYRICS_PREFS.lyricsTimingKeys).toBe(true);
    expect(normalizeLyricsPrefs({ lyricsTimingKeys: false }).lyricsTimingKeys).toBe(false);
    expect(normalizeLyricsPrefs({ lyricsTimingKeys: 'no' }).lyricsTimingKeys).toBe(true);
  });

  it('karaokeMyStyle: null by default; a saved style is kept with bad fields fixed; junk is null', () => {
    expect(DEFAULT_LYRICS_PREFS.karaokeMyStyle).toBeNull();
    const style = { karaokeColor: '#ABCDEF', karaokeFontSize: 150, karaokeFont: 'serif', karaokeOutline: 'thick', karaokeBackground: 50 };
    expect(normalizeLyricsPrefs({ karaokeMyStyle: style }).karaokeMyStyle).toEqual({ ...style, karaokeColor: '#abcdef' });
    expect(normalizeLyricsPrefs({ karaokeMyStyle: { ...style, karaokeFont: 'comic', karaokeColor: 'red' } }).karaokeMyStyle).toMatchObject({ karaokeFont: 'default', karaokeColor: '#ffffff', karaokeFontSize: 150 });
    for (const bad of [null, 5, 'x', {}, { other: 1 }]) expect(normalizeLyricsPrefs({ karaokeMyStyle: bad }).karaokeMyStyle).toBeNull();
  });

  it('defaults to one karaoke line, auto source and no caption language', () => {
    expect(DEFAULT_LYRICS_PREFS).toMatchObject({ karaokeLines: 1, lyricsSource: 'auto', captionLang: null });
  });
  it('keeps a stored source and caption language, drops bad ones', () => {
    expect(normalizeLyricsPrefs({ lyricsSource: 'captions', captionLang: 'pt-BR' })).toMatchObject({ lyricsSource: 'captions', captionLang: 'pt-BR' });
    expect(normalizeLyricsPrefs({ lyricsSource: 'x', captionLang: '<b>' })).toMatchObject({ lyricsSource: 'auto', captionLang: null });
  });
  it('clamps and rounds', () => {
    const p = normalizeLyricsPrefs({ karaokeFontSize: 300.4, karaokePosition: { x: -1, y: 2 } });
    expect(p.karaokeFontSize).toBe(200);
    expect(p.karaokePosition).toEqual({ x: 0, y: 1 });
    expect(normalizeLyricsPrefs({ karaokeFontSize: 10 }).karaokeFontSize).toBe(50);
    expect(normalizeLyricsPrefs({ karaokeFontSize: 120.6 }).karaokeFontSize).toBe(121);
    expect(normalizeLyricsPrefs({ karaokeFontSize: NaN }).karaokeFontSize).toBe(100);
  });
});

describe('storage', () => {
  it('old users with no key get defaults', async () => {
    expect(await loadLyricsPrefs(fakeArea())).toEqual(DEFAULT_LYRICS_PREFS);
  });
  it('save merges and normalizes', async () => {
    const a = fakeArea({ lyricsPrefs: { lyricsDisplayMode: 'window' } });
    const out = await saveLyricsPrefs(a, { karaokeLines: 1, karaokeFontSize: 999 });
    expect(out).toEqual({ ...DEFAULT_LYRICS_PREFS, lyricsDisplayMode: 'window', karaokeLines: 1, karaokeFontSize: 200 });
    expect(a.store.lyricsPrefs).toEqual(out);
  });
  it('watch fires for lyricsPrefs in local only, and unsubscribes', () => {
    let l: (c: Record<string, { newValue?: unknown }>, n: string) => void = () => {};
    const ev = {
      addListener: vi.fn((f) => void (l = f)),
      removeListener: vi.fn(),
    };
    const cb = vi.fn();
    const off = watchLyricsPrefs(ev as never, cb);
    l({ lyricsPrefs: { newValue: { karaokeLines: 1 } } }, 'local');
    expect(cb).toHaveBeenCalledWith({ ...DEFAULT_LYRICS_PREFS, karaokeLines: 1 });
    l({ lyricsPrefs: { newValue: {} } }, 'session');
    l({ other: { newValue: 1 } }, 'local');
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    expect(ev.removeListener).toHaveBeenCalledWith(l);
  });
});
