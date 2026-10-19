import { DEFAULT_LYRICS_PREFS, KARAOKE_BACKGROUNDS, type KaraokeAnimation, type KaraokeBackground, type KaraokeFont, type KaraokeOutline, type LyricsDisplayMode, type LyricsPrefs } from '../../shared/lyrics-prefs';
import { KARAOKE_SIZES, POSITION_PRESETS, RESET_STYLE, matchedPosition, matchedStylePreset, nearestSize, pickStyle, stylePresets } from './karaoke-presets';
import { SETTINGS_SELECTORS, findSettingsMainMenu, findSettingsPopup, type Site } from '../youtube-dom';
import type { CaptionPicker, SourceMenu, SourcePref } from './controller';
import type { CaptionPick } from './track-info';

/** One lyrics setting: its choices and the current one. Both renderers (www gear menu, YT Music popover) draw these. */
interface MenuOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** An action among the choices (never selected): it runs when picked and may return a short confirmation. */
  run?(): string | void;
}

export interface MenuRow {
  id:
    | 'source' | 'captionLanguage' | 'timing' | 'timingKeys' | 'display' | 'lines' | 'karaokeText' | 'size' | 'preset' | 'color' | 'font' | 'outline' | 'background' | 'animation' | 'position' | 'focus'
    // sections (www groups)
    | 'sourceSection' | 'displaySection' | 'sourceOptions' | 'exportLyrics'
    // actions
    | 'resetPosition' | 'copyLyrics' | 'saveLrc' | 'findLyrics' | 'myLyrics';
  label: string;
  options: MenuOption[];
  selected: string;
  /** Extra explanation shown under the choices. */
  note?: string;
  /** A group: opens a panel with these settings instead of choices (www only). */
  rows?: MenuRow[];
  /** What a group shows on its right; default: its settings' values joined. */
  summary?: string;
  /** Also offer a native color picker under the choices; the values are #rrggbb. */
  picker?: 'color';
  select(value: string): void;
  /** An action instead of a setting (reset position, copy lyrics...): no choices. May return a short confirmation shown in place of the label for a moment. */
  run?(): string | void;
}

/** An action row: it runs `run` when picked and has no choices. */
const action = (id: MenuRow['id'], label: string, run: () => string | void): MenuRow => ({ id, label, options: [], selected: '', select: () => {}, run });

export interface MenuActions {
  selectSource(pref: SourcePref): void;
  selectCaptionTrack(pick: CaptionPick): void;
  setPrefs(patch: Partial<LyricsPrefs>): void;
  /** Timing offset of the current video's lyrics, in ms. */
  setOffset(ms: number): void;
  copyLyrics(): string | void;
  saveLrc(): string | void;
  /** Open the dialog to pick other lyrics for this video. */
  findLyrics(): void;
  /** Open the dialog to paste or load lyrics for this video. */
  myLyrics(): void;
}

export interface MenuInput {
  sources?: SourceMenu;
  captions?: CaptionPicker;
  prefs: LyricsPrefs;
  /** Set while synced lyrics of a known video are shown: the timing rows appear. */
  timing?: { offsetMs: number };
  /** Set while lyrics are shown: the copy action appears, and the .lrc one for synced lyrics. */
  lyrics?: { synced: boolean };
  /** Lyrics are shown or missing for a known video: the "Find other lyrics" and "Use my own lyrics" actions appear. */
  canEdit?: boolean;
  /** YT Music has no karaoke text or lyrics window (the Lyrics tab only), so it gets no display rows. Default: www. */
  site?: Site;
}

const SHOWN_LABELS = { lrclib: 'LRCLIB', 'youtube-captions': 'YouTube captions', 'youtube-auto-captions': 'YouTube auto captions' } as const;

const TIMING_STEPS_MS = [-2000, -1000, -500, -250, 0, 250, 500, 1000, 2000] as const;

export const timingLabel = (ms: number): string => `${ms > 0 ? '+' : ''}${ms / 1000} s`;

const COLOR_PRESETS: readonly [string, string][] = [
  ['#ffffff', 'White'],
  ['#ffeb3b', 'Yellow'],
  ['#4dd0e1', 'Cyan'],
  ['#69f0ae', 'Green'],
  ['#ff80ab', 'Pink'],
  ['#ffab40', 'Orange'],
];

/** One-tap looks for the karaoke text. The first is the stock look. */
const FONT_LABELS: Record<KaraokeFont, string> = { default: 'YouTube', sans: 'Sans-serif', serif: 'Serif', mono: 'Monospace' };
const OUTLINE_LABELS: Record<KaraokeOutline, string> = { none: 'None', thin: 'Thin', normal: 'Normal', thick: 'Thick' };

const FALLBACK_NOTES = {
  lrclib: 'LRCLIB has no lyrics for this video, so the automatic order is used.',
  captions: 'This video has no usable captions, so the automatic order is used.',
} as const;

/** The "Custom Karaoke Text" group: look presets, color, size, font... (www, karaoke mode). */
function karaokeTextGroup(prefs: LyricsPrefs, actions: MenuActions): MenuRow {
  const presets = stylePresets(prefs);
  const matched = matchedStylePreset(prefs);
  const group: MenuRow = {
    id: 'karaokeText',
    label: 'Custom Karaoke Text',
    options: [],
    selected: '',
    rows: [
      {
        id: 'preset',
        label: 'Style preset',
        options: [
          ...presets.map((p) => ({ value: p.id, label: p.label })),
          ...(matched ? [] : [{ value: 'custom', label: 'Custom', disabled: true }]),
          { value: 'reset', label: 'Reset style' },
          { value: 'save', label: prefs.karaokeMyStyle ? 'Replace My style with the current look' : 'Save the current look as My style', disabled: !!matched },
        ],
        selected: matched?.id ?? 'custom',
        select: (v) => {
          if (v === 'reset') {
            actions.setPrefs(RESET_STYLE);
            return;
          }
          if (v === 'save') {
            actions.setPrefs({ karaokeMyStyle: pickStyle(prefs) });
            return;
          }
          const preset = presets.find((p) => p.id === v);
          if (preset) actions.setPrefs(preset.style);
        },
      },
      {
        id: 'color',
        label: 'Color',
        options: [
          ...COLOR_PRESETS.map(([value, label]) => ({ value, label })),
          ...(COLOR_PRESETS.some(([c]) => c === prefs.karaokeColor) ? [] : [{ value: prefs.karaokeColor, label: `Custom (${prefs.karaokeColor})` }]),
        ],
        selected: prefs.karaokeColor,
        picker: 'color',
        select: (v) => actions.setPrefs({ karaokeColor: v }),
      },
      {
        id: 'size',
        label: 'Size',
        options: KARAOKE_SIZES.map((n) => ({ value: String(n), label: `${n}%` })),
        selected: String(nearestSize(prefs.karaokeFontSize)),
        select: (v) => actions.setPrefs({ karaokeFontSize: Number(v) }),
      },
      {
        id: 'font',
        label: 'Font',
        options: Object.entries(FONT_LABELS).map(([value, label]) => ({ value, label })),
        selected: prefs.karaokeFont,
        select: (v) => actions.setPrefs({ karaokeFont: v as KaraokeFont }),
      },
      {
        id: 'outline',
        label: 'Outline',
        options: Object.entries(OUTLINE_LABELS).map(([value, label]) => ({ value, label })),
        selected: prefs.karaokeOutline,
        select: (v) => actions.setPrefs({ karaokeOutline: v as KaraokeOutline }),
      },
      {
        id: 'background',
        label: 'Background',
        options: KARAOKE_BACKGROUNDS.map((n) => ({ value: String(n), label: n ? `${n}%` : 'None' })),
        selected: String(prefs.karaokeBackground),
        select: (v) => actions.setPrefs({ karaokeBackground: Number(v) as KaraokeBackground }),
      },
      {
        id: 'animation',
        label: 'Line transition',
        options: [
          { value: 'none', label: 'None' },
          { value: 'fade', label: 'Fade' },
          { value: 'slide', label: 'Slide up' },
        ],
        selected: prefs.karaokeAnimation,
        note: 'Off when your system asks to reduce motion.',
        select: (v) => actions.setPrefs({ karaokeAnimation: v as KaraokeAnimation }),
      },
      {
        id: 'position',
        label: 'Position',
        options: [
          ...POSITION_PRESETS.map((p) => ({ value: p.id, label: p.label })),
          ...(matchedPosition(prefs) ? [] : [{ value: 'custom', label: 'Custom (dragged)', disabled: true }]),
        ],
        selected: matchedPosition(prefs)?.id ?? 'custom',
        note: 'Drag the text to place it anywhere, or right-click it for these presets.',
        select: (v) => {
          const preset = POSITION_PRESETS.find((p) => p.id === v);
          if (preset) actions.setPrefs({ karaokePosition: { x: 0.5, y: preset.y } });
        },
      },
      {
        id: 'focus',
        label: 'Lyrics-only view',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ],
        selected: prefs.karaokeFocus ? 'on' : 'off',
        note: 'Large text in the middle over a dimmed, blurred video.',
        select: (v) => actions.setPrefs({ karaokeFocus: v === 'on' }),
      },
    ],
    select: () => {},
  };
  group.summary = group.rows!.slice(1, 3).map(selectedLabel).join(' · ');
  return group;
}

/**
 * Builds the rows to show. YT Music: a flat list (source, caption language, timing, then the actions). www: two
 * sections, "Lyrics source" (source, caption language, find / use my own, "Source options" with timing and the export
 * actions) and "Lyrics display" (display mode, and in karaoke mode its lines, text look and reset position). Nothing
 * that has no content is listed: no source row before lyrics load, caption language only with two or more tracks.
 */
export function buildMenuRows(input: MenuInput, actions: MenuActions): MenuRow[] {
  const { sources, captions, prefs } = input;
  const ytm = input.site === 'ytmusic';
  const source: MenuRow[] = [];
  if (sources) {
    const entries: [SourcePref, string, boolean, string][] = [
      ['auto', sources.shown ? `Auto (${SHOWN_LABELS[sources.shown]})` : 'Auto', true, ''],
      ['lrclib', 'LRCLIB', sources.available.lrclib, ' (not found)'],
      ['captions', 'YouTube captions', sources.available.captions, ' (none)'],
    ];
    const options: MenuOption[] = entries.map(([value, label, ok, hint]) => ({ value, label: ok ? label : label + hint, disabled: !ok }));
    // www: finding or pasting other lyrics sits among the sources, before the YouTube captions.
    if (!ytm && input.canEdit) {
      options.splice(2, 0, { value: 'findLyrics', label: 'Find other lyrics…', run: () => actions.findLyrics() }, { value: 'myLyrics', label: 'Use my own lyrics…', run: () => actions.myLyrics() });
    }
    source.push({
      id: 'source',
      label: ytm ? 'Lyrics source' : 'Source',
      options,
      selected: sources.pref,
      ...(sources.fellBack ? { note: FALLBACK_NOTES[sources.fellBack] } : {}),
      select: (v) => actions.selectSource(v as SourcePref),
    });
  }
  if (captions && captions.options.length >= 2) {
    source.push({
      id: 'captionLanguage',
      label: 'Caption language',
      options: captions.options.map((o) => ({ value: String(o.index), label: o.label })),
      selected: String(captions.selected.index),
      select: (v) => actions.selectCaptionTrack({ index: Number(v) }),
    });
  }
  const timing: MenuRow[] = [];
  if (input.timing) {
    timing.push({
      id: 'timing',
      label: 'Lyrics timing',
      // A value from the timing keys can sit between the steps: list it too.
      options: [...new Set<number>([...TIMING_STEPS_MS, input.timing.offsetMs])].sort((a, b) => a - b).map((ms) => ({ value: String(ms), label: timingLabel(ms) })),
      selected: String(input.timing.offsetMs),
      note: '+ shows the lyrics later, - earlier. Kept for this video.',
      select: (v) => actions.setOffset(Number(v)),
    });
    timing.push({
      id: 'timingKeys',
      label: 'Timing keys',
      options: [
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ],
      selected: prefs.lyricsTimingKeys ? 'on' : 'off',
      note: 'Press ] to show the lyrics 0.1 s later and [ for earlier.',
      select: (v) => actions.setPrefs({ lyricsTimingKeys: v === 'on' }),
    });
  }
  const exportActions: MenuRow[] = [];
  if (input.lyrics) exportActions.push(action('copyLyrics', 'Copy lyrics', () => actions.copyLyrics()));
  if (input.lyrics?.synced) exportActions.push(action('saveLrc', 'Save as .lrc', () => actions.saveLrc()));
  const edit: MenuRow[] = input.canEdit && (ytm || !sources)
    ? [action('findLyrics', 'Find other lyrics…', () => actions.findLyrics()), action('myLyrics', 'Use my own lyrics…', () => actions.myLyrics())]
    : [];

  if (ytm) return [...source, ...timing, ...exportActions, ...edit];

  const sourceOptions: MenuRow[] = [...timing];
  if (exportActions.length) sourceOptions.push({ id: 'exportLyrics', label: 'Export lyrics', options: [], selected: '', rows: exportActions, select: () => {} });
  const sourceSection: MenuRow[] = [...source, ...edit]; // edit: only when there is no source row to hold them
  if (sourceOptions.length) {
    sourceSection.push({ id: 'sourceOptions', label: 'Source options', options: [], selected: '', rows: sourceOptions, summary: timing[0] ? selectedLabel(timing[0]) : '', select: () => {} });
  }
  const karaoke = prefs.lyricsDisplayMode === 'karaoke';
  const display: MenuRow = {
    id: 'display',
    label: 'Display',
    options: [
      { value: 'karaoke', label: 'Karaoke text' },
      { value: 'window', label: 'Lyrics window' },
    ],
    selected: prefs.lyricsDisplayMode,
    select: (v) => actions.setPrefs({ lyricsDisplayMode: v as LyricsDisplayMode }),
  };
  const displaySection: MenuRow[] = [display];
  if (karaoke) {
    displaySection.push(
      {
        id: 'lines',
        label: 'Karaoke lines',
        options: [
          { value: '1', label: '1' },
          { value: '2', label: '2' },
        ],
        selected: String(prefs.karaokeLines),
        select: (v) => actions.setPrefs({ karaokeLines: v === '1' ? 1 : 2 }),
      },
      karaokeTextGroup(prefs, actions),
      action('resetPosition', 'Reset position', () => actions.setPrefs({ karaokePosition: { ...DEFAULT_LYRICS_PREFS.karaokePosition } })),
    );
  }
  const rows: MenuRow[] = [];
  if (sourceSection.length) {
    rows.push({ id: 'sourceSection', label: 'Lyrics source', options: [], selected: '', rows: sourceSection, summary: source[0] ? selectedLabel(source[0]) : '', select: () => {} });
  }
  rows.push({ id: 'displaySection', label: 'Lyrics display', options: [], selected: '', rows: displaySection, summary: selectedLabel(display), select: () => {} });
  return rows;
}

const selectedLabel = (row: MenuRow): string =>
  row.rows ? (row.summary ?? row.rows.map(selectedLabel).filter(Boolean).join(' · ')) : (row.options.find((o) => o.value === row.selected)?.label ?? '');

/** Shows `message` in place of the button's text for a moment (no-op without one). */
function flash(el: HTMLElement, message: string | void): void {
  if (!message) return;
  const text = el.textContent;
  el.textContent = message;
  setTimeout(() => {
    el.textContent = text;
  }, 1500);
}

/** Both renderers take the new settings whenever the state or prefs change. */
export interface LyricsMenu {
  setRows(rows: MenuRow[]): void;
}

/** Slide time of YouTube's own submenu change (`.ytp-popup-animating .ytp-panel`: 0.25 s). */
const PANEL_ANIM_MS = 250;
type PanelDir = 'forward' | 'back';
const OWN_ATTR = 'data-am-panel';
const ROW_ATTR = 'data-am-row';
const GROUP_ID = 'lyrics';
const GROUP_LABEL = 'Lyrics';
/** Same glyph as the ♪ button on the control bar. */
const GROUP_ICON = '♪';

const rowKey = (row: MenuRow): string =>
  JSON.stringify([row.id, row.label, row.selected, row.options.map((o) => [o.value, o.label, !!o.disabled]), row.note, row.rows?.map(rowKey)]);

/**
 * www: one "Lyrics" row (with the ♪ icon) at the end of YouTube's settings panel. It opens our own panel with
 * the lyrics sections, each section opens its settings, and each setting opens its choices, like Playback speed.
 * YouTube re-renders the popup, so `ensure()` re-inserts what vanished (never duplicates).
 */
export class YtSettingsMenu implements LyricsMenu {
  private rows: MenuRow[] = [];
  /** Ends a running slide at once (a new navigation, or a rebuild, must not wait for it). */
  private finishAnim: () => void = () => undefined;
  /** Open panels: [] closed, [GROUP_ID] the lyrics sections, [GROUP_ID, rowId, ...] a section, a setting of it (a group's settings, or the choices)... */
  private path: string[] = [];
  private subKey = '';
  private sub: HTMLElement | null = null;
  private hidden: HTMLElement | null = null;
  private saved: { width: string; height: string } | null = null;
  private observer: MutationObserver | null = null;
  private observed: Element | null = null;
  private raf = 0;

  constructor(private readonly doc: Document = document) {}

  setRows(rows: MenuRow[]): void {
    this.rows = rows;
    if (this.path.length > 1 && !this.rowAt(this.path)) this.path = [GROUP_ID];
    this.ensure();
  }

  /** Watches `player` (not the whole document) for the popup being re-created. */
  observe(player: Element): void {
    if (this.observed === player) return;
    this.observer?.disconnect();
    this.observed = player;
    const MO = this.doc.defaultView?.MutationObserver ?? MutationObserver;
    this.observer = new MO(() => this.schedule());
    this.observer.observe(player, { childList: true, subtree: true });
    this.ensure();
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.observed = null;
    this.closeSub();
    for (const el of this.doc.querySelectorAll(`[${ROW_ATTR}]`)) el.remove();
  }

  private schedule(): void {
    if (this.raf) return;
    const win = this.doc.defaultView;
    const run = () => {
      this.raf = 0;
      this.ensure();
    };
    this.raf = win?.requestAnimationFrame ? win.requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number);
  }

  /** What the group row shows on its right: the current display mode. */
  private summary(): string {
    const display = this.rows.find((r) => r.id === 'displaySection')?.rows?.find((r) => r.id === 'display');
    return display ? selectedLabel(display) : '';
  }

  private groupKey(): string {
    return JSON.stringify(this.rows.map(rowKey));
  }

  /** Make the popup show our group row exactly once, at the end of the main menu. */
  ensure(): void {
    const popup = findSettingsPopup(this.doc);
    if (!popup) return;
    if (this.path.length && (this.sub?.parentNode !== popup || popup.style.display === 'none')) this.closeSub();
    const menu = findSettingsMainMenu(popup, OWN_ATTR);
    if (!menu) return;
    const mine = [...menu.querySelectorAll<HTMLElement>(`[${ROW_ATTR}]`)];
    const want = this.rows.length > 0;
    const ok = want
      ? mine.length === 1 &&
        menu.lastElementChild === mine[0] &&
        mine[0].parentNode === menu &&
        mine[0].querySelector(SETTINGS_SELECTORS.menuItemContent)?.textContent === this.summary()
      : mine.length === 0;
    if (!ok) {
      for (const el of this.doc.querySelectorAll(`[${ROW_ATTR}]`)) el.remove();
      if (want) menu.append(this.renderGroupRow());
    }
    if (this.path.length) {
      if (!want) this.closeSub();
      else if (!this.sub || this.sub.parentNode !== popup || this.panelKey() !== this.subKey) this.renderSub(popup);
    }
  }

  /** The setting an open path points at (undefined: the top panel, or a setting that is gone). */
  private rowAt(path: string[]): MenuRow | undefined {
    let rows = this.rows;
    let row: MenuRow | undefined;
    for (const id of path.slice(1)) {
      row = rows.find((r) => r.id === id);
      if (!row) return undefined;
      rows = row.rows ?? [];
    }
    return row;
  }

  private panelKey(): string {
    const row = this.rowAt(this.path);
    return JSON.stringify([this.path, row ? rowKey(row) : this.groupKey()]);
  }

  private renderGroupRow(): HTMLElement {
    const item = this.doc.createElement('div');
    item.className = SETTINGS_SELECTORS.menuItem.slice(1);
    item.setAttribute('role', 'menuitem');
    item.setAttribute('aria-haspopup', 'true');
    item.tabIndex = 0;
    item.setAttribute(ROW_ATTR, GROUP_ID);
    const icon = this.doc.createElement('div');
    icon.className = 'ytp-menuitem-icon';
    icon.textContent = GROUP_ICON;
    icon.style.cssText = 'font-size:20px;line-height:24px;text-align:center;';
    const label = this.doc.createElement('div');
    label.className = SETTINGS_SELECTORS.menuItemLabel.slice(1);
    label.textContent = GROUP_LABEL;
    const content = this.doc.createElement('div');
    content.className = SETTINGS_SELECTORS.menuItemContent.slice(1);
    content.textContent = this.summary();
    item.append(icon, label, content);
    this.activate(item, () => this.open([GROUP_ID]));
    return item;
  }

  private activate(el: HTMLElement, fn: () => void): void {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
  }

  private open(path: string[]): void {
    const popup = findSettingsPopup(this.doc);
    if (!popup) return;
    const dir = this.motion() ? (path.length >= this.path.length ? 'forward' : 'back') : undefined;
    this.path = path;
    this.renderSub(popup, dir);
  }

  /** Slide between panels unless the system asks for reduced motion. */
  private motion(): boolean {
    return !this.doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  private back(): void {
    if (this.path.length > 1) this.open(this.path.slice(0, -1));
    else this.closeSub(this.motion());
  }

  private item(role: string, labelText: string): { item: HTMLElement; label: HTMLElement; content: HTMLElement } {
    const item = this.doc.createElement('div');
    item.className = SETTINGS_SELECTORS.menuItem.slice(1);
    item.setAttribute('role', role);
    const label = this.doc.createElement('div');
    label.className = SETTINGS_SELECTORS.menuItemLabel.slice(1);
    label.textContent = labelText;
    // Every row gets the value column, empty when it has no value: that is what makes YouTube lay a row out (and
    // take clicks) across its whole width, as for its own rows.
    const content = this.doc.createElement('div');
    content.className = SETTINGS_SELECTORS.menuItemContent.slice(1);
    // Rows that open something or run an action carry an (empty) icon cell, like YouTube's own subtitle options; it
    // gives the label its left gap. Radio rows keep their own check gap.
    if (role !== 'menuitemradio') {
      const icon = this.doc.createElement('div');
      icon.className = 'ytp-menuitem-icon';
      item.append(icon);
    }
    item.style.cssText = 'width:100%;box-sizing:border-box;cursor:pointer;';
    item.append(label, content);
    return { item, label, content };
  }

  private renderSub(popup: HTMLElement, dir?: PanelDir): void {
    const row = this.rowAt(this.path);
    if (!this.path.length || (this.path.length > 1 && !row)) {
      this.closeSub();
      return;
    }
    this.finishAnim();
    const main = findSettingsMainMenu(popup, OWN_ATTR)?.closest<HTMLElement>(SETTINGS_SELECTORS.panel) ?? null;
    // Going into the first submenu, the main panel stays visible while it slides out.
    const leaving = this.sub ?? (dir && main && main !== this.hidden ? main : null);
    const before = { w: popup.offsetWidth, h: popup.offsetHeight };
    if (main && main !== this.hidden) {
      this.hidden = main;
      if (!(dir && leaving === main)) main.style.display = 'none';
    }
    if (!this.saved) this.saved = { width: popup.style.width, height: popup.style.height };
    const panel = this.doc.createElement('div');
    panel.className = SETTINGS_SELECTORS.panel.slice(1);
    panel.setAttribute(OWN_ATTR, '');
    const header = this.doc.createElement('div');
    header.className = SETTINGS_SELECTORS.panelHeader.slice(1);
    // Same markup as YouTube's own submenu header: the button sits in a 48 px container, which gives its left gap.
    const backBox = this.doc.createElement('div');
    backBox.className = 'ytp-panel-back-button-container';
    const back = this.doc.createElement('button');
    back.type = 'button';
    back.className = `ytp-button ${SETTINGS_SELECTORS.backButton.slice(1)}`;
    back.setAttribute('aria-label', 'Back');
    back.addEventListener('click', (e) => {
      e.stopPropagation();
      this.back();
    });
    const title = this.doc.createElement('span');
    title.className = 'ytp-panel-title';
    title.textContent = row ? row.label : GROUP_LABEL;
    backBox.append(back);
    header.append(backBox, title);
    const menu = this.doc.createElement('div');
    menu.className = SETTINGS_SELECTORS.panelMenu.slice(1);
    if (row?.rows) this.fillRows(menu, row.rows);
    else if (row) this.fillChoices(menu, row);
    else this.fillRows(menu, this.rows);
    panel.append(header, menu);
    this.subKey = this.panelKey();
    if (!(dir && leaving === this.sub)) this.sub?.remove();
    this.sub = panel;
    popup.append(panel);
    // A long list (the karaoke text settings) must scroll inside the player, not run off its top. The panel menu is
    // `display:table` on YouTube, which ignores overflow, so a block wrapper scrolls it. `important`: YouTube's own
    // rules would win otherwise.
    const room = this.roomAbove(popup);
    if (room > 0) {
      const scroller = this.doc.createElement('div');
      scroller.style.setProperty('overflow-y', 'auto', 'important');
      scroller.style.setProperty('max-height', `${Math.max(80, room - header.offsetHeight)}px`, 'important');
      menu.style.width = '100%';
      menu.replaceWith(scroller);
      scroller.append(menu);
    }
    // Native submenus size the popup to their panel: measure the panel at its natural width, free of the previous
    // panel's size (a long note wraps at the player's width, at most 460 px).
    popup.style.width = '';
    popup.style.height = '';
    panel.style.cssText = `width:max-content;min-width:250px;max-width:${this.maxPanelWidth(popup)}px;`;
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    panel.style.cssText = '';
    if (w > 0 && h > 0) this.resize(popup, before, { w, h }, !!(dir && leaving));
    if (dir && leaving) this.slide(popup, panel, leaving, dir, () => (leaving === main ? (leaving.style.display = 'none') : leaving.remove()));
  }

  /**
   * Same classes as YouTube's own submenus, which are start/end states of a CSS transition: the new panel starts at
   * the class's side and the class is dropped so it slides to rest; the old panel gets the opposite class and slides out.
   */
  private slide(popup: HTMLElement, entering: HTMLElement, leaving: HTMLElement, dir: PanelDir, done: () => void): void {
    const inCls = dir === 'forward' ? 'ytp-panel-animate-forward' : 'ytp-panel-animate-back';
    const outCls = dir === 'forward' ? 'ytp-panel-animate-back' : 'ytp-panel-animate-forward';
    // The start state goes on while the panels still have no transition (YouTube's `.ytp-popup-animating` rule gives
    // them one), or it would be reached by a transition instead of being the starting point.
    entering.classList.add(inCls);
    void this.doc.defaultView?.getComputedStyle(entering).transform; // commit it
    popup.classList.add('ytp-popup-animating');
    const win = this.doc.defaultView;
    if (win) win.requestAnimationFrame(() => entering.classList.remove(inCls));
    else entering.classList.remove(inCls);
    leaving.classList.add(outCls);
    const finish = () => {
      clearTimeout(timer);
      this.finishAnim = () => undefined;
      leaving.classList.remove(outCls);
      popup.style.transition = '';
      popup.classList.remove('ytp-popup-animating');
      done();
    };
    const timer = setTimeout(finish, PANEL_ANIM_MS + 50);
    this.finishAnim = finish;
  }

  /** Grow or shrink the popup to the new panel (animated while sliding, as YouTube does). */
  private resize(popup: HTMLElement, from: { w: number; h: number }, to: { w: number; h: number }, animate: boolean): void {
    if (animate && from.w > 0 && from.h > 0) {
      popup.style.width = `${from.w}px`;
      popup.style.height = `${from.h}px`;
      void popup.offsetWidth; // commit the start size so the change below transitions
      popup.style.transition = `opacity .1s cubic-bezier(0,0,.2,1), width ${PANEL_ANIM_MS}ms cubic-bezier(.4,0,.2,1), height ${PANEL_ANIM_MS}ms cubic-bezier(.4,0,.2,1)`;
    }
    popup.style.width = `${to.w}px`;
    popup.style.height = `${to.h}px`;
  }

  /** Widest the panel may be: wide enough for a label and a long value side by side, within the player. */
  private maxPanelWidth(popup: HTMLElement): number {
    const player = popup.closest<HTMLElement>('.html5-video-player');
    const room = player ? player.getBoundingClientRect().width - 24 : 0;
    return room > 250 ? Math.min(460, room) : 460;
  }

  /** Height the settings popup may have: from the bottom of its anchor up to the player's top (0: unknown). */
  private roomAbove(popup: HTMLElement): number {
    const player = popup.closest<HTMLElement>('.html5-video-player');
    if (!player) return 0;
    const p = player.getBoundingClientRect();
    const below = p.bottom - popup.getBoundingClientRect().bottom;
    let room = p.height - Math.max(0, below) - 12;
    const own = parseFloat(this.doc.defaultView?.getComputedStyle(popup).maxHeight ?? '');
    if (own > 0) room = Math.min(room, own);
    return room > 0 ? room : 0;
  }

  /** One row per setting (opens its choices or, for a group, its settings); an action row runs and shows its confirmation. */
  private fillRows(menu: HTMLElement, rows: MenuRow[]): void {
    for (const row of rows) {
      const { item, label, content } = this.item('menuitem', row.label);
      item.tabIndex = 0;
      if (row.run) {
        const run = row.run.bind(row);
        item.setAttribute(ROW_ATTR + '-button', row.id);
        this.activate(item, () => flash(label, run()));
      } else {
        item.setAttribute('aria-haspopup', 'true');
        item.setAttribute(ROW_ATTR + '-setting', row.id);
        content.textContent = selectedLabel(row);
        this.activate(item, () => this.open([...this.path, row.id]));
      }
      menu.append(item);
    }
  }

  private fillChoices(menu: HTMLElement, row: MenuRow): void {
    for (const o of row.options) {
      if (o.run) {
        const run = o.run.bind(o);
        const { item, label } = this.item('menuitem', o.label);
        item.querySelector('.ytp-menuitem-icon')?.remove();
        label.style.paddingLeft = '35px'; // in line with the choices' labels
        item.setAttribute(ROW_ATTR + '-button', o.value);
        item.tabIndex = 0;
        this.activate(item, () => flash(label, run()));
        menu.append(item);
        continue;
      }
      const { item, label } = this.item('menuitemradio', o.label);
      item.setAttribute('aria-checked', String(o.value === row.selected));
      if (o.disabled) {
        item.setAttribute('aria-disabled', 'true');
        item.style.cursor = 'default';
        label.style.opacity = '0.5';
      }
      item.tabIndex = o.disabled ? -1 : 0;
      this.activate(item, () => {
        if (o.disabled) return;
        // Back to the parent panel, so several can be changed in one visit.
        this.open(this.path.slice(0, -1));
        row.select(o.value);
      });
      menu.append(item);
    }
    if (row.picker) {
      const { item, content } = this.item('menuitem', 'Pick a color');
      const input = this.doc.createElement('input');
      input.type = 'color';
      input.value = row.selected;
      input.style.cssText = 'margin-left:auto;width:36px;height:24px;padding:0;border:0;background:none;cursor:pointer;';
      // `change` (picker closed), not `input`: a pick re-renders this panel and would drop the open picker.
      input.addEventListener('change', () => row.select(input.value));
      input.addEventListener('click', (e) => e.stopPropagation());
      content.append(input);
      menu.append(item);
    }
    if (row.note) {
      const note = this.doc.createElement('div');
      note.className = 'ytp-menuitem-label';
      note.style.cssText = 'padding:8px 20px 8px 35px;opacity:0.7;font-size:90%;white-space:normal;';
      note.textContent = row.note;
      menu.append(note);
    }
  }

  /** Leave the submenus; `animate` slides the main panel back in (a click on Back, not a rebuild). */
  private closeSub(animate = false): void {
    this.finishAnim();
    const popup = findSettingsPopup(this.doc);
    const leaving = this.sub;
    const main = this.hidden;
    const before = popup ? { w: popup.offsetWidth, h: popup.offsetHeight } : { w: 0, h: 0 };
    this.path = [];
    this.subKey = '';
    this.sub = null;
    this.hidden = null;
    if (main) main.style.display = '';
    const saved = this.saved;
    this.saved = null;
    if (popup && saved) {
      if (animate && main && leaving) {
        popup.style.width = '';
        popup.style.height = '';
        const to = { w: parseFloat(saved.width) || main.offsetWidth, h: parseFloat(saved.height) || main.offsetHeight };
        this.resize(popup, before, to, true);
        this.slide(popup, main, leaving, 'back', () => {
          leaving.remove();
          popup.style.width = saved.width;
          popup.style.height = saved.height;
        });
      } else {
        leaving?.remove();
        popup.style.width = saved.width;
        popup.style.height = saved.height;
      }
    } else leaving?.remove();
    // Rows may have changed while the submenu was open.
    if (popup) this.ensure();
  }
}

/** YT Music: a ⚙ button next to ♪ opening a popover with the same rows as plain selects. */
export class YtmSettingsPopover implements LyricsMenu {
  readonly button: HTMLButtonElement;
  private readonly pop: HTMLElement;
  private rows: MenuRow[] = [];

  constructor(private readonly doc: Document = document) {
    this.button = doc.createElement('button');
    this.button.type = 'button';
    this.button.setAttribute('data-allmixer-lyrics-settings', '');
    this.button.title = 'Lyrics settings (All Mixer!)';
    this.button.setAttribute('aria-label', 'Lyrics settings');
    this.button.setAttribute('aria-haspopup', 'true');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.textContent = '⚙';
    this.button.style.cssText = 'background:none;border:0;color:inherit;font-size:18px;cursor:pointer;padding:0 8px;';
    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.isOpen) this.close();
      else this.open();
    });
    this.pop = doc.createElement('div');
    this.pop.setAttribute('data-allmixer-lyrics-popover', '');
    this.pop.setAttribute('role', 'dialog');
    this.pop.setAttribute('aria-label', 'Lyrics settings');
    this.pop.style.cssText =
      'position:fixed;z-index:2147483000;display:none;box-sizing:border-box;min-width:220px;overflow-y:auto;padding:10px 12px;background:#212121;color:#fff;border-radius:8px;font:13px/1.4 Roboto,Arial,sans-serif;box-shadow:0 4px 24px rgba(0,0,0,.6);';
    doc.addEventListener('pointerdown', this.onOutside, true);
    doc.addEventListener('keydown', this.onKey, true);
    this.pop.addEventListener('keydown', (e) => e.stopPropagation());
    this.pop.addEventListener('keyup', (e) => e.stopPropagation());
  }

  get isOpen(): boolean {
    return this.pop.style.display !== 'none';
  }

  setRows(rows: MenuRow[]): void {
    this.rows = rows;
    if (this.isOpen) this.render();
  }

  open(): void {
    this.render();
    if (!this.pop.isConnected) (this.doc.body ?? this.doc.documentElement).append(this.pop);
    this.pop.style.display = 'block';
    this.button.setAttribute('aria-expanded', 'true');
    const r = this.button.getBoundingClientRect();
    this.pop.style.maxHeight = `${Math.max(120, r.top - 16)}px`; // scrolls instead of running off the top
    const h = this.pop.offsetHeight;
    this.pop.style.left = `${Math.max(8, Math.min(r.left, (this.doc.defaultView?.innerWidth ?? 1200) - this.pop.offsetWidth - 8))}px`;
    this.pop.style.top = `${Math.max(8, r.top - h - 8)}px`;
  }

  close(): void {
    this.pop.style.display = 'none';
    this.button.setAttribute('aria-expanded', 'false');
  }

  destroy(): void {
    this.close();
    this.doc.removeEventListener('pointerdown', this.onOutside, true);
    this.doc.removeEventListener('keydown', this.onKey, true);
    this.pop.remove();
    this.button.remove();
  }

  private readonly onOutside = (e: Event): void => {
    if (!this.isOpen) return;
    const t = e.target as Node | null;
    if (t && (this.pop.contains(t) || this.button.contains(t))) return;
    this.close();
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isOpen) {
      e.stopPropagation();
      this.close();
      this.button.focus();
    }
  };

  private render(): void {
    const frag = this.doc.createDocumentFragment();
    // The popover is flat: a group's settings are listed as its own rows, and an action row is a button.
    const flat = (rows: MenuRow[]): MenuRow[] => rows.flatMap((r) => (r.rows ? flat(r.rows) : [r]));
    for (const row of flat(this.rows)) {
      if (row.run) {
        const run = row.run.bind(row);
        const btn = this.doc.createElement('button');
        btn.type = 'button';
        btn.setAttribute(ROW_ATTR, row.id);
        btn.textContent = row.label;
        btn.style.cssText = 'font:inherit;color:#fff;background:#333;border:1px solid rgba(255,255,255,.3);border-radius:4px;padding:4px 10px;margin:6px 0;cursor:pointer;width:100%;';
        btn.addEventListener('click', () => {
          flash(btn, run());
          btn.blur();
        });
        frag.append(btn);
        continue;
      }
      const wrap = this.doc.createElement('label');
      wrap.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:12px;margin:6px 0;';
      wrap.setAttribute(ROW_ATTR, row.id);
      const text = this.doc.createElement('span');
      text.textContent = row.label;
      const sel = this.doc.createElement('select');
      sel.style.cssText = 'font:inherit;color:#fff;background:#333;border:1px solid rgba(255,255,255,.3);border-radius:4px;';
      for (const o of row.options.filter((o) => !o.run)) {
        const opt = this.doc.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        opt.disabled = !!o.disabled;
        sel.append(opt);
      }
      sel.value = row.selected;
      sel.addEventListener('change', () => {
        row.select(sel.value);
        // Hand focus back to the page so later keys reach YouTube, not the select.
        sel.blur();
      });
      wrap.append(text, sel);
      frag.append(wrap);
      if (row.note) {
        const note = this.doc.createElement('div');
        note.style.cssText = 'opacity:.7;font-size:12px;max-width:260px;';
        note.textContent = row.note;
        frag.append(note);
      }
    }
    this.pop.replaceChildren(frag);
  }
}
