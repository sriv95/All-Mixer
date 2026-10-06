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

  describe('key isolation from YouTube', () => {
    let seen: string[];
    const spy = (e: Event) => seen.push(e.type);
    const press = (el: HTMLElement, key: string, mods: KeyboardEventInit = {}) => {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, composed: true, ...mods }));
      }
    };
    beforeEach(() => {
      seen = [];
      for (const t of ['keydown', 'keypress', 'keyup']) document.addEventListener(t, spy);
      view.setLyrics(synced());
    });
    afterEach(() => {
      for (const t of ['keydown', 'keypress', 'keyup']) document.removeEventListener(t, spy);
    });

    it('Space seeks once and never reaches the page', () => {
      press(qa('.line')[0], ' ');
      expect(onSeek).toHaveBeenCalledTimes(1);
      expect(onSeek).toHaveBeenCalledWith(1);
      expect(seen).toEqual([]);
    });

    it('Enter seeks once and never reaches the page', () => {
      press(qa('.line')[2], 'Enter');
      expect(onSeek).toHaveBeenCalledTimes(1);
      expect(onSeek).toHaveBeenCalledWith(6);
      expect(seen).toEqual([]);
    });

    it.each(['ArrowLeft', 'ArrowRight'])('%s does not seek and never reaches the page', (key) => {
      press(qa('.line')[0], key);
      expect(onSeek).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
    });

    it('unguarded keys and Ctrl+ArrowRight reach the page', () => {
      press(qa('.line')[0], 'k');
      expect(seen).toEqual(['keydown', 'keypress', 'keyup']);
      seen.length = 0;
      press(qa('.line')[0], 'ArrowRight', { ctrlKey: true });
      expect(seen).toEqual(['keydown', 'keypress', 'keyup']);
      expect(onSeek).not.toHaveBeenCalled();
    });
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
    view.setLyrics({ ...synced(), source: 'youtube-captions' });
    expect(q('.footer').textContent).toBe('Lyrics: YouTube captions');
  });

  it('shows a caption language menu with an auto-translate group and reports the pick', () => {
    const onCaptionTrack = vi.fn();
    const v = new LyricsView({ onSeek, onCaptionTrack });
    document.body.append(v.el);
    const options = [
      { index: 0, label: 'English', group: 'track' as const },
      { index: 1, label: 'Spanish', group: 'track' as const },
      { index: 1, tlang: 'de', label: 'German (auto-translated)', group: 'translate' as const },
    ];
    v.setLyrics({ ...synced(), source: 'youtube-captions' }, { options, selected: { index: 1 } });
    const root = v.el.shadowRoot!;
    const sel = root.querySelector<HTMLSelectElement>('select.lang')!;
    expect(sel.selectedOptions[0].textContent).toBe('Spanish');
    expect(sel.querySelector('optgroup')?.label).toBe('Auto-translate');
    expect(sel.querySelectorAll('optgroup option')).toHaveLength(1);
    sel.focus();
    expect(root.activeElement).toBe(sel);
    sel.value = '2';
    sel.dispatchEvent(new Event('change'));
    expect(onCaptionTrack).toHaveBeenCalledTimes(1);
    expect(onCaptionTrack).toHaveBeenLastCalledWith({ index: 1, tlang: 'de' });
    expect(root.activeElement).not.toBe(sel);
    sel.value = '0';
    sel.dispatchEvent(new Event('change'));
    expect(onCaptionTrack).toHaveBeenLastCalledWith({ index: 0 });
    // The translated pick is the selected entry.
    v.setLyrics({ ...synced(), source: 'youtube-captions' }, { options, selected: { index: 1, tlang: 'de' } });
    expect(root.querySelector<HTMLSelectElement>('select.lang')!.selectedOptions[0].textContent).toBe('German (auto-translated)');
    // A new video's state replaces the select: its value follows the new selection, never the previous one.
    const next = [options[0], { index: 0, tlang: 'fr', label: 'French (auto-translated)', group: 'translate' as const }];
    v.setLyrics({ ...synced(), source: 'youtube-captions' }, { options: next, selected: { index: 0, tlang: 'fr' } });
    expect(root.querySelector<HTMLSelectElement>('select.lang')!.selectedOptions[0].textContent).toBe('French (auto-translated)');
    v.setLyrics({ ...synced(), source: 'youtube-captions' }, { options: next, selected: { index: 0 } });
    expect(root.querySelector<HTMLSelectElement>('select.lang')!.selectedOptions[0].textContent).toBe('English');
    // One option: nothing to pick.
    v.setLyrics({ ...synced(), source: 'youtube-captions' }, { options: options.slice(0, 1), selected: { index: 0 } });
    expect(root.querySelector('select.lang')).toBeNull();
    v.destroy();
  });

  it('blurs the language and source selects after a pick so keys go back to the page', () => {
    const onCaptionTrack = vi.fn();
    const onSource = vi.fn();
    const v = new LyricsView({ onSeek, onCaptionTrack, onSource });
    document.body.append(v.el);
    const options = [
      { index: 0, label: 'English', group: 'track' as const },
      { index: 1, label: 'Spanish', group: 'track' as const },
    ];
    v.setLyrics(synced(), { options, selected: { index: 0 } }, { pref: 'auto', available: { lrclib: true, captions: true } });
    const root = v.el.shadowRoot!;
    for (const [cls, value, cb, arg] of [['lang', '1', onCaptionTrack, { index: 1 }], ['src', 'captions', onSource, 'captions']] as const) {
      const sel = root.querySelector<HTMLSelectElement>(`select.${cls}`)!;
      sel.focus();
      expect(root.activeElement).toBe(sel);
      sel.value = value;
      sel.dispatchEvent(new Event('change'));
      expect(root.activeElement).not.toBe(sel);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(arg);
    }
    v.destroy();
    v.el.remove();
  });

  it('shows a source menu with disabled unavailable sources, reports the pick and keeps keys from the page', () => {
    const onSource = vi.fn();
    const v = new LyricsView({ onSeek, onSource });
    document.body.append(v.el);
    v.setLyrics(synced(), undefined, { pref: 'auto', available: { lrclib: false, captions: true } });
    const root = v.el.shadowRoot!;
    const sel = root.querySelector<HTMLSelectElement>('select.src')!;
    const opts = [...sel.options].map((o) => [o.textContent, o.disabled]);
    expect(opts).toEqual([['Auto', false], ['LRCLIB (not found)', true], ['YouTube captions', false]]);
    expect(sel.value).toBe('auto');
    sel.focus();
    expect(root.activeElement).toBe(sel);
    sel.value = 'captions';
    sel.dispatchEvent(new Event('change'));
    expect(onSource).toHaveBeenCalledTimes(1);
    expect(onSource).toHaveBeenCalledWith('captions');
    expect(root.activeElement).not.toBe(sel);
    const seen: string[] = [];
    const spy = (e: Event) => seen.push(e.type);
    for (const t of ['keydown', 'keypress', 'keyup']) document.addEventListener(t, spy);
    for (const t of ['keydown', 'keypress', 'keyup']) sel.dispatchEvent(new KeyboardEvent(t, { key: 'ArrowDown', bubbles: true, composed: true }));
    for (const t of ['keydown', 'keypress', 'keyup']) document.removeEventListener(t, spy);
    expect(seen).toEqual([]);
    // No callback or no data: no menu. Fallback note in the footer.
    v.setLyrics(synced(), undefined, { pref: 'lrclib', available: { lrclib: false, captions: true }, fellBack: 'lrclib' });
    expect(root.querySelector('.source')!.textContent).toContain('LRCLIB: not found');
    v.setLyrics(synced());
    expect(root.querySelector('select.src')).toBeNull();
    v.destroy();
  });

  it('keyboard scrolling pauses auto-scroll', () => {
    view.setLyrics(synced());
    const sc = q('.scroll');
    const spy = vi.fn();
    sc.scrollTo = spy as unknown as typeof sc.scrollTo;
    q('.line').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    view.update(1.5);
    expect(spy).not.toHaveBeenCalled();
    expect(onSeek).not.toHaveBeenCalled();
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

describe('LyricsView panel mode', () => {
  let pv: LyricsView;
  let resize: (() => void) | null;
  let disconnect: Mock<() => void>;
  const pq = (sel: string) => pv.el.shadowRoot!.querySelector(sel) as HTMLElement;

  beforeEach(() => {
    resize = null;
    disconnect = vi.fn<() => void>();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resize = cb;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    pv = new LyricsView({ onSeek: vi.fn(), panel: true });
    document.body.appendChild(pv.el);
  });
  afterEach(() => {
    pv.destroy();
    vi.unstubAllGlobals();
  });

  it('adds the panel class only in panel mode', () => {
    expect(pq('.wrap').classList.contains('panel')).toBe(true);
    view.setLyrics(synced());
    expect(q('.wrap').classList.contains('panel')).toBe(false);
    expect(qa('.lock')).toHaveLength(0);
  });

  it('shows the lock button only with synced lyrics and toggles it', () => {
    pv.setLyrics({ kind: 'plain', source: 'lrclib', text: 'x' });
    expect(pv.el.shadowRoot!.querySelector('.lock')).toBeNull();
    pv.setLyrics(synced());
    const btn = pq('.lock');
    expect(btn.textContent).toBe('Centered');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(pq('.scroll').style.overflowY).toBe('hidden');
    btn.click();
    expect(btn.textContent).toBe('Free scroll');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(pq('.scroll').style.overflowY).toBe('auto');
  });

  it('keeps plain lyrics and status messages scrollable', () => {
    pv.setLyrics({ kind: 'plain', source: 'lrclib', text: 'x' });
    expect(pq('.scroll').style.overflowY).toBe('auto');
    pv.setLyrics(synced());
    expect(pq('.scroll').style.overflowY).toBe('hidden');
    pv.setStatus('loading');
    expect(pq('.scroll').style.overflowY).toBe('auto');
    pv.setLyrics(synced());
    pq('.lock').click();
    expect(pq('.scroll').style.overflowY).toBe('auto');
  });

  it('re-centers instantly on resize while locked', () => {
    pv.setLyrics(synced());
    pv.update(1.5);
    const sc = pq('.scroll');
    const scrollTo = vi.fn();
    sc.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
    Object.defineProperty(sc, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(pv.el.shadowRoot!.querySelector('.line')!, 'offsetTop', { value: 500 });
    resize!();
    expect(sc.classList.contains('synced')).toBe(true);
    expect(sc.style.paddingBlock).toBe('');
    expect(scrollTo).toHaveBeenCalledWith({ top: 400, behavior: 'auto' });
  });

  it('does not scroll when unlocked, and snaps back once on re-lock', () => {
    pv.setLyrics(synced());
    const sc = pq('.scroll');
    const scrollTo = vi.fn();
    sc.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
    pv.update(1.5);
    scrollTo.mockClear();
    pq('.lock').click();
    pv.update(6.5);
    resize!();
    expect(scrollTo).not.toHaveBeenCalled();
    pq('.lock').click();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.calls[0][0].behavior).toBe('auto');
  });

  it('keeps the top in view before the first line, and disconnects on destroy', () => {
    pv.setLyrics(synced());
    const scrollTo = vi.fn();
    pq('.scroll').scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
    resize!();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    pv.destroy();
    expect(disconnect).toHaveBeenCalled();
  });
});
