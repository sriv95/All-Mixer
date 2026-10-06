export type LyricsDisplayMode = 'karaoke' | 'window';

export interface LyricsPrefs {
  lyricsDisplayMode: LyricsDisplayMode;
  karaokeLines: 1 | 2;
  /** Percent of the base size, integer 50-200. */
  karaokeFontSize: number;
  /** Fractions 0..1 of the player width/height: x = horizontal center, y = vertical center of the text block. */
  karaokePosition: { x: number; y: number };
}

export const LYRICS_PREFS_KEY = 'lyricsPrefs';

export const DEFAULT_LYRICS_PREFS: LyricsPrefs = {
  lyricsDisplayMode: 'karaoke',
  karaokeLines: 2,
  karaokeFontSize: 100,
  karaokePosition: { x: 0.5, y: 0.82 },
};

const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** Any bad or missing field falls back to its default. */
export function normalizeLyricsPrefs(raw: unknown): LyricsPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pos = (r.karaokePosition && typeof r.karaokePosition === 'object' ? r.karaokePosition : {}) as Record<string, unknown>;
  const d = DEFAULT_LYRICS_PREFS;
  return {
    lyricsDisplayMode: r.lyricsDisplayMode === 'karaoke' || r.lyricsDisplayMode === 'window' ? r.lyricsDisplayMode : d.lyricsDisplayMode,
    karaokeLines: r.karaokeLines === 1 || r.karaokeLines === 2 ? r.karaokeLines : d.karaokeLines,
    karaokeFontSize: Math.round(num(r.karaokeFontSize, d.karaokeFontSize, 50, 200)),
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
