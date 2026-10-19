import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LYRICS_PREFS, type LyricsPrefs } from '../../shared/lyrics-prefs';
import type { CaptionPicker, SourceMenu } from './controller';
import { YtSettingsMenu, YtmSettingsPopover, buildMenuRows, type MenuActions, type MenuRow } from './settings-menu';

const sources: SourceMenu = { pref: 'auto', available: { lrclib: false, captions: true } };
const captions: CaptionPicker = {
  options: [
    { index: 0, label: 'English' },
    { index: 1, label: 'Spanish' },
  ],
  selected: { index: 1 },
};

function actions() {
  return { selectSource: vi.fn(), selectCaptionTrack: vi.fn(), setPrefs: vi.fn(), setOffset: vi.fn(), copyLyrics: vi.fn(() => 'Copied'), saveLrc: vi.fn(() => 'Saved'), findLyrics: vi.fn(), myLyrics: vi.fn() } satisfies MenuActions;
}
const prefs = (p: Partial<LyricsPrefs> = {}): LyricsPrefs => ({ ...DEFAULT_LYRICS_PREFS, ...p });
/** The row with `id` anywhere in the sections. */
const find = (rows: MenuRow[], id: string): MenuRow | undefined => {
  for (const r of rows) {
    const hit = r.id === id ? r : r.rows && find(r.rows, id);
    if (hit) return hit;
  }
};
/** The ids of the rows in the section with `id` (or of the top level). */
const ids = (rows: MenuRow[], id?: string): string[] => (id ? find(rows, id)?.rows ?? [] : rows).map((r) => r.id);

describe('buildMenuRows', () => {
  it('www: two sections, source (with its options) and display, in karaoke mode', () => {
    const rows = buildMenuRows({ sources, captions, prefs: prefs(), canEdit: true, timing: { offsetMs: 0 }, lyrics: { synced: true } }, actions());
    expect(ids(rows)).toEqual(['sourceSection', 'displaySection']);
    expect(ids(rows, 'sourceSection')).toEqual(['source', 'captionLanguage', 'sourceOptions']);
    expect(ids(rows, 'sourceOptions')).toEqual(['timing', 'timingKeys', 'exportLyrics']);
    expect(ids(rows, 'exportLyrics')).toEqual(['copyLyrics', 'saveLrc']);
    expect(ids(rows, 'displaySection')).toEqual(['display', 'lines', 'karaokeText', 'resetPosition']);
  });

  it('leaves out what has no content: caption language, source options, export, empty source section', () => {
    const one = { ...captions, options: captions.options.slice(0, 1) };
    expect(ids(buildMenuRows({ sources, captions: one, prefs: prefs() }, actions()), 'sourceSection')).toEqual(['source']);
    expect(ids(buildMenuRows({ prefs: prefs() }, actions()))).toEqual(['displaySection']);
    const lyrics = buildMenuRows({ sources, prefs: prefs(), timing: { offsetMs: 0 }, lyrics: { synced: false } }, actions());
    expect(ids(lyrics, 'exportLyrics')).toEqual(['copyLyrics']);
    expect(ids(buildMenuRows({ sources, prefs: prefs(), lyrics: { synced: true } }, actions()), 'sourceOptions')).toEqual(['exportLyrics']);
  });

  it('YT Music: a flat list of source, language, timing and the actions; no display section', () => {
    const rows = buildMenuRows({ sources, captions, prefs: prefs(), site: 'ytmusic', timing: { offsetMs: 0 }, lyrics: { synced: true }, canEdit: true }, actions());
    expect(ids(rows)).toEqual(['source', 'captionLanguage', 'timing', 'timingKeys', 'copyLyrics', 'saveLrc', 'findLyrics', 'myLyrics']);
    expect(rows[0].label).toBe('Lyrics source');
    expect(buildMenuRows({ prefs: prefs(), site: 'ytmusic' }, actions())).toEqual([]);
  });

  it('hides karaoke lines, the text look and Reset position in window mode', () => {
    const rows = buildMenuRows({ sources, prefs: prefs({ lyricsDisplayMode: 'window' }) }, actions());
    expect(ids(rows, 'displaySection')).toEqual(['display']);
  });

  it('disables unavailable sources and explains a fallback', () => {
    const rows = buildMenuRows({ sources: { ...sources, pref: 'lrclib', fellBack: 'lrclib' }, prefs: prefs() }, actions());
    const row = find(rows, 'source')!;
    expect(row.options.map((o) => [o.label, !!o.disabled])).toEqual([['Auto', false], ['LRCLIB (not found)', true], ['YouTube captions', false]]);
    expect(row.selected).toBe('lrclib');
    expect(row.note).toContain('automatic order');
  });

  it('names the shown source on the Auto option', () => {
    const rows = buildMenuRows({ sources: { ...sources, shown: 'youtube-auto-captions' }, prefs: prefs() }, actions());
    expect(find(rows, 'source')!.options[0].label).toBe('Auto (YouTube auto captions)');
  });

  it('routes selections to the right callback', () => {
    const a = actions();
    const all = buildMenuRows({ sources, captions, prefs: prefs() }, a);
    const rows = Object.fromEntries(['source', 'captionLanguage', 'display', 'lines', 'karaokeText'].map((id) => [id, find(all, id)!]));
    rows.source.select('captions');
    expect(a.selectSource).toHaveBeenCalledWith('captions');
    rows.captionLanguage.select('0');
    expect(a.selectCaptionTrack).toHaveBeenCalledWith({ index: 0 });
    rows.display.select('window');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ lyricsDisplayMode: 'window' });
    rows.lines.select('1');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokeLines: 1 });
    const inner = Object.fromEntries(rows.karaokeText.rows!.map((r) => [r.id, r]));
    inner.size.select('150');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokeFontSize: 150 });
    inner.color.select('#ffeb3b');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokeColor: '#ffeb3b' });
    expect(inner.size.options.map((o) => o.label)).toEqual(['50%', '75%', '100%', '125%', '150%', '200%']);
  });

  it('offers Reset position in karaoke mode only', () => {
    const a = actions();
    const reset = find(buildMenuRows({ prefs: prefs() }, a), 'resetPosition')!;
    expect(reset.label).toBe('Reset position');
    reset.run!();
    expect(a.setPrefs).toHaveBeenCalledWith({ karaokePosition: DEFAULT_LYRICS_PREFS.karaokePosition });
    expect(find(buildMenuRows({ prefs: prefs({ lyricsDisplayMode: 'window' }) }, a), 'resetPosition')).toBeUndefined();
  });

  it('timing rows: only with synced lyrics, inside Source options, in 0.25-2 s steps', () => {
    const a = actions();
    const rows = (timing?: { offsetMs: number }, site?: 'ytmusic') => buildMenuRows({ sources, captions, prefs: prefs(), timing, site }, a);
    expect(find(rows(), 'timing')).toBeUndefined();
    expect(ids(rows({ offsetMs: 0 }), 'sourceSection')).toEqual(['source', 'captionLanguage', 'sourceOptions']);
    expect(ids(rows({ offsetMs: 0 }, 'ytmusic'))).toEqual(['source', 'captionLanguage', 'timing', 'timingKeys']);
    const row = find(buildMenuRows({ sources, prefs: prefs(), timing: { offsetMs: 500 } }, a), 'timing')!;
    expect(row.selected).toBe('500');
    expect(row.options.map((o) => o.label)).toEqual(['-2 s', '-1 s', '-0.5 s', '-0.25 s', '0 s', '+0.25 s', '+0.5 s', '+1 s', '+2 s']);
    row.select('-250');
    expect(a.setOffset).toHaveBeenCalledWith(-250);
  });

  it('font, outline and background rows route to their prefs', () => {
    const a = actions();
    const inner = Object.fromEntries(find(buildMenuRows({ prefs: prefs() }, a), 'karaokeText')!.rows!.map((r) => [r.id, r]));
    expect([inner.font.selected, inner.outline.selected, inner.background.selected]).toEqual(['default', 'normal', '0']);
    inner.font.select('serif');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokeFont: 'serif' });
    inner.outline.select('thick');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokeOutline: 'thick' });
    inner.animation.select('slide');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokeAnimation: 'slide' });
    inner.background.select('50');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokeBackground: 50 });
  });

  it('style presets: Default matches the stock look, picking one sets every style pref, edits show Custom', () => {
    const a = actions();
    const preset = (p = prefs()) => find(buildMenuRows({ prefs: p }, a), 'preset')!;
    expect(preset().selected).toBe('default');
    expect(preset().options.map((o) => o.label)).toEqual(['Default', 'Big yellow', 'Clean box', 'Cyan glow', 'Reset style', 'Save the current look as My style']);
    preset().select('bigYellow');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokeColor: '#ffeb3b', karaokeFontSize: 150, karaokeFont: 'default', karaokeOutline: 'thick', karaokeBackground: 0 });
    expect(preset(prefs({ karaokeColor: '#ffeb3b', karaokeFontSize: 150, karaokeOutline: 'thick' })).selected).toBe('bigYellow');
    const custom = preset(prefs({ karaokeColor: '#123456' }));
    expect(custom.selected).toBe('custom');
    expect(custom.options.at(-3)).toEqual({ value: 'custom', label: 'Custom', disabled: true });
    a.setPrefs.mockClear();
    custom.select('custom');
    expect(a.setPrefs).not.toHaveBeenCalled();
  });

  it('export actions: copy for any shown lyrics, .lrc only for synced, also on YT Music', () => {
    const a = actions();
    const exports = (lyrics?: { synced: boolean }, site?: 'ytmusic') =>
      ids(buildMenuRows({ sources, prefs: prefs(), lyrics, site }, a), site ? undefined : 'exportLyrics').filter((id) => id === 'copyLyrics' || id === 'saveLrc');
    expect(exports()).toEqual([]);
    expect(exports({ synced: false })).toEqual(['copyLyrics']);
    expect(exports({ synced: true })).toEqual(['copyLyrics', 'saveLrc']);
    expect(exports({ synced: true }, 'ytmusic')).toEqual(['copyLyrics', 'saveLrc']);
    const rows = buildMenuRows({ sources, prefs: prefs({ lyricsDisplayMode: 'window' }), lyrics: { synced: true } }, a);
    expect(find(rows, 'copyLyrics')!.run!()).toBe('Copied');
    expect(find(rows, 'saveLrc')!.run!()).toBe('Saved');
  });

  it('timing: an offset between the steps is listed and selected; Timing keys switch routes to the pref', () => {
    const a = actions();
    const rows = buildMenuRows({ sources, prefs: prefs(), timing: { offsetMs: 300 } }, a);
    const timing = find(rows, 'timing')!;
    expect(timing.options.map((o) => o.value)).toEqual(['-2000', '-1000', '-500', '-250', '0', '250', '300', '500', '1000', '2000']);
    expect(timing.selected).toBe('300');
    const keys = find(rows, 'timingKeys')!;
    expect(keys.selected).toBe('on');
    keys.select('off');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ lyricsTimingKeys: false });
  });

  it('Find other lyrics: offered when lyrics are shown or missing, among the sources (www) and on YT Music', () => {
    const a = actions();
    const rows = (canEdit?: boolean, site?: 'ytmusic') => buildMenuRows({ sources, prefs: prefs(), canEdit, site }, a);
    const labels = (r: MenuRow[]) => find(r, 'source')!.options.map((o) => o.label);
    expect(labels(rows())).toEqual(['Auto', 'LRCLIB (not found)', 'YouTube captions']);
    // www: after the stored sources, before the YouTube captions.
    expect(labels(rows(true))).toEqual(['Auto', 'LRCLIB (not found)', 'Find other lyrics…', 'Use my own lyrics…', 'YouTube captions']);
    expect(ids(rows(true), 'sourceSection')).toEqual(['source']);
    // YT Music has selects, so the actions stay separate rows.
    expect(ids(rows(true, 'ytmusic'))).toEqual(['source', 'findLyrics', 'myLyrics']);
    const www = find(rows(true), 'source')!.options;
    www[2].run!();
    www[3].run!();
    expect(a.findLyrics).toHaveBeenCalled();
    expect(a.myLyrics).toHaveBeenCalled();
    // No source row (lyrics not loaded yet): they are rows of the section.
    expect(ids(buildMenuRows({ prefs: prefs(), canEdit: true }, a), 'sourceSection')).toEqual(['findLyrics', 'myLyrics']);
  });

  it('My style: save the current look, then pick it; saving is only offered for a look that is not a preset yet', () => {
    const a = actions();
    const preset = (p = prefs()) => find(buildMenuRows({ prefs: p }, a), 'preset')!;
    const save = (r: ReturnType<typeof preset>) => r.options.find((o) => o.value === 'save')!;
    expect(save(preset()).disabled).toBe(true);
    const looks = prefs({ karaokeColor: '#123456', karaokeFontSize: 125, karaokeFont: 'mono', karaokeOutline: 'thin', karaokeBackground: 25 });
    expect(save(preset(looks)).disabled).toBe(false);
    preset(looks).select('save');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokeMyStyle: { karaokeColor: '#123456', karaokeFontSize: 125, karaokeFont: 'mono', karaokeOutline: 'thin', karaokeBackground: 25 } });
    const withMine = prefs({ ...looks, karaokeMyStyle: { karaokeColor: '#123456', karaokeFontSize: 125, karaokeFont: 'mono', karaokeOutline: 'thin', karaokeBackground: 25 } });
    expect(preset(withMine).selected).toBe('mine');
    expect(preset(withMine).options.map((o) => o.label)).toContain('My style');
    expect(save(preset(withMine)).disabled).toBe(true);
    // Another look: Replace is offered, and picking My style sets all five prefs.
    const other = prefs({ karaokeMyStyle: withMine.karaokeMyStyle, karaokeColor: '#ff80ab' });
    expect(save(preset(other)).label).toBe('Replace My style with the current look');
    expect(save(preset(other)).disabled).toBe(false);
    preset(other).select('mine');
    expect(a.setPrefs).toHaveBeenLastCalledWith(withMine.karaokeMyStyle);
  });

  it('Reset style sets the stock look and no line transition', () => {
    const a = actions();
    const row = find(buildMenuRows({ prefs: prefs({ karaokeColor: '#123456', karaokeAnimation: 'slide' }) }, a), 'preset')!;
    row.select('reset');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokeColor: '#ffffff', karaokeFontSize: 100, karaokeFont: 'default', karaokeOutline: 'normal', karaokeBackground: 0, karaokeAnimation: 'none' });
  });

  it('Position presets and Lyrics-only view rows', () => {
    const a = actions();
    const inner = (p = prefs()) => Object.fromEntries(find(buildMenuRows({ prefs: p }, a), 'karaokeText')!.rows!.map((r) => [r.id, r]));
    expect(inner().position.selected).toBe('bottom');
    expect(inner().position.options.map((o) => o.label)).toEqual(['Top', 'Middle', 'Bottom']);
    inner().position.select('top');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokePosition: { x: 0.5, y: 0.12 } });
    const dragged = inner(prefs({ karaokePosition: { x: 0.3, y: 0.4 } })).position;
    expect(dragged.selected).toBe('custom');
    expect(dragged.options.at(-1)).toMatchObject({ value: 'custom', disabled: true });
    expect(inner().focus.selected).toBe('off');
    inner().focus.select('on');
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokeFocus: true });
  });

  it('shows the nearest size step for an off-step stored size', () => {
    const rows = buildMenuRows({ prefs: prefs({ karaokeFontSize: 110 }) }, actions());
    expect(find(rows, 'size')!.selected).toBe('100');
  });

  it('color: White first and the default; a color outside the presets is listed as Custom', () => {
    const color = (c?: string) => find(buildMenuRows({ prefs: prefs(c ? { karaokeColor: c } : {}) }, actions()), 'color')!;
    expect(color().options[0]).toEqual({ value: '#ffffff', label: 'White' });
    expect(color().selected).toBe('#ffffff');
    expect(color().options).toHaveLength(6);
    const custom = color('#123456');
    expect(custom.options.at(-1)).toEqual({ value: '#123456', label: 'Custom (#123456)' });
    expect(custom.selected).toBe('#123456');
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

const reducedMotion = (on: boolean) => {
  window.matchMedia = ((q: string) => ({ matches: on, media: q })) as unknown as typeof window.matchMedia;
};

describe('YtSettingsMenu', () => {
  beforeEach(() => {
    fakePopup();
    reducedMotion(true); // panels switch at once; the slide has its own test
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  const mkRows = (a = actions(), p = prefs(), c: CaptionPicker | undefined = captions) => buildMenuRows({ sources, captions: c, prefs: p }, a);
  const setAll = (m: YtSettingsMenu, a = actions(), p = prefs()) => m.setRows(mkRows(a, p));
  const rowEls = () => [...document.querySelectorAll<HTMLElement>('[data-am-row="lyrics"]')];
  const group = () => rowEls()[0];
  const popup = () => document.querySelector<HTMLElement>('.ytp-settings-menu')!;
  const sub = () => document.querySelector<HTMLElement>('[data-am-panel]')!;

  it('slides panels with YouTube’s own classes, then leaves only the new one', () => {
    vi.useFakeTimers();
    try {
      reducedMotion(false);
      const m = new YtSettingsMenu();
      setAll(m);
      m.ensure();
      const main = document.querySelector<HTMLElement>('.ytp-panel')!;
      group().click();
      expect(sub().classList.contains('ytp-panel-animate-forward')).toBe(true); // start state, dropped next frame to slide in
      vi.advanceTimersByTime(20);
      expect(sub().classList.contains('ytp-panel-animate-forward')).toBe(false);
      expect(main.classList.contains('ytp-panel-animate-back')).toBe(true);
      expect(main.style.display).not.toBe('none'); // still on screen while it slides out
      expect(popup().classList.contains('ytp-popup-animating')).toBe(true);
      vi.advanceTimersByTime(400);
      expect(sub().className).toBe('ytp-panel');
      expect(popup().classList.contains('ytp-popup-animating')).toBe(false);
      expect(main.style.display).toBe('none');
      sub().querySelector<HTMLElement>('.ytp-panel-back-button')!.click();
      expect(sub().classList.contains('ytp-panel-animate-forward')).toBe(true); // the old panel slides out
      vi.advanceTimersByTime(400);
      expect(document.querySelector('[data-am-panel]')).toBeNull();
      expect(main.style.display).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
  const settingEl = (id: string) => sub().querySelector<HTMLElement>(`[data-am-row-setting="${id}"]`)!;
  /** Click down through the panels: each id is a row of the panel that is open. */
  const go = (...ids: string[]) => {
    group().click();
    for (const id of ids) settingEl(id).click();
  };
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

  it('opens the Lyrics panel with its two sections, each with its settings, then goes back', () => {
    const a = actions();
    const m = new YtSettingsMenu();
    setAll(m, a);
    group().click();
    expect(titles()).toEqual(['Lyrics']);
    expect((document.getElementById('main') as HTMLElement).style.display).toBe('none');
    const labels = () => [...sub().querySelectorAll<HTMLElement>('.ytp-menuitem')].map((i) => i.querySelector('.ytp-menuitem-label')!.textContent);
    const content = (i: number) => sub().querySelectorAll<HTMLElement>('.ytp-menuitem')[i].querySelector('.ytp-menuitem-content')!.textContent;
    expect(labels()).toEqual(['Lyrics source', 'Lyrics display']);
    expect([content(0), content(1)]).toEqual(['Auto', 'Karaoke text']);
    settingEl('sourceSection').click();
    expect(titles()).toEqual(['Lyrics source']);
    expect(labels()).toEqual(['Source', 'Caption language']);
    sub().querySelector<HTMLElement>('.ytp-panel-back-button')!.click();
    settingEl('displaySection').click();
    expect(titles()).toEqual(['Lyrics display']);
    expect(labels()).toEqual(['Display', 'Karaoke lines', 'Custom Karaoke Text', 'Reset position']);
    expect(content(2)).toBe('White · 100%');
    sub().querySelector<HTMLElement>('.ytp-panel-back-button')!.click();
    sub().querySelector<HTMLElement>('.ytp-panel-back-button')!.click();
    expect(document.querySelector('[data-am-panel]')).toBeNull();
    expect((document.getElementById('main') as HTMLElement).style.display).toBe('');
  });

  it('Source options: timing and export live under the source section, three panels deep', () => {
    const a = actions();
    const m = new YtSettingsMenu();
    const input = { sources, captions, prefs: prefs(), timing: { offsetMs: 250 }, lyrics: { synced: true }, canEdit: true };
    m.setRows(buildMenuRows(input, a));
    go('sourceSection');
    const labels = () => [...sub().querySelectorAll('.ytp-menuitem-label')].map((e) => e.textContent);
    expect(labels()).toEqual(['Source', 'Caption language', 'Source options']);
    settingEl('sourceOptions').click();
    expect(titles()).toEqual(['Source options']);
    expect(labels()).toEqual(['Lyrics timing', 'Timing keys', 'Export lyrics']);
    settingEl('exportLyrics').click();
    expect(titles()).toEqual(['Export lyrics']);
    expect(labels()).toEqual(['Copy lyrics', 'Save as .lrc']);
    sub().querySelector<HTMLElement>('[data-am-row-button="saveLrc"]')!.click();
    expect(a.saveLrc).toHaveBeenCalled();
    expect(titles()).toEqual(['Export lyrics']); // an action keeps the panel open
    sub().querySelector<HTMLElement>('.ytp-panel-back-button')!.click();
    expect(titles()).toEqual(['Source options']);
    settingEl('timing').click();
    sub().querySelectorAll<HTMLElement>('.ytp-menuitem')[5].click(); // +0.25 s is the 6th step
    expect(a.setOffset).toHaveBeenCalledWith(250);
    expect(titles()).toEqual(['Source options']);
  });

  it('Find other lyrics and Use my own lyrics sit in the Source choices, before YouTube captions, and run without picking a source', () => {
    const a = actions();
    const m = new YtSettingsMenu();
    m.setRows(buildMenuRows({ sources, prefs: prefs(), canEdit: true }, a));
    go('sourceSection', 'source');
    const labels = [...sub().querySelectorAll('.ytp-menuitem-label')].map((e) => e.textContent);
    expect(labels).toEqual(['Auto', 'LRCLIB (not found)', 'Find other lyrics…', 'Use my own lyrics…', 'YouTube captions']);
    sub().querySelector<HTMLElement>('[data-am-row-button="findLyrics"]')!.click();
    sub().querySelector<HTMLElement>('[data-am-row-button="myLyrics"]')!.click();
    expect(a.findLyrics).toHaveBeenCalled();
    expect(a.myLyrics).toHaveBeenCalled();
    expect(a.selectSource).not.toHaveBeenCalled();
    expect(titles()).toEqual(['Source']); // an action keeps the panel open
    expect(sub().querySelectorAll('[aria-checked="true"]')).toHaveLength(1);
  });

  it('Custom Karaoke Text: opens Color and Size, picks a preset and a custom color', () => {
    const a = actions();
    const m = new YtSettingsMenu();
    setAll(m, a);
    go('displaySection', 'karaokeText');
    expect(titles()).toEqual(['Custom Karaoke Text']);
    expect([...sub().querySelectorAll('[data-am-row-setting]')].map((e) => e.getAttribute('data-am-row-setting'))).toEqual(['preset', 'color', 'size', 'font', 'outline', 'background', 'animation', 'position', 'focus']);
    settingEl('color').click();
    expect(titles()).toEqual(['Color']);
    const checked = [...sub().querySelectorAll('.ytp-menuitem')].map((i) => i.getAttribute('aria-checked'));
    expect(checked.slice(0, 2)).toEqual(['true', 'false']);
    const input = sub().querySelector<HTMLInputElement>('input[type="color"]')!;
    expect(input.value).toBe('#ffffff');
    input.value = '#112233';
    input.dispatchEvent(new Event('change'));
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokeColor: '#112233' });
    sub().querySelectorAll<HTMLElement>('.ytp-menuitem')[1].click();
    expect(a.setPrefs).toHaveBeenLastCalledWith({ karaokeColor: '#ffeb3b' });
    // A choice returns to the group panel; back leaves it for the display section.
    expect(titles()).toEqual(['Custom Karaoke Text']);
    sub().querySelector<HTMLElement>('.ytp-panel-back-button')!.click();
    expect(titles()).toEqual(['Lyrics display']);
  });

  it('an action that returns a message shows it for a moment', () => {
    vi.useFakeTimers();
    const a = actions();
    const m = new YtSettingsMenu();
    m.setRows(buildMenuRows({ sources, captions, prefs: prefs(), lyrics: { synced: false } }, a));
    go('sourceSection', 'sourceOptions', 'exportLyrics');
    const btn = sub().querySelector<HTMLElement>('[data-am-row-button="copyLyrics"]')!;
    const text = () => btn.querySelector('.ytp-menuitem-label')!.textContent;
    expect(text()).toBe('Copy lyrics');
    btn.click();
    expect(a.copyLyrics).toHaveBeenCalled();
    expect(text()).toBe('Copied');
    vi.advanceTimersByTime(1600);
    expect(text()).toBe('Copy lyrics');
    vi.useRealTimers();
  });

  it('Reset position runs the action and keeps the panel open', () => {
    const a = actions();
    const m = new YtSettingsMenu();
    setAll(m, a, prefs({ karaokePosition: { x: 0.1, y: 0.1 } }));
    go('displaySection');
    sub().querySelector<HTMLElement>('[data-am-row-button="resetPosition"]')!.click();
    expect(a.setPrefs).toHaveBeenCalledWith({ karaokePosition: DEFAULT_LYRICS_PREFS.karaokePosition });
    expect(titles()).toEqual(['Lyrics display']);
  });

  it('opens a setting’s choices, selects, and returns to its section', () => {
    const a = actions();
    const m = new YtSettingsMenu();
    setAll(m, a);
    go('sourceSection', 'captionLanguage');
    expect(titles()).toEqual(['Caption language']);
    expect([...sub().querySelectorAll('.ytp-menuitem')].map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    // Back from the choices goes to the section, back again to the Lyrics panel, again leaves.
    sub().querySelector<HTMLElement>('.ytp-panel-back-button')!.click();
    expect(titles()).toEqual(['Lyrics source']);
    expect(a.selectCaptionTrack).not.toHaveBeenCalled();
    settingEl('captionLanguage').click();
    sub().querySelectorAll<HTMLElement>('.ytp-menuitem')[0].click();
    expect(a.selectCaptionTrack).toHaveBeenCalledWith({ index: 0 });
    expect(titles()).toEqual(['Lyrics source']);
    sub().querySelector<HTMLElement>('.ytp-panel-back-button')!.click();
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
    go('displaySection', 'karaokeText', 'size');
    sub().querySelectorAll<HTMLElement>('.ytp-menuitem')[4].click();
    expect(settingEl('size').querySelector('.ytp-menuitem-content')!.textContent).toBe('150%');
    sub().querySelector<HTMLElement>('.ytp-panel-back-button')!.click();
    expect(settingEl('karaokeText').querySelector('.ytp-menuitem-content')!.textContent).toBe('White · 150%');
    sub().querySelector<HTMLElement>('.ytp-panel-back-button')!.click();
    // Disabled source option: no callback, choices stay.
    settingEl('sourceSection').click();
    settingEl('source').click();
    const opts = sub().querySelectorAll<HTMLElement>('.ytp-menuitem');
    opts[1].click();
    expect(a.selectSource).not.toHaveBeenCalled();
    expect(titles()).toEqual(['Source']);
    opts[2].click();
    expect(a.selectSource).toHaveBeenCalledWith('captions');
    // Window mode drops the karaoke settings and the reset action.
    sub().querySelector<HTMLElement>('.ytp-panel-back-button')!.click();
    settingEl('displaySection').click();
    settingEl('display').click();
    sub().querySelectorAll<HTMLElement>('.ytp-menuitem')[1].click();
    expect([...sub().querySelectorAll('[data-am-row-setting]')].map((e) => e.getAttribute('data-am-row-setting'))).toEqual(['display']);
    expect(sub().querySelector('[data-am-row-button]')).toBeNull();
    sub().querySelector<HTMLElement>('.ytp-panel-back-button')!.click();
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
    go('displaySection', 'karaokeText', 'size');
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

  it('caps its height and scrolls, so the top rows stay reachable', () => {
    const pop = new YtmSettingsPopover();
    document.body.append(pop.button);
    pop.setRows(buildMenuRows({ sources, captions, prefs: prefs() }, actions()));
    pop.button.click();
    const root = document.querySelector<HTMLElement>('[data-allmixer-lyrics-popover]')!;
    expect(root.style.maxHeight).toMatch(/^\d+px$/);
    expect(root.style.overflowY).toBe('auto');
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
    expect(sels).toHaveLength(13);
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
    expect(root.querySelectorAll('select')).toHaveLength(12);
    pop.setRows(buildMenuRows({ sources, prefs: prefs({ lyricsDisplayMode: 'window' }) }, actions()));
    expect(root.querySelectorAll('select')).toHaveLength(2);
    pop.destroy();
  });

  it('shows the reset button and runs it', () => {
    const a = actions();
    const pop = new YtmSettingsPopover();
    document.body.append(pop.button);
    const input = { sources, prefs: prefs() };
    pop.setRows(buildMenuRows(input, a));
    pop.button.click();
    document.querySelector<HTMLElement>('[data-allmixer-lyrics-popover] [data-am-row="resetPosition"]')!.click();
    expect(a.setPrefs).toHaveBeenCalledWith({ karaokePosition: DEFAULT_LYRICS_PREFS.karaokePosition });
    pop.destroy();
  });
});
