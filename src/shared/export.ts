import { normalizeLyricsPrefs, type KaraokeStyle, type LyricsPrefs } from './lyrics-prefs';
import { DEFAULT_SETTINGS, normalizeSettings, separationFor, type MixerSettings } from './settings';

// Options and progress of the Export section Shared by the popup, the content script and the export engine.

export type ExportFormat = 'mp3' | 'mp4';
/** Single track = one mixed file. Separate tracks = the mix plus one track per stem (a zip of MP3 files, or one MP4 with several audio streams). */
export type ExportTracks = 'single' | 'separate';

/** Longest piece of audio the export handles in one go (recording, separation, mixing, encoding). */
export const MAX_CHUNK_S = 15;
/** Output sample rate: the rate of the models, so no resampler is needed after the separation. */
export const EXPORT_SAMPLE_RATE = 44100;
/** Output heights of the MP4 (the picture is never scaled up past the source). */
export const EXPORT_HEIGHTS = [360, 480, 720, 1080] as const;
export const DEFAULT_EXPORT_HEIGHT = 720;
/** The popup warns above this length: the file is built in memory. */
export const LONG_EXPORT_S = 20 * 60;

/** The look and place of the karaoke text in the MP4 (what the overlay's style presets set, plus the rows and the place). */
export type ExportText = KaraokeStyle & Pick<LyricsPrefs, 'karaokeLines' | 'karaokePosition'>;

export interface ExportOptions {
  format: ExportFormat;
  tracks: ExportTracks;
  /** Export-local copy of the mix: model, split switches and levels. Pitch, mode and delay are not part of an export. */
  audio: MixerSettings;
  text: ExportText;
  /** MP4 picture height. */
  height: number;
}

export type Part = 'drums' | 'guitar' | 'bass' | 'piano';
export type Stem = 'vocals' | 'instrumental' | Part | 'others';
export type TrackId = 'mix' | Stem;

export const TRACK_LABEL: Record<TrackId, string> = {
  mix: 'Mix',
  vocals: 'Vocals',
  instrumental: 'Instrumental',
  drums: 'Drums',
  guitar: 'Guitar',
  bass: 'Bass',
  piano: 'Piano',
  others: 'Others',
};

/** The parts of the instrumental the model takes out: all four with the all-stems model, else the split switches. */
export function partsOf(a: Pick<MixerSettings, 'mlModel' | 'splitInstrumental' | 'splitGuitar'>): Part[] {
  if (a.mlModel === 'sw') return ['drums', 'guitar', 'bass', 'piano'];
  return [...(a.splitInstrumental ? (['drums'] as const) : []), ...(a.splitGuitar ? (['guitar'] as const) : [])];
}

/** The stems of the Separate tracks mode: vocals, then each part, then the rest of the instrumental. */
export function stemsOf(a: Pick<MixerSettings, 'mlModel' | 'splitInstrumental' | 'splitGuitar'>): Stem[] {
  const parts = partsOf(a);
  return parts.length ? ['vocals', ...parts, 'others'] : ['vocals', 'instrumental'];
}

/** The tracks the export writes, the mix first. */
export function tracksOf(o: Pick<ExportOptions, 'tracks' | 'audio'>): TrackId[] {
  return o.tracks === 'separate' ? ['mix', ...stemsOf(o.audio)] : ['mix'];
}

/**
 * Whether the export needs the model: for the stems, or because a level moves the mix away from the original.
 * A plain recording (all levels at 100 %) is made without the GPU.
 */
export function needsSeparation(o: Pick<ExportOptions, 'tracks' | 'audio'>): boolean {
  if (o.tracks === 'separate') return true;
  const g = separationFor({ ...o.audio, mode: 'separate', pitchSplit: false });
  return [g.vocal, g.instrumental, g.drums, g.guitar, g.bass, g.piano, g.others].some((v) => v !== 1);
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** The look of the text as the live karaoke text has it now. */
export function textFromPrefs(p: LyricsPrefs): ExportText {
  return {
    karaokeColor: p.karaokeColor,
    karaokeFontSize: p.karaokeFontSize,
    karaokeFont: p.karaokeFont,
    karaokeOutline: p.karaokeOutline,
    karaokeBackground: p.karaokeBackground,
    karaokeLines: p.karaokeLines,
    karaokePosition: p.karaokePosition,
  };
}

/** The export options that start from the live settings and the live text look. */
export function defaultExportOptions(settings: MixerSettings, prefs: LyricsPrefs, format: ExportFormat = 'mp3'): ExportOptions {
  return { format, tracks: 'single', audio: { ...settings }, text: textFromPrefs(prefs), height: DEFAULT_EXPORT_HEIGHT };
}

/** Any value from a message becomes a valid set of options. */
export function normalizeExportOptions(raw: unknown): ExportOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = (r.text && typeof r.text === 'object' ? r.text : {}) as Record<string, unknown>;
  const height = num(r.height, DEFAULT_EXPORT_HEIGHT);
  return {
    format: r.format === 'mp4' ? 'mp4' : 'mp3',
    tracks: r.tracks === 'separate' ? 'separate' : 'single',
    audio: normalizeSettings(r.audio ?? DEFAULT_SETTINGS),
    text: textFromPrefs(normalizeLyricsPrefs(text)),
    height: EXPORT_HEIGHTS.reduce((best, h) => (Math.abs(h - height) < Math.abs(best - height) ? h : best)),
  };
}

export type ExportStage = 'preparing' | 'model' | 'fetching' | 'recording' | 'finishing';

/** What the popup shows: a bar, and a small line under it. */
export interface ExportProgress {
  state: 'running' | 'done' | 'error' | 'cancelled';
  stage: ExportStage;
  /** Chunk being recorded / processed (1-based) of `chunks`. */
  chunk: number;
  chunks: number;
  /** 0–100. */
  percent: number;
  /** Small text under the bar. */
  detail: string;
  /** The saved file (state 'done'). */
  file?: { name: string; bytes: number };
  /** Why it stopped (state 'error'). */
  error?: string;
}

/** m:ss (h:mm:ss from an hour). */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A file name from a video title: no path or reserved characters, not too long. */
export function safeFileName(title: string, fallback = 'all-mixer'): string {
  // Control characters count as spaces too: they cannot be in a file name.
  const name = [...title].map((c) => (c < ' ' || '\\/:*?"<>|'.includes(c) ? ' ' : c)).join('').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return name || fallback;
}
