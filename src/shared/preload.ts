import { EXPORT_SAMPLE_RATE, stemsOf, type ExportProgress } from './export';
import type { MixerSettings } from './settings';

// Preload Audio: the whole video is separated up front and plays from memory (docs/preload-audio.md). Shared by the popup and the tab.

/** Stems are Float32 stereo in memory: above this the start is refused (a 4 min video with 2 stems is 170 MB). */
export const PRELOAD_MAX_BYTES = 900e6;

type ModelAudio = Pick<MixerSettings, 'mlModel' | 'splitInstrumental' | 'splitGuitar'>;

/** Memory of the cache: every stem is a stereo Float32 buffer of the video's length. */
export const preloadBytes = (a: ModelAudio, durationS: number): number => stemsOf(a).length * Math.ceil(durationS * EXPORT_SAMPLE_RATE) * 2 * 4;

/** What a cache was made with: a change of model or split switches means it holds other stems than the sliders control. */
export const preloadSignature = (a: ModelAudio): string => `${a.mlModel}:${stemsOf(a).join(',')}`;

export interface PreloadStatus {
  /** idle = no cache for this video; loading = being made (see `progress`); ready = in memory; error / cancelled = the last attempt. */
  state: 'idle' | 'loading' | 'ready' | 'error' | 'cancelled';
  progress?: ExportProgress;
  /** ready: made with a model or split switches other than the current ones. */
  stale?: boolean;
  /** ready but not what plays right now (an ad, a playback speed other than 1×); the original audio plays meanwhile. */
  holding?: string;
  /** ready: memory of the cache. */
  bytes?: number;
  /** ready: the cache is what sounds right now (QA / tests), the peak of its output (0–1) and its offset from the picture in ms. */
  playing?: { level: number; driftMs: number | null };
}
