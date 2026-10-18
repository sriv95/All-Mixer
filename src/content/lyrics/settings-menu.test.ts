import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LYRICS_PREFS, type LyricsPrefs } from '../../shared/lyrics-prefs';
import type { CaptionPicker, SourceMenu } from './controller';
import { YtSettingsMenu, YtmSettingsPopover, buildMenuButtons, buildMenuRows, type MenuActions } from './settings-menu';

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

  it('YT Music: only source and caption language, no display rows or reset button', () => {
    expect(buildMenuRows({ sources, captions, prefs: prefs(), site: 'ytmusic' }, actions()).map((r) => r.id)).toEqual(['source', 'captionLanguage']);
    expect(buildMenuButtons({ prefs: prefs(), site: 'ytmusic' }, actions())).toEqual([]);
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

  it('names the shown source on the Auto option', () => {
    const rows = buildMenuRows({ sources: { ...sources, shown: 'youtube-auto-captions' }, prefs: prefs() }, actions());
    expect(rows[0].options[0].label).toBe('Auto (YouTube auto captions)');
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

  it('offers Reset position in karaoke mode only', () => {
    const a = actions();
    const buttons = buildMenuButtons({ prefs: prefs() }, a);
    expect(buttons.map((b) => b.label)).toEqual(['Reset position']);
    buttons[0].run();
    expect(a.setPrefs).toHaveBeenCalledWith({ karaokePosition: DEFAULT_LYRICS_PREFS.karaokePosition });
    expect(buildMenuButtons({ prefs: prefs({ lyricsDisplayMode: 'window' }) }, a)).toEqual([]);
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
  const mkButtons = (a = actions(), p = prefs()) => buildMenuButtons({ sources, captions, prefs: p }, a);
  const setAll = (m: YtSettingsMenu, a = actions(), p = prefs()) => m.setRows(mkRows(a, p), mkButtons(a, p));
  const rowEls = () => [...document.querySelectorAll<HTMLElement>('[data-am-row="lyrics"]')];
  const group = () => rowEls()[0];
  const popup = () => document.querySelector<HTMLElement>('.ytp-settings-menu')!;
  const sub = () => document.querySelector<HTMLElement>('[data-am-panel]')!;
  const settingEl = (id: string) => sub().querySelector<HTMLElement>(`[data-am-row-setting="${id}"]`)!;
  const titles = () => [...document.querySelectorAll('[data-am-panel] .ytp-panel-title')].map((e) => e.textContent);

  it('adds one Lyrics row with the ♪ icon after the native ones, once', () => {
    const m = new YtSettingsMenu();
    setAll(m);
    const menu = document.getElementById('mainm')!;
    expect([...menu.children].map((c) => c.getAttribute('data-am-row'))).toEqual([null, 'lyrics']);
    expect(group().querySelector('.ytp-menuitem-icon')!.textContent).toBe('♪');
    expect(group().querySelector('.ytp-menuitem-label')!.textContent).toBe('Lyrics');
    expect(group().querySelector('.ytp-menuitem-content')!.textContent).toBe('Karaoke text');
    setAll(m);
    m.ensure();
    expect(rowEls()).toHaveLength(1);
    expect(document.getElementById('speed')).not.toBeNull();
  });

  it('adds no row without settings', () => {
    const m = new YtSettingsMenu();
    m.setRows([]);
    expect(rowEls()).toHaveLength(0);
  });

  it('re-inserts the row when YouTube re-renders the menu, without duplicates', () => {
    const m = new YtSettingsMenu();
    setAll(m);
    const menu = document.getElementById('mainm')!;
    menu.replaceChildren(menu.firstElementChild!);
    expect(rowEls()).toHaveLength(0);
    m.ensure();
    expect(rowEls()).toHaveLength(1);
    // Whole popup replaced.
    const fresh = popup().cloneNode(true) as HTMLElement;
    fresh.querySelectorAll('[data-am-row]').forEach((e) => e.remove());
    popup().replaceWith(fresh);
    m.ensure();
    expect(rowEls()).toHaveLength(1);
  });

  it('re-inserts through the MutationObserver on the player', async () => {
    const m = new YtSettingsMenu();
    m.observe(document.getElementById('movie_player')!);
    setAll(m);
    document.getElementById('mainm')!.querySelectorAll('[data-am-row]').forEach((e) => e.remove());
    await new Promise((r) => setTimeout(r, 60));
    expect(rowEls()).toHaveLength(1);
    m.destroy();
    expect(rowEls()).toHaveLength(0);
  });

  it('opens the Lyrics panel with all settings and the reset button, then goes back', () => {
    const a = actions();
    const m = new YtSettingsMenu();
    setAll(m, a);
    group().click();
    expect(titles()).toEqual(['Lyrics']);
    expect((document.getElementById('main') as HTMLElement).style.display).toBe('none');
    const items = [...sub().querySelectorAll<HTMLElement>('.ytp-menuitem')];
    expect(items.map((i) => i.querySelector('.ytp-menuitem-label')!.textContent)).toEqual([
      'Lyrics source',
      'Caption language',
      'Lyrics display',
      'Karaoke lines',
      'Karaoke size',
      'Reset position',
    ]);
    expect(items[4].querySelector('.ytp-menuitem-content')!.textContent).toBe('100%');
    sub().querySelector<HTMLElement>('.ytp-panel-back-button')!.click();
    expect(document.querySelector('[data-am-panel]')).toBeNull();
    expect((document.getElementById('main') as HTMLElement).style.display).toBe('');
  });

  it('Reset position runs the action and keeps the panel open', () => {
    const a = actions();
    const m = new YtSettingsMenu();
    setAll(m, a, prefs({ karaokePosition: { x: 0.1, y: 0.1 } }));
    group().click();
    sub().querySelector<HTMLElement>('[data-am-row-button="resetPosition"]')!.click();
    expect(a.setPrefs).toHaveBeenCalledWith({ karaokePosition: DEFAULT_LYRICS_PREFS.karaokePosition });
    expect(sub()).not.toBeNull();
  });

  it('opens a setting’s choices, selects, and returns to the Lyrics panel', () => {
    const a = actions();
    const m = new YtSettingsMenu();
    setAll(m, a);
    group().click();
    settingEl('captionLanguage').click();
    expect(titles()).toEqual(['Caption language']);
    expect([...sub().querySelectorAll('.ytp-menuitem')].map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    // Back from the choices goes to the Lyrics panel, back again leaves.
    sub().querySelector<HTMLElement>('.ytp-panel-back-button')!.click();
    expect(titles()).toEqual(['Lyrics']);
    expect(a.selectCaptionTrack).not.toHaveBeenCalled();
    settingEl('captionLanguage').click();
    sub().querySelectorAll<HTMLElement>('.ytp-menuitem')[0].click();
    expect(a.selectCaptionTrack).toHaveBeenCalledWith({ index: 0 });
    expect(titles()).toEqual(['Lyrics']);
    sub().querySelector<HTMLElement>('.ytp-panel-back-button')!.click();
    expect(document.querySelector('[data-am-panel]')).toBeNull();
  });

  it('updates the shown values after a selection and ignores disabled options', () => {
    const a = actions();
    let p = prefs();
    const m = new YtSettingsMenu();
    a.setPrefs.mockImplementation((patch: Partial<LyricsPrefs>) => {
      p = { ...p, ...patch };
      setAll(m, a, p);
    });
    setAll(m, a, p);
    group().click();
    settingEl('size').click();
    sub().querySelectorAll<HTMLElement>('.ytp-menuitem')[4].click();
    expect(settingEl('size').querySelector('.ytp-menuitem-content')!.textContent).toBe('150%');
    // Disabled source option: no callback, choices stay.
    settingEl('source').click();
    const opts = sub().querySelectorAll<HTMLElement>('.ytp-menuitem');
    opts[1].click();
    expect(a.selectSource).not.toHaveBeenCalled();
    expect(titles()).toEqual(['Lyrics source']);
    opts[2].click();
    expect(a.selectSource).toHaveBeenCalledWith('captions');
    // Window mode drops the karaoke settings and the reset button.
    settingEl('display').click();
    sub().querySelectorAll<HTMLElement>('.ytp-menuitem')[1].click();
    expect([...sub().querySelectorAll('[data-am-row-setting]')].map((e) => e.getAttribute('data-am-row-setting'))).toEqual(['source', 'captionLanguage', 'display']);
    expect(sub().querySelector('[data-am-row-button]')).toBeNull();
    expect(group().querySelector('.ytp-menuitem-content')!.textContent).toBe('Lyrics window');
  });

  it('restores the popup size on back and closes the panel when YouTube hides the popup', () => {
    popup().style.width = '251px';
    popup().style.height = '200px';
    const m = new YtSettingsMenu();
    setAll(m);
    group().click();
    popup().style.display = 'none';
    m.ensure();
    expect(popup().querySelector('[data-am-panel]')).toBeNull();
    expect(popup().style.width).toBe('251px');
    expect(popup().style.height).toBe('200px');
    expect((document.getElementById('main') as HTMLElement).style.display).toBe('');
  });

  it('keeps the open panel when nothing changed (no re-render loop)', () => {
    const m = new YtSettingsMenu();
    setAll(m);
    group().click();
    const panel = sub();
    for (let i = 0; i < 5; i++) m.ensure();
    expect(document.querySelectorAll('[data-am-panel]')).toHaveLength(1);
    expect(sub()).toBe(panel);
  });

  it('re-renders the open panel when a setting changes', () => {
    const a = actions();
    let p = prefs();
    const m = new YtSettingsMenu();
    setAll(m, a, p);
    group().click();
    settingEl('size').click();
    const panel = sub();
    p = { ...p, karaokeFontSize: 150 };
    setAll(m, a, p);
    expect(sub()).not.toBeNull();
    expect(sub()).not.toBe(panel);
    expect(document.querySelectorAll('[data-am-panel]')).toHaveLength(1);
  });

  it('closes cleanly when YouTube removes our panel', () => {
    const m = new YtSettingsMenu();
    setAll(m);
    group().click();
    sub().remove();
    m.ensure();
    m.ensure();
    expect(document.querySelectorAll('[data-am-panel]').length).toBeLessThanOrEqual(1);
    expect((document.getElementById('main') as HTMLElement).style.display).toBe('');
  });

  it('does nothing without a settings popup', () => {
    document.body.replaceChildren();
    const m = new YtSettingsMenu();
    expect(() => setAll(m)).not.toThrow();
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

  it('shows the reset button and runs it', () => {
    const a = actions();
    const pop = new YtmSettingsPopover();
    document.body.append(pop.button);
    const input = { sources, prefs: prefs() };
    pop.setRows(buildMenuRows(input, a), buildMenuButtons(input, a));
    pop.button.click();
    document.querySelector<HTMLElement>('[data-allmixer-lyrics-popover] [data-am-row="resetPosition"]')!.click();
    expect(a.setPrefs).toHaveBeenCalledWith({ karaokePosition: DEFAULT_LYRICS_PREFS.karaokePosition });
    pop.destroy();
  });
});
