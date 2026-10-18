import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LrclibRecord } from '../../lyrics/lrclib-types';
import type { TrackInfo } from '../../lyrics/types';
import { openFindDialog, openOwnDialog, rankRecords } from './lyrics-dialog';

const track: TrackInfo = { videoId: 'v', title: 'Yellow (Official Video)', artist: 'Coldplay - Topic', duration: 270 };
const rec = (id: number, over: Partial<LrclibRecord> = {}): LrclibRecord => ({ id, trackName: `T${id}`, artistName: 'Coldplay', duration: 270, syncedLyrics: '[00:01.00]x', plainLyrics: 'x', ...over });
const flush = () => new Promise((r) => setTimeout(r, 0));
const dialog = () => document.querySelector<HTMLElement>('[data-allmixer-lyrics-dialog]');

afterEach(() => {
  document.body.replaceChildren();
});

describe('rankRecords', () => {
  it('synced first, then the closest length', () => {
    const rs = [rec(1, { syncedLyrics: null, duration: 270 }), rec(2, { duration: 300 }), rec(3, { duration: 271 })];
    expect(rankRecords(rs, 270).map((r) => r.id)).toEqual([3, 2, 1]);
  });
});

describe('openFindDialog', () => {
  const make = (results: LrclibRecord[] = [rec(1), rec(2, { duration: 280 })]) => {
    const deps = { track, search: vi.fn(async () => results), choose: vi.fn(), reset: vi.fn() };
    const close = openFindDialog(deps);
    return { deps, close };
  };

  it('searches on open with the cleaned artist and title, and lists the results', async () => {
    const { deps } = make();
    expect(deps.search).toHaveBeenCalledWith('Coldplay Yellow');
    await flush();
    const rows = [...dialog()!.querySelectorAll('[data-record]')];
    expect(rows.map((r) => r.getAttribute('data-record'))).toEqual(['1', '2']);
    expect(rows[1].textContent).toContain('+10 s vs video');
    expect(rows[0].textContent).toContain('synced');
  });

  it('choosing a result calls choose and closes', async () => {
    const { deps } = make();
    await flush();
    dialog()!.querySelector<HTMLElement>('[data-record="2"]')!.click();
    expect(deps.choose).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    expect(dialog()).toBeNull();
  });

  it('Back to automatic resets and closes; Escape and a backdrop click close without a choice', async () => {
    const { deps } = make();
    await flush();
    [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Back to automatic')!.click();
    expect(deps.reset).toHaveBeenCalled();
    expect(dialog()).toBeNull();
    make();
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog()).toBeNull();
    make();
    dialog()!.click();
    expect(dialog()).toBeNull();
    expect(deps.choose).not.toHaveBeenCalled();
  });

  it('keeps typing away from the page, searches again on Enter, and ignores a stale answer', async () => {
    const answers: ((r: LrclibRecord[]) => void)[] = [];
    const deps = { track, search: vi.fn(() => new Promise<LrclibRecord[]>((r) => answers.push(r))), choose: vi.fn(), reset: vi.fn() };
    openFindDialog(deps);
    const input = dialog()!.querySelector('input')!;
    const page = vi.fn();
    document.addEventListener('keydown', page);
    input.value = 'other words';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(page).not.toHaveBeenCalled();
    expect(deps.search).toHaveBeenLastCalledWith('other words');
    answers[1]([rec(5)]);
    answers[0]([rec(9)]);
    await flush();
    expect([...dialog()!.querySelectorAll('[data-record]')].map((r) => r.getAttribute('data-record'))).toEqual(['5']);
    document.removeEventListener('keydown', page);
  });

  it('says so when nothing is found or the search fails; only one dialog at a time', async () => {
    const deps = { track, search: vi.fn(async () => []), choose: vi.fn(), reset: vi.fn() };
    openFindDialog(deps);
    await flush();
    expect(dialog()!.textContent).toContain('No lyrics found');
    openFindDialog({ ...deps, search: vi.fn(async () => Promise.reject(new Error('net'))) });
    await flush();
    expect(document.querySelectorAll('[data-allmixer-lyrics-dialog]')).toHaveLength(1);
    expect(dialog()!.textContent).toContain('Search failed');
  });
});

describe('openOwnDialog', () => {
  const make = () => {
    const deps = { track, choose: vi.fn(), reset: vi.fn() };
    openOwnDialog(deps);
    return deps;
  };
  const area = () => dialog()!.querySelector('textarea')!;
  const button = (text: string) => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === text)!;

  it('saves usable text as lyrics for the video and closes', () => {
    const deps = make();
    area().value = '[00:01.00] a\n[00:02.00] b\n[00:03.00] c\n[00:04.00] d';
    button('Save').click();
    expect(deps.choose).toHaveBeenCalledWith(expect.objectContaining({ synced: expect.stringContaining('[00:01.00] a'), record: expect.objectContaining({ trackName: track.title }) }));
    expect(dialog()).toBeNull();
  });

  it('too short: says so, keeps the dialog open, saves nothing', () => {
    const deps = make();
    area().value = 'one\ntwo';
    button('Save').click();
    expect(deps.choose).not.toHaveBeenCalled();
    expect(dialog()!.textContent).toContain('at least 4 lines');
  });

  it('Back to automatic resets and closes', () => {
    const deps = make();
    button('Back to automatic').click();
    expect(deps.reset).toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('loads a file into the text box, and refuses a huge one', async () => {
    make();
    const input = dialog()!.querySelector<HTMLInputElement>('input[type="file"]')!;
    const setFiles = (f: File) => {
      Object.defineProperty(input, 'files', { value: [f], configurable: true });
      input.dispatchEvent(new Event('change'));
    };
    setFiles(new File(['a\nb\nc\nd'], 'song.lrc'));
    await flush();
    expect(area().value).toBe('a\nb\nc\nd');
    expect(dialog()!.textContent).toContain('Loaded song.lrc');
    setFiles(new File([new Uint8Array(1_000_001)], 'big.txt'));
    await flush();
    expect(dialog()!.textContent).toContain('too big');
    expect(area().value).toBe('a\nb\nc\nd');
  });
});
