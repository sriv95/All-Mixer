import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LYRICS_PREFS, type LyricsPrefs } from '../../shared/lyrics-prefs';
import type { CaptionPicker, SourceMenu } from './controller';
import { YtSettingsMenu, YtmSettingsPopover, buildMenuRows, type MenuActions } from './settings-menu';

const sources: SourceMenu = { pref: 'auto', available: { lrclib: false, captions: true } };
const captions: CaptionPicker = {
  options: [
    { index: 0, label: 'English' },
    { index: 1, label: 'Spanish' },
  ],
  selected: { index: 1 },
};

function actions() {
  return { selectSource: vi.fn(), selectCaptionTrack: vi.fn(), setPrefs: vi.fn() } satisfies MenuActions;
}
const prefs = (p: Partial<LyricsPrefs> = {}): LyricsPrefs => ({ ...DEFAULT_LYRICS_PREFS, ...p });

describe('buildMenuRows', () => {
  it('lists source, language, display, lines and size in karaoke mode', () => {
    const rows = buildMenuRows({ sources, captions, prefs: prefs() }, actions());
    expect(rows.map((r) => r.id)).toEqual(['source', 'captionLanguage', 'display', 'lines', 'size']);
  });

  it('hides the caption language row for fewer than two options and the source row without data', () => {
    const one = { ...captions, options: captions.options.slice(0, 1) };
    expect(buildMenuRows({ sources, captions: one, prefs: prefs() }, actions()).map((r) => r.id)).toEqual(['source', 'display', 'lines', 'size']);
    expect(buildMenuRows({ prefs: prefs() }, actions()).map((r) => r.id)).toEqual(['display', 'lines', 'size']);
  });

  it('hides karaoke lines and size in window mode', () => {
    const rows = buildMenuRows({ sources, prefs: prefs({ lyricsDisplayMode: 'window' }) }, actions());
    expect(rows.map((r) => r.id)).toEqual(['source', 'display']);
  });

  it('disables unavailable sources and explains a fallback', () => {
    const rows = buildMenuRows({ sources: { ...sources, pref: 'lrclib', fellBack: 'lrclib' }, prefs: prefs() }, actions());
    const row = rows[0];
    expect(row.options.map((o) => [o.label, !!o.disabled])).toEqual([['Auto', false], ['LRCLIB (not found)', true], ['YouTube captions', false]]);
    expect(row.selected).toBe('lrclib');
    expect(row.note).toContain('automatic order');
  });

  it('routes selections to the right callback', () => {
    const a = actions();
    const rows = Object.fromEntries(buildMenuRows({ sources, captions, prefs: prefs() }, a).map((r) => [r.id, r]));
    rows.source.select('captions');
    expect(a.selectSource).toHaveBeenCalledWith('captions');
    rows.captionLanguage.select('0');
    expect(a.selectCaptionTrack).toHaveBeenCalledWith({ index: 0 });
    rows.display.select('window');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ lyricsDisplayMode: 'window' });
    rows.lines.select('1');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokeLines: 1 });
    rows.size.select('150');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokeFontSize: 150 });
    expect(rows.size.options.map((o) => o.label)).toEqual(['50%', '75%', '100%', '125%', '150%', '200%']);
  });

  it('shows the nearest size step for an off-step stored size', () => {
    const rows = buildMenuRows({ prefs: prefs({ karaokeFontSize: 110 }) }, actions());
    expect(rows.find((r) => r.id === 'size')!.selected).toBe('100');
  });
});

function fakePopup(): HTMLElement {
  document.body.innerHTML = `
    <div id="movie_player">
      <div class="ytp-popup ytp-settings-menu">
        <div class="ytp-panel" id="main"><div class="ytp-panel-menu" id="mainm">
          <div class="ytp-menuitem" id="speed"><div class="ytp-menuitem-label">Playback speed</div><div class="ytp-menuitem-content">Normal</div></div>
        </div></div>
      </div>
    </div>`;
  return document.querySelector<HTMLElement>('.ytp-settings-menu')!;
}

describe('YtSettingsMenu', () => {
  beforeEach(() => fakePopup());
  afterEach(() => {
    document.body.replaceChildren();
  });

  const mkRows = (a = actions(), p = prefs(), c: CaptionPicker | undefined = captions) => buildMenuRows({ sources, captions: c, prefs: p }, a);
  const rowEls = () => [...document.querySelectorAll<HTMLElement>('[data-am-row]')];

  it('appends our rows after the native ones, once', () => {
    const m = new YtSettingsMenu();
    m.setRows(mkRows());
    const menu = document.getElementById('mainm')!;
    expect([...menu.children].map((c) => c.getAttribute('data-am-row'))).toEqual([null, 'source', 'captionLanguage', 'display', 'lines', 'size']);
    expect(rowEls()[0].querySelector('.ytp-menuitem-content')!.textContent).toBe('Auto');
    m.setRows(mkRows());
    m.ensure();
    expect(rowEls()).toHaveLength(5);
    expect(document.getElementById('speed')).not.toBeNull();
  });

  it('re-inserts rows when YouTube re-renders the menu, without duplicates', () => {
    const m = new YtSettingsMenu();
    m.setRows(mkRows());
    const menu = document.getElementById('mainm')!;
    menu.replaceChildren(menu.firstElementChild!);
    expect(rowEls()).toHaveLength(0);
    m.ensure();
    expect(rowEls()).toHaveLength(5);
    // Whole popup replaced.
    const popup = document.querySelector('.ytp-settings-menu')!;
    const fresh = popup.cloneNode(true) as HTMLElement;
    fresh.querySelectorAll('[data-am-row]').forEach((e) => e.remove());
    popup.replaceWith(fresh);
    m.ensure();
    expect(rowEls()).toHaveLength(5);
  });

  it('re-inserts through the MutationObserver on the player', async () => {
    const m = new YtSettingsMenu();
    m.observe(document.getElementById('movie_player')!);
    m.setRows(mkRows());
    document.getElementById('mainm')!.querySelectorAll('[data-am-row]').forEach((e) => e.remove());
    await new Promise((r) => setTimeout(r, 60));
    expect(rowEls()).toHaveLength(5);
    m.destroy();
    expect(rowEls()).toHaveLength(0);
  });

  it('opens a submenu with checked options, selects, and goes back', () => {
    const a = actions();
    const m = new YtSettingsMenu();
    m.setRows(mkRows(a));
    rowEls().find((e) => e.getAttribute('data-am-row') === 'captionLanguage')!.click();
    const popup = document.querySelector('.ytp-settings-menu')!;
    const sub = popup.querySelector<HTMLElement>('[data-am-panel]')!;
    expect(sub.querySelector('.ytp-panel-title')!.textContent).toBe('Caption language');
    expect((document.getElementById('main') as HTMLElement).style.display).toBe('none');
    const items = [...sub.querySelectorAll('.ytp-menuitem')];
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    sub.querySelector<HTMLElement>('.ytp-panel-back-button')!.click();
    expect(popup.querySelector('[data-am-panel]')).toBeNull();
    expect((document.getElementById('main') as HTMLElement).style.display).toBe('');
    expect(a.selectCaptionTrack).not.toHaveBeenCalled();

    rowEls().find((e) => e.getAttribute('data-am-row') === 'captionLanguage')!.click();
    popup.querySelectorAll<HTMLElement>('[data-am-panel] .ytp-menuitem')[0].click();
    expect(a.selectCaptionTrack).toHaveBeenCalledWith({ index: 0 });
    expect(popup.querySelector('[data-am-panel]')).toBeNull();
  });

  it('updates the row value text after a selection and ignores disabled options', () => {
    const a = actions();
    let p = prefs();
    const m = new YtSettingsMenu();
    a.setPrefs.mockImplementation((patch: Partial<LyricsPrefs>) => {
      p = { ...p, ...patch };
      m.setRows(mkRows(a, p));
    });
    m.setRows(mkRows(a, p));
    const row = (id: string) => rowEls().find((e) => e.getAttribute('data-am-row') === id)!;
    row('size').click();
    document.querySelectorAll<HTMLElement>('[data-am-panel] .ytp-menuitem')[4].click();
    expect(row('size').querySelector('.ytp-menuitem-content')!.textContent).toBe('150%');
    // Disabled source option: no callback, submenu stays.
    row('source').click();
    const opts = document.querySelectorAll<HTMLElement>('[data-am-panel] .ytp-menuitem');
    opts[1].click();
    expect(a.selectSource).not.toHaveBeenCalled();
    expect(document.querySelector('[data-am-panel]')).not.toBeNull();
    opts[2].click();
    expect(a.selectSource).toHaveBeenCalledWith('captions');
    // Window mode drops the karaoke rows.
    row('display').click();
    document.querySelectorAll<HTMLElement>('[data-am-panel] .ytp-menuitem')[1].click();
    expect(rowEls().map((e) => e.getAttribute('data-am-row'))).toEqual(['source', 'captionLanguage', 'display']);
  });

  it('restores the popup size on back and closes the submenu when YouTube hides the popup', () => {
    const popup = document.querySelector<HTMLElement>('.ytp-settings-menu')!;
    popup.style.width = '251px';
    popup.style.height = '200px';
    const m = new YtSettingsMenu();
    m.setRows(mkRows());
    rowEls()[0].click();
    popup.style.display = 'none';
    m.ensure();
    expect(popup.querySelector('[data-am-panel]')).toBeNull();
    expect(popup.style.width).toBe('251px');
    expect(popup.style.height).toBe('200px');
    expect((document.getElementById('main') as HTMLElement).style.display).toBe('');
  });

  it('keeps the open submenu panel when nothing changed (no re-render loop)', () => {
    const m = new YtSettingsMenu();
    m.setRows(mkRows());
    rowEls()[0].click();
    const panel = document.querySelector('[data-am-panel]')!;
    for (let i = 0; i < 5; i++) m.ensure();
    expect(document.querySelectorAll('[data-am-panel]')).toHaveLength(1);
    expect(document.querySelector('[data-am-panel]')).toBe(panel);
  });

  it('re-renders the open submenu when its row changes', () => {
    const a = actions();
    let p = prefs();
    const m = new YtSettingsMenu();
    m.setRows(mkRows(a, p));
    rowEls().find((e) => e.getAttribute('data-am-row') === 'size')!.click();
    const panel = document.querySelector('[data-am-panel]')!;
    p = { ...p, karaokeFontSize: 150 };
    m.setRows(mkRows(a, p));
    const next = document.querySelector('[data-am-panel]');
    expect(next).not.toBeNull();
    expect(next).not.toBe(panel);
    expect(document.querySelectorAll('[data-am-panel]')).toHaveLength(1);
  });

  it('closes cleanly when YouTube removes our panel', () => {
    const m = new YtSettingsMenu();
    m.setRows(mkRows());
    rowEls()[0].click();
    document.querySelector('[data-am-panel]')!.remove();
    m.ensure();
    m.ensure();
    expect(document.querySelectorAll('[data-am-panel]').length).toBeLessThanOrEqual(1);
    expect((document.getElementById('main') as HTMLElement).style.display).toBe('');
  });

  it('does nothing without a settings popup', () => {
    document.body.replaceChildren();
    const m = new YtSettingsMenu();
    expect(() => m.setRows(mkRows())).not.toThrow();
  });
});

describe('YtmSettingsPopover', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('opens a popover of selects, reports changes, closes on Escape and outside click', () => {
    const a = actions();
    const pop = new YtmSettingsPopover();
    document.body.append(pop.button);
    pop.setRows(buildMenuRows({ sources, captions, prefs: prefs() }, a));
    expect(document.querySelector('[data-allmixer-lyrics-popover]')).toBeNull();
    pop.button.click();
    const root = document.querySelector<HTMLElement>('[data-allmixer-lyrics-popover]')!;
    expect(pop.isOpen).toBe(true);
    expect(pop.button.getAttribute('aria-expanded')).toBe('true');
    const sels = root.querySelectorAll('select');
    expect(sels).toHaveLength(5);
    const src = sels[0];
    expect([...src.options].map((o) => o.disabled)).toEqual([false, true, false]);
    src.value = 'captions';
    src.dispatchEvent(new Event('change'));
    expect(a.selectSource).toHaveBeenCalledWith('captions');
    sels[3].value = '1';
    sels[3].dispatchEvent(new Event('change'));
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokeLines: 1 });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(pop.isOpen).toBe(false);
    pop.button.click();
    expect(pop.isOpen).toBe(true);
    root.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(pop.isOpen).toBe(true);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(pop.isOpen).toBe(false);
    pop.button.click();
    pop.button.click();
    expect(pop.isOpen).toBe(false);
    pop.destroy();
  });

  it('re-renders open rows on setRows', () => {
    const pop = new YtmSettingsPopover();
    document.body.append(pop.button);
    pop.setRows(buildMenuRows({ sources, prefs: prefs() }, actions()));
    pop.button.click();
    const root = document.querySelector<HTMLElement>('[data-allmixer-lyrics-popover]')!;
    expect(root.querySelectorAll('select')).toHaveLength(4);
    pop.setRows(buildMenuRows({ sources, prefs: prefs({ lyricsDisplayMode: 'window' }) }, actions()));
    expect(root.querySelectorAll('select')).toHaveLength(2);
    pop.destroy();
  });
});
