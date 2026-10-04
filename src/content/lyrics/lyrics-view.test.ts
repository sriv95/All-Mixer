import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { LyricsView } from './lyrics-view';
import type { SyncedLyrics } from '../../lyrics/types';

const synced = (offset = 0): SyncedLyrics => ({
  kind: 'synced',
  source: 'lrclib',
  offset,
  hasWordTiming: true,
  lines: [
    {
      start: 1,
      end: 4,
      text: 'hello big world',
      words: [
        { start: 1, end: 2, text: 'hello ' },
        { start: 2, end: 3, text: 'big ' },
        { start: 3, end: 4, text: 'world' },
      ],
    },
    { start: 4, end: 6, text: '' },
    { start: 6, end: 9, text: 'last line' },
  ],
});

let view: LyricsView;
let onSeek: Mock<(time: number) => void>;
const q = (sel: string) => view.el.shadowRoot!.querySelector(sel) as HTMLElement;
const qa = (sel: string) => [...view.el.shadowRoot!.querySelectorAll(sel)] as HTMLElement[];

beforeEach(() => {
  onSeek = vi.fn<(time: number) => void>();
  view = new LyricsView({ onSeek });
  document.body.appendChild(view.el);
});
afterEach(() => {
  view.destroy();
  vi.useRealTimers();
});

describe('LyricsView', () => {
  it('renders lines, words and the ♪ placeholder', () => {
    view.setLyrics(synced());
    const lines = qa('.line');
    expect(lines).toHaveLength(3);
    expect(lines[0].dataset.index).toBe('0');
    expect(lines[0].tabIndex).toBe(0);
    expect(qa('.line:first-child .word').map((w) => w.textContent)).toEqual(['hello ', 'big ', 'world']);
    expect(lines[1].textContent).toBe('♪');
    expect(lines[2].textContent).toBe('last line');
  });

  it('sets current/past/sung across line and word boundaries', () => {
    view.setLyrics(synced());
    const lines = qa('.line');
    const words = qa('.word');
    view.update(0.5);
    expect(qa('.current')).toHaveLength(0);
    view.update(1.5);
    expect(lines[0].classList.contains('current')).toBe(true);
    expect(words.map((w) => w.classList.contains('sung'))).toEqual([true, false, false]);
    view.update(2.5);
    expect(words.map((w) => w.classList.contains('sung'))).toEqual([true, true, false]);
    view.update(4.5);
    expect(lines[0].classList.contains('current')).toBe(false);
    expect(lines[0].classList.contains('past')).toBe(true);
    expect(lines[1].classList.contains('current')).toBe(true);
    expect(words.every((w) => w.classList.contains('sung'))).toBe(true);
    view.update(7);
    expect(lines[2].classList.contains('current')).toBe(true);
    expect(lines[0].classList.contains('past') && lines[1].classList.contains('past')).toBe(true);
    // seek backwards
    view.update(1.2);
    expect(lines[2].classList.contains('past')).toBe(false);
    expect(lines[1].classList.contains('past')).toBe(false);
    expect(lines[0].classList.contains('current')).toBe(true);
    expect(words.map((w) => w.classList.contains('sung'))).toEqual([true, false, false]);
  });

  it('does not touch the DOM when indices are unchanged', () => {
    view.setLyrics(synced());
    view.update(1.5);
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((r) => records.push(...r));
    mo.observe(view.el.shadowRoot!, { subtree: true, attributes: true, childList: true, characterData: true });
    const scrollTo = vi.spyOn(q('.scroll'), 'scrollTo');
    view.update(1.6);
    view.update(1.9);
    const taken = mo.takeRecords();
    expect(records.length + taken.length).toBe(0);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('auto-scrolls with scrollTo on line change and pauses after user scroll', () => {
    vi.useFakeTimers();
    view.setLyrics(synced());
    const scrollTo = vi.fn();
    q('.scroll').scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
    view.update(1.5);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.calls[0][0].behavior).toBe('smooth');
    q('.scroll').dispatchEvent(new Event('wheel'));
    view.update(4.5);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4100);
    view.update(6.5);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('click and Enter/Space seek to the line start', () => {
    view.setLyrics(synced());
    const lines = qa('.line');
    lines[2].click();
    expect(onSeek).toHaveBeenLastCalledWith(6);
    lines[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSeek).toHaveBeenLastCalledWith(1);
    lines[1].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(onSeek).toHaveBeenLastCalledWith(4);
    expect(onSeek).toHaveBeenCalledTimes(3);
  });

  it('renders plain lyrics without highlight or click, update is a no-op', () => {
    view.setLyrics({ kind: 'plain', source: 'lrclib', text: 'a\nb' });
    expect(qa('.line')).toHaveLength(0);
    expect(q('.plain').textContent).toBe('a\nb');
    view.update(3);
    q('.plain').click();
    expect(onSeek).not.toHaveBeenCalled();
    expect(qa('.current')).toHaveLength(0);
  });

  it('shows the footer source text', () => {
    view.setLyrics(synced());
    expect(q('.footer').textContent).toBe('Lyrics: LRCLIB');
    view.setLyrics(synced(1.5));
    expect(q('.footer').textContent).toBe('Lyrics: LRCLIB · timing aligned to captions');
  });

  it('setStatus replaces content and setLyrics replaces status', () => {
    view.setLyrics(synced());
    view.setStatus('not-found');
    expect(qa('.line')).toHaveLength(0);
    expect(q('.status').textContent).toContain('No lyrics');
    view.setStatus('error', 'boom');
    expect(q('.status').textContent).toBe('boom');
    view.update(2); // no lyrics: must not throw
    view.setLyrics(synced());
    expect(qa('.status')).toHaveLength(0);
    expect(qa('.line')).toHaveLength(3);
  });

  it('does not throw on empty lines or update before setLyrics', () => {
    expect(() => view.update(1)).not.toThrow();
    view.setLyrics({ ...synced(), lines: [] });
    expect(() => view.update(1)).not.toThrow();
  });

  it('destroy removes el', () => {
    view.destroy();
    expect(view.el.isConnected).toBe(false);
  });
});
