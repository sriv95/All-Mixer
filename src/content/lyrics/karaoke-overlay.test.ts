import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LYRICS_PREFS, type LyricsPrefs } from '../../shared/lyrics-prefs';
import type { LyricsState } from './controller';
import { KaraokeSurface, clampKaraokePosition, karaokeFontPx } from './karaoke-overlay';

const track = { videoId: 'v', title: 'Song', artist: 'Band', duration: 100 };
const lines = [
  { start: 1, end: 3, text: 'one' },
  { start: 3, end: 5, text: 'two', words: [{ start: 3, end: 4, text: 'tw' }, { start: 4, end: 5, text: 'o' }] },
  { start: 8, end: 10, text: 'three' },
];
const synced: LyricsState = { kind: 'ready', track, lyrics: { kind: 'synced', source: 'lrclib', offset: 0, hasWordTiming: true, lines } };
const plain: LyricsState = { kind: 'ready', track, lyrics: { kind: 'plain', source: 'lrclib', text: 'hello' } };

let prefs: LyricsPrefs;
let saved: { x: number; y: number }[];
let player: HTMLElement;
let size = { width: 800, height: 450 };

const rect = (r: Partial<DOMRect>) => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {}, ...r }) as DOMRect;

function make(): KaraokeSurface {
  return new KaraokeSurface({ site: 'youtube', getPrefs: () => prefs, onPosition: (p) => saved.push(p) });
}
const root = () => document.getElementById('all-mixer-karaoke');
const lineEls = () => [...document.querySelectorAll<HTMLElement>('.am-k-line')];
const textOf = (e: HTMLElement) => e.textContent;
const block = () => document.querySelector<HTMLElement>('.am-k-block')!;

beforeEach(() => {
  prefs = { ...DEFAULT_LYRICS_PREFS, karaokeLines: 2 };
  saved = [];
  size = { width: 800, height: 450 };
  document.body.innerHTML = '<div id="movie_player"><div class="ytp-chrome-bottom"></div></div>';
  player = document.getElementById('movie_player')!;
  player.getBoundingClientRect = () => rect({ width: size.width, height: size.height, right: size.width, bottom: size.height });
  document.querySelector('.ytp-chrome-bottom')!.getBoundingClientRect = () => rect({ top: size.height - 50, height: 50, bottom: size.height });
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('KaraokeSurface slots', () => {
  it('shows current + dimmed upcoming in 2-line mode', () => {
    const s = make();
    s.render(synced);
    s.update(1.5);
    expect(root()!.parentElement).toBe(player);
    expect(lineEls().map((e) => [textOf(e), e.classList.contains('upcoming')])).toEqual([['one', false], ['two', true]]);
  });

  it('shows one line in 1-line mode and nothing in a gap', () => {
    prefs.karaokeLines = 1;
    const s = make();
    s.render(synced);
    s.update(1.5);
    expect(lineEls().map(textOf)).toEqual(['one']);
    s.update(6);
    expect(lineEls()).toHaveLength(0);
    expect(block().style.display).toBe('none');
  });

  it('dims the next lines in a gap (2 lines)', () => {
    const s = make();
    s.render(synced);
    s.update(6);
    // 'three' is line index 2 (row 0); row 1 stays as an empty placeholder.
    expect(lineEls().map((e) => [textOf(e), e.classList.contains('upcoming')])).toEqual([['three', true], ['\u200b', false]]);
  });

  it('does not rebuild the DOM while the slots are unchanged', () => {
    const s = make();
    s.render(synced);
    s.update(1.2);
    const first = lineEls()[0];
    s.update(1.8);
    expect(lineEls()[0]).toBe(first);
  });

  it.each([
    ['plain', plain],
    ['idle', { kind: 'idle' } as LyricsState],
    ['loading', { kind: 'loading' } as LyricsState],
    ['not-found', { kind: 'not-found' } as LyricsState],
    ['error', { kind: 'error' } as LyricsState],
  ])('shows nothing for %s', (_n, state) => {
    const s = make();
    s.render(synced);
    s.update(1.5);
    s.render(state);
    s.update(1.5);
    expect(lineEls()).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/lyrics|loading|found/i);
  });

  it('keeps each line in its row: the ended line is replaced in place', () => {
    const s = make();
    s.render(synced);
    s.update(1.5);
    expect(lineEls().map(textOf)).toEqual(['one', 'two']);
    s.update(3.5);
    // 'one' (row 0) ended; 'three' replaces it in row 0, 'two' stays in row 1.
    expect(lineEls().map(textOf)).toEqual(['three', 'two']);
    expect(lineEls().map((e) => e.classList.contains('upcoming'))).toEqual([true, false]);
  });
});

describe('KaraokeSurface active', () => {
  it('is active only in karaoke mode with a player', () => {
    const s = make();
    expect(s.active).toBe(true);
    prefs = { ...prefs, lyricsVisible: false };
    expect(s.active).toBe(false);
    prefs = { ...prefs, lyricsVisible: true };
    prefs = { ...prefs, lyricsDisplayMode: 'window' };
    expect(s.active).toBe(false);
    prefs = { ...prefs, lyricsDisplayMode: 'karaoke' };
    player.remove();
    expect(s.active).toBe(false);
  });

  it('unmounts when the mode changes and re-mounts in a re-created player', () => {
    const s = make();
    s.render(synced);
    s.update(1.5);
    prefs = { ...prefs, lyricsDisplayMode: 'window' };
    s.refreshPrefs();
    expect(root()).toBeNull();
    prefs = { ...prefs, lyricsDisplayMode: 'karaoke' };
    player.remove();
    document.body.innerHTML = '<div id="movie_player"></div>';
    s.update(1.5);
    expect(root()!.parentElement).toBe(document.getElementById('movie_player'));
  });
});

describe('position math', () => {
  const player = { w: 800, h: 450 };
  it('keeps the block inside the player', () => {
    expect(clampKaraokePosition({ x: 0, y: 0 }, { w: 200, h: 40 }, player, 0)).toEqual({ x: 100 / 800, y: 20 / 450 });
    expect(clampKaraokePosition({ x: 1, y: 1 }, { w: 200, h: 40 }, player, 0)).toEqual({ x: 700 / 800, y: 430 / 450 });
  });
  it('stays above the control bar', () => {
    expect(clampKaraokePosition({ x: 0.5, y: 1 }, { w: 200, h: 40 }, player, 50).y).toBeCloseTo((450 - 50 - 20) / 450);
  });
  it('leaves a valid position alone and centers a block that does not fit', () => {
    expect(clampKaraokePosition({ x: 0.5, y: 0.5 }, { w: 200, h: 40 }, player, 50)).toEqual({ x: 0.5, y: 0.5 });
    // narrow block near the right edge / bottom: clamped by half its own size
    expect(clampKaraokePosition({ x: 0.9, y: 0.5 }, { w: 300, h: 40 }, player, 0).x).toBeCloseTo(650 / 800);
    expect(clampKaraokePosition({ x: 0.5, y: 0.99 }, { w: 300, h: 80 }, player, 50).y).toBeCloseTo((450 - 50 - 40) / 450);
    expect(clampKaraokePosition({ x: 0.1, y: 0.5 }, { w: 900, h: 40 }, player, 0).x).toBe(0.5);
  });
  it('scales the font with player height and size pref', () => {
    expect(karaokeFontPx(500, 100)).toBe(20);
    expect(karaokeFontPx(500, 150)).toBe(30);
    expect(karaokeFontPx(100, 100)).toBe(12);
    expect(karaokeFontPx(5000, 100)).toBe(48);
  });
});

describe('KaraokeSurface layout and drag', () => {
  it('applies the font size and position from prefs', () => {
    const s = make();
    s.render(synced);
    s.update(1.5);
    expect(block().style.fontSize).toBe('18px');
    expect(block().style.left).toBe('50%');
  });

  it('recomputes the font size when the player resizes', () => {
    let fire = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { fire = cb; } observe() {} disconnect() {} });
    const s = make();
    s.render(synced);
    s.update(1.5);
    size = { width: 1600, height: 900 };
    fire();
    expect(block().style.fontSize).toBe('36px');
  });

  it('drags the block and saves the position on release', () => {
    const s = make();
    s.render(synced);
    s.update(1.5);
    const b = block();
    b.getBoundingClientRect = () => rect({ left: 300, top: 300, width: 200, height: 40 });
    const ev = (type: string, x: number, y: number) => {
      const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }) as MouseEvent & { pointerId: number };
      Object.defineProperty(e, 'pointerId', { value: 1 });
      return e;
    };
    const leaked = vi.fn();
    player.addEventListener('pointerdown', leaked);
    b.dispatchEvent(ev('pointerdown', 400, 320));
    b.dispatchEvent(ev('pointermove', 200, 200));
    b.dispatchEvent(ev('pointerup', 200, 200));
    expect(leaked).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    expect(saved[0].x).toBeCloseTo(200 / 800);
    expect(saved[0].y).toBeCloseTo(200 / 450);
  });

  it('keeps clicks and keys on the text away from YouTube', () => {
    const s = make();
    s.render(synced);
    s.update(1.5);
    const seen = vi.fn();
    for (const t of ['click', 'dblclick', 'keydown']) player.addEventListener(t, seen);
    for (const t of ['click', 'dblclick', 'keydown']) block().dispatchEvent(new Event(t, { bubbles: true }));
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('karaoke block width and ads', () => {
  it('keeps its natural width up to 90% of the player', () => {
    const k = make();
    k.render(synced);
    k.update(1.5);
    expect(block().style.width).toBe('');
    expect(document.getElementById('all-mixer-karaoke')!.querySelector('style')!.textContent).toMatch(/width:max-content; max-width:90%/);
  });

  it('hides the text while the player shows an ad', () => {
    const k = make();
    k.render(synced);
    k.update(1.5);
    expect(root()!.classList.contains('am-ad')).toBe(false);
    player.classList.add('ad-showing');
    k.update(1.5);
    expect(root()!.classList.contains('am-ad')).toBe(true);
    player.classList.remove('ad-showing');
    player.classList.add('ad-interrupting');
    k.update(1.5);
    expect(root()!.classList.contains('am-ad')).toBe(true);
    player.classList.remove('ad-interrupting');
    k.update(1.5);
    expect(root()!.classList.contains('am-ad')).toBe(false);
  });
});

describe('KaraokeSurface mount on YT Music', () => {
  it('mounts in ytmusic-player above #song-media-window, not inside the player', () => {
    document.body.innerHTML = '<ytmusic-player><div id="movie_player"></div><div id="song-media-window"></div></ytmusic-player>';
    const p = document.getElementById('movie_player')!;
    p.getBoundingClientRect = () => rect({ left: 10, top: 20, width: 800, height: 450, right: 810, bottom: 470 });
    const s = new KaraokeSurface({ site: 'ytmusic', getPrefs: () => prefs, onPosition: () => {} });
    s.render(synced);
    s.update(1.5);
    expect(root()!.parentElement!.tagName.toLowerCase()).toBe('ytmusic-player');
    expect(Number(root()!.style.zIndex)).toBeGreaterThan(10);
    expect(root()!.style.width).toBe('800px');
    expect(root()!.style.height).toBe('450px');
  });

  it('mounts inside the player while the player itself is fullscreen', () => {
    document.body.innerHTML = '<ytmusic-player><div id="movie_player"></div></ytmusic-player>';
    const p = document.getElementById('movie_player')!;
    p.getBoundingClientRect = () => rect({ left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450 });
    const s = new KaraokeSurface({ site: 'ytmusic', getPrefs: () => prefs, onPosition: () => {} });
    s.render(synced);
    s.update(1.5);
    const own = () => (s as unknown as { root: HTMLElement }).root.parentElement;
    expect(own()!.tagName.toLowerCase()).toBe('ytmusic-player');
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => p });
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(own()).toBe(p);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(own()!.tagName.toLowerCase()).toBe('ytmusic-player');
    s.destroy();
  });
});
