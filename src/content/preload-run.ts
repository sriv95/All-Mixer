import { defaultExportOptions, stemsOf, type ExportProgress } from '../shared/export';
import { DEFAULT_LYRICS_PREFS } from '../shared/lyrics-prefs';
import type { ExportAnswer } from '../shared/messages';
import { PRELOAD_MAX_BYTES, preloadBytes, preloadSignature, type PreloadStatus } from '../shared/preload';
import type { MixerSettings } from '../shared/settings';
import { StemCache } from './audio/stem-cache';
import { PreloadPlayer } from './audio/preload-player';
import { pageTap } from './page-tap';
import { findPlayer, isAdShowing, type PageSite } from './youtube-dom';

/** The export engine carries the recording and the model session; the preload shares it (loaded on first use). */
const ENGINE_PATH = 'export/engine.js';

interface Deps {
  site: PageSite;
  video(): HTMLMediaElement | null;
  /** The cache or its progress changed. */
  onChange(): void;
  /** An export records the same video: only one of the two runs. */
  exporting(): boolean;
}

/** One video = one id: `v=` on YouTube and YouTube Music, else the address. */
export const videoKey = (href: string = location.href): string => {
  try {
    return new URL(href).searchParams.get('v') ?? href;
  } catch {
    return href;
  }
};

/**
 * Owns Preload Audio of this tab: records and separates the whole video with the export engine, keeps the stems of the one video
 * in memory (a StemCache) and the last attempt's progress for the popup.
 */
export class PreloadRunner {
  private cache: StemCache | null = null;
  private last: { key: string; progress: ExportProgress; tooBig?: boolean } | null = null;
  private abort: AbortController | null = null;

  constructor(private readonly deps: Deps) {}

  get running(): boolean {
    return this.abort !== null;
  }

  /** The cache of the video that is open now, if there is one. */
  ready(key: string = videoKey()): StemCache | null {
    return this.cache?.key === key ? this.cache : null;
  }

  start(settings: MixerSettings): ExportAnswer {
    const { site } = this.deps;
    const video = this.deps.video();
    if (this.abort) return { ok: false, error: 'Preloading is already running in this tab.' };
    // The popup shows why a start was refused, also when it did not send the start itself (the Advanced switch).
    const refuse = (error: string, tooBig = false): ExportAnswer => {
      this.last = { key: videoKey(), tooBig, progress: { state: 'error', stage: 'preparing', chunk: 0, chunks: 0, percent: 0, detail: 'Preloading did not start.', error } };
      this.deps.onChange();
      return { ok: false, error };
    };
    if (this.deps.exporting()) return refuse('An export is running. Preload when it is done.');
    if (!(video instanceof HTMLVideoElement)) return refuse('There is no video to preload on this page.');
    if (!Number.isFinite(video.duration) || video.duration <= 0) return refuse('This video has no fixed length (a live stream cannot be preloaded).');
    // The model runs in the extension frame the live Separate mode uses, which only YouTube pages host.
    if (site === 'generic') return refuse('Preload Audio works on YouTube pages.');
    const player = findPlayer(site);
    if (player && isAdShowing(player)) return refuse('An ad is playing. Preload when the video itself plays.');
    const bytes = preloadBytes(settings, video.duration);
    if (bytes > PRELOAD_MAX_BYTES) {
      return refuse(`This video is too long to keep in memory with ${stemsOf(settings).length} stems (about ${Math.round(bytes / 1e6)} MB, the limit is ${Math.round(PRELOAD_MAX_BYTES / 1e6)} MB). Use Export, or Live mode.`, true);
    }
    const abort = (this.abort = new AbortController());
    const key = videoKey();
    this.last = { key, progress: { state: 'running', stage: 'preparing', chunk: 0, chunks: 0, percent: 0, detail: 'Getting ready…' } };
    this.deps.onChange();
    void this.run(settings, video, key, abort);
    return { ok: true };
  }

  cancel(): void {
    this.abort?.abort();
  }

  /** Frees the memory of a cache whose video is no longer open. */
  release(): void {
    if (this.cache && this.cache.key !== videoKey()) this.cache = null;
  }

  status(settings: MixerSettings, holding?: string, playing?: PreloadStatus['playing']): PreloadStatus {
    const key = videoKey();
    if (this.abort && this.last) return { state: 'loading', progress: this.last.progress };
    const cache = this.ready(key);
    if (cache) return { state: 'ready', stale: cache.signature !== preloadSignature(settings), holding, bytes: cache.bytes, playing };
    if (this.last?.key === key && this.last.progress.state !== 'running') return { state: this.last.progress.state === 'cancelled' ? 'cancelled' : 'error', progress: this.last.progress, tooBig: this.last.tooBig };
    return { state: 'idle' };
  }

  private async run(settings: MixerSettings, video: HTMLVideoElement, key: string, abort: AbortController): Promise<void> {
    const { site } = this.deps;
    const report = (progress: ExportProgress) => (this.last = { key, progress });
    try {
      const engine = (await import(/* @vite-ignore */ chrome.runtime.getURL(ENGINE_PATH))) as typeof import('../export/engine');
      const player = site === 'generic' ? null : findPlayer(site);
      const tap = await pageTap(site);
      const options = { ...defaultExportOptions(settings, DEFAULT_LYRICS_PREFS), tracks: 'separate' as const }; // the model always runs
      const cache = new StemCache(key, preloadSignature(settings), video.duration, stemsOf(settings));
      await engine.runPreload(
        {
          video,
          options,
          lyrics: null,
          title: '',
          signal: abort.signal,
          report,
          tap,
          problem: () => (player && isAdShowing(player) ? 'An ad interrupted the recording. Try again when the video plays without ads.' : null),
        },
        (s) => cache.add(engine.stemsOfSlice(settings, s), s.start),
      );
      this.cache = cache;
      report({ state: 'done', stage: 'finishing', chunk: 0, chunks: 0, percent: 100, detail: 'Ready' });
    } catch (e) {
      const cancelled = e instanceof Error && e.message === 'Export cancelled';
      const was = this.last?.progress;
      report({
        state: cancelled ? 'cancelled' : 'error',
        stage: was?.stage ?? 'preparing',
        chunk: 0,
        chunks: was?.chunks ?? 0,
        percent: was?.percent ?? 0,
        detail: cancelled ? 'Preloading cancelled.' : 'Preloading stopped.',
        ...(cancelled ? {} : { error: e instanceof Error ? e.message : String(e) }),
      });
      if (!cancelled) console.warn('[All Mixer!] preload failed:', e);
    } finally {
      this.abort = null;
      this.deps.onChange();
    }
  }
}

/** Why a ready cache is not what plays right now, for the popup. */
export function holdingReason(cache: StemCache | null, video: HTMLMediaElement | null): string | undefined {
  if (!cache || !video || PreloadPlayer.fits(cache, video, cache.key)) return undefined;
  return Math.abs(video.duration - cache.duration) >= 0.5 ? 'another clip (an ad?) is playing' : 'the playback speed is not 1×';
}
