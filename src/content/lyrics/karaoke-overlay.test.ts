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
const block = () => document.querySelector<HTMLElement>('.am-k-block')!;

beforeEach(() => {
  prefs = { ...DEFAULT_LYRICS_PREFS };
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
    expect(lineEls().map((e) => [e.textContent, e.classList.contains('upcoming')])).toEqual([['one', false], ['two', true]]);
  });

  it('shows one line in 1-line mode and nothing in a gap', () => {
    prefs.karaokeLines = 1;
    const s = make();
    s.render(synced);
    s.update(1.5);
    expect(lineEls().map((e) => e.textContent)).toEqual(['one']);
    s.update(6);
    expect(lineEls()).toHaveLength(0);
    expect(block().style.display).toBe('none');
  });

  it('dims the next lines in a gap (2 lines)', () => {
    const s = make();
    s.render(synced);
    s.update(6);
    expect(lineEls().map((e) => [e.textContent, e.classList.contains('upcoming')])).toEqual([['three', true]]);
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

  it('marks sung words in the current line', () => {
    const s = make();
    s.render(synced);
    s.update(4.5);
    const words = [...document.querySelectorAll('.am-k-word')];
    expect(words.map((w) => w.classList.contains('sung'))).toEqual([true, true]);
    s.update(3.2);
    expect(words.map((w) => w.classList.contains('sung'))).toEqual([true, false]);
  });
});

describe('KaraokeSurface active', () => {
  it('is active only in karaoke mode with a player', () => {
    const s = make();
    expect(s.active).toBe(true);
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
