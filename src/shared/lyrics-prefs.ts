export type LyricsDisplayMode = 'karaoke' | 'window';
/** Which lyrics source the user wants. */
export type LyricsSource = 'auto' | 'lrclib' | 'captions';

export const KARAOKE_FONTS = ['default', 'sans', 'serif', 'mono'] as const;
export type KaraokeFont = (typeof KARAOKE_FONTS)[number];
export const KARAOKE_OUTLINES = ['none', 'thin', 'normal', 'thick'] as const;
export type KaraokeOutline = (typeof KARAOKE_OUTLINES)[number];
/** Opacity of the dark box behind the text, percent. */
export const KARAOKE_BACKGROUNDS = [0, 25, 50, 75] as const;
export type KaraokeBackground = (typeof KARAOKE_BACKGROUNDS)[number];

export const KARAOKE_ANIMATIONS = ['none', 'fade', 'slide'] as const;
export type KaraokeAnimation = (typeof KARAOKE_ANIMATIONS)[number];

/** The look of the karaoke text: what a style preset sets. */
export type KaraokeStyle = Pick<LyricsPrefs, 'karaokeColor' | 'karaokeFontSize' | 'karaokeFont' | 'karaokeOutline' | 'karaokeBackground'>;
const STYLE_KEYS = ['karaokeColor', 'karaokeFontSize', 'karaokeFont', 'karaokeOutline', 'karaokeBackground'] as const;

export interface LyricsPrefs {
  /** The ♪ button: show or hide the lyrics (karaoke text or window, whichever the display mode is). */
  lyricsVisible: boolean;
  lyricsDisplayMode: LyricsDisplayMode;
  /** Lyrics source menu pick. */
  lyricsSource: LyricsSource;
  /** Language code of the caption track the user picked last; preferred on later videos. null = none picked. */
  captionLang: string | null;
  karaokeLines: 1 | 2;
  /** Percent of the base size, integer 50-200. */
  karaokeFontSize: number;
  /** Karaoke text color, #rrggbb lowercase. */
  karaokeColor: string;
  karaokeFont: KaraokeFont;
  karaokeOutline: KaraokeOutline;
  karaokeBackground: KaraokeBackground;
  /** How a line that just changed comes in. */
  karaokeAnimation: KaraokeAnimation;
  /** The look the user saved as "My style"; null = none saved. */
  karaokeMyStyle: KaraokeStyle | null;
  /** Lyrics-only view: the text large and centered over a dimmed, blurred video. */
  karaokeFocus: boolean;
  /** Lyrics timing per video id, in ms: positive shows the lyrics later. Zero entries are not kept. */
  lyricsOffsets: Record<string, number>;
  /** `[` and `]` shift the lyrics timing by 0.1 s while synced lyrics are shown. */
  lyricsTimingKeys: boolean;
  /** Fractions 0..1 of the player width/height: x = horizontal center, y = vertical center of the text block. */
  karaokePosition: { x: number; y: number };
}

const LYRICS_PREFS_KEY = 'lyricsPrefs';

export const DEFAULT_LYRICS_PREFS: LyricsPrefs = {
  lyricsVisible: true,
  lyricsDisplayMode: 'karaoke',
  lyricsSource: 'auto',
  captionLang: null,
  karaokeLines: 1,
  karaokeFontSize: 100,
  karaokeColor: '#ffffff',
  karaokeFont: 'default',
  karaokeOutline: 'normal',
  karaokeBackground: 0,
  karaokeAnimation: 'none',
  karaokeMyStyle: null,
  karaokeFocus: false,
  karaokePosition: { x: 0.5, y: 0.82 },
  lyricsOffsets: {},
  lyricsTimingKeys: true,
};

export const MAX_LYRICS_OFFSET_MS = 5000;
/** Oldest entries go first; the offsets live in chrome.storage.local next to the other prefs. */
const MAX_OFFSET_ENTRIES = 200;

const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

function normalizeOffsets(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [id, v] of Object.entries(raw)) {
    const ms = typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(MAX_LYRICS_OFFSET_MS, Math.max(-MAX_LYRICS_OFFSET_MS, v))) : 0;
    if (ms !== 0 && /^[A-Za-z0-9_-]{1,40}$/.test(id)) out[id] = ms;
  }
  return Object.fromEntries(Object.entries(out).slice(-MAX_OFFSET_ENTRIES));
}

/** The style fields of `raw`, each fixed up like the prefs; null when `raw` has none of them. */
function normalizeMyStyle(raw: unknown): KaraokeStyle | null {
  if (!raw || typeof raw !== 'object' || !STYLE_KEYS.some((k) => k in raw)) return null;
  const p = normalizeLyricsPrefs(raw);
  return Object.fromEntries(STYLE_KEYS.map((k) => [k, p[k]])) as KaraokeStyle;
}

/** Any bad or missing field falls back to its default. */
export function normalizeLyricsPrefs(raw: unknown): LyricsPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pos = (r.karaokePosition && typeof r.karaokePosition === 'object' ? r.karaokePosition : {}) as Record<string, unknown>;
  const d = DEFAULT_LYRICS_PREFS;
  return {
    lyricsVisible: typeof r.lyricsVisible === 'boolean' ? r.lyricsVisible : d.lyricsVisible,
    lyricsDisplayMode: r.lyricsDisplayMode === 'karaoke' || r.lyricsDisplayMode === 'window' ? r.lyricsDisplayMode : d.lyricsDisplayMode,
    lyricsSource: r.lyricsSource === 'auto' || r.lyricsSource === 'lrclib' || r.lyricsSource === 'captions' ? r.lyricsSource : d.lyricsSource,
    captionLang: typeof r.captionLang === 'string' && /^[A-Za-z0-9-]{1,35}$/.test(r.captionLang) ? r.captionLang : d.captionLang,
    karaokeLines: r.karaokeLines === 1 || r.karaokeLines === 2 ? r.karaokeLines : d.karaokeLines,
    karaokeFontSize: Math.round(num(r.karaokeFontSize, d.karaokeFontSize, 50, 200)),
    karaokeColor: typeof r.karaokeColor === 'string' && /^#[0-9a-f]{6}$/i.test(r.karaokeColor) ? r.karaokeColor.toLowerCase() : d.karaokeColor,
    karaokeFont: KARAOKE_FONTS.find((f) => f === r.karaokeFont) ?? d.karaokeFont,
    karaokeOutline: KARAOKE_OUTLINES.find((o) => o === r.karaokeOutline) ?? d.karaokeOutline,
    karaokeBackground: KARAOKE_BACKGROUNDS.find((b) => b === r.karaokeBackground) ?? d.karaokeBackground,
    karaokeAnimation: KARAOKE_ANIMATIONS.find((a) => a === r.karaokeAnimation) ?? d.karaokeAnimation,
    karaokeMyStyle: normalizeMyStyle(r.karaokeMyStyle),
    karaokeFocus: typeof r.karaokeFocus === 'boolean' ? r.karaokeFocus : d.karaokeFocus,
    lyricsOffsets: normalizeOffsets(r.lyricsOffsets),
    lyricsTimingKeys: typeof r.lyricsTimingKeys === 'boolean' ? r.lyricsTimingKeys : d.lyricsTimingKeys,
    karaokePosition: { x: num(pos.x, d.karaokePosition.x, 0, 1), y: num(pos.y, d.karaokePosition.y, 0, 1) },
  };
}

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

export async function loadLyricsPrefs(area: Area): Promise<LyricsPrefs> {
  return normalizeLyricsPrefs((await area.get(LYRICS_PREFS_KEY))[LYRICS_PREFS_KEY]);
}

/** Merges `patch` over the stored prefs, normalizes, stores and returns the result. */
export async function saveLyricsPrefs(area: Area, patch: Partial<LyricsPrefs>): Promise<LyricsPrefs> {
  const next = normalizeLyricsPrefs({ ...(await loadLyricsPrefs(area)), ...patch });
  await area.set({ [LYRICS_PREFS_KEY]: next });
  return next;
}

type ChangeEvent = Pick<typeof chrome.storage.onChanged, 'addListener' | 'removeListener'>;

/** Calls `cb` with the new prefs whenever they change in `areaName`. Returns an unsubscribe function. */
export function watchLyricsPrefs(
  onChanged: ChangeEvent,
  cb: (prefs: LyricsPrefs) => void,
  areaName: string = 'local',
): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, name: string): void => {
    if (name !== areaName || !(LYRICS_PREFS_KEY in changes)) return;
    cb(normalizeLyricsPrefs(changes[LYRICS_PREFS_KEY].newValue));
  };
  onChanged.addListener(listener);
  return () => onChanged.removeListener(listener);
}
