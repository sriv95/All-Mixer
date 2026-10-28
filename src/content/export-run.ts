import { needsSeparation, normalizeExportOptions, type ExportOptions, type ExportProgress } from '../shared/export';
import type { ExportAnswer } from '../shared/messages';
import type { LyricLine } from '../lyrics/types';
import { findPlayer, isAdShowing, type PageSite } from './youtube-dom';

/** The export engine is its own module (it carries the encoders): web-accessible, loaded when the first export starts. */
const ENGINE_PATH = 'export/engine.js';

interface Deps {
  site: PageSite;
  video(): HTMLMediaElement | null;
  lyrics(): { lines: LyricLine[]; offsetMs: number } | null;
  /** The export started or ended: the live engine makes room for it or comes back. */
  onChange(): void;
}

/** "(3) Song - Artist - YouTube" → "Song - Artist". */
export const titleOf = (documentTitle: string): string => documentTitle.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube( Music)?$/, '');

/** Owns the export of this tab: starts it, keeps its progress for the popup, saves the file. */
export class ExportRunner {
  progress: ExportProgress | undefined;
  private abort: AbortController | null = null;

  constructor(private readonly deps: Deps) {}

  get running(): boolean {
    return this.abort !== null;
  }

  start(raw: unknown): ExportAnswer {
    const { site } = this.deps;
    const video = this.deps.video();
    const options = normalizeExportOptions(raw);
    if (this.abort) return { ok: false, error: 'An export is already running in this tab.' };
    if (!(video instanceof HTMLVideoElement)) return { ok: false, error: 'There is no video to export on this page.' };
    if (!Number.isFinite(video.duration) || video.duration <= 0) return { ok: false, error: 'This video has no fixed length (a live stream cannot be exported).' };
    const player = site === 'generic' ? null : findPlayer(site);
    if (player && isAdShowing(player)) return { ok: false, error: 'An ad is playing. Export when the video itself plays.' };
    // The model runs in the extension frame the live Separate mode uses, which only YouTube pages may host.
    if (site === 'generic' && needsSeparation(options)) return { ok: false, error: 'Separating stems works on YouTube pages. Set the levels to 100 % and pick Single track to export the plain sound.' };
    this.abort = new AbortController();
    this.progress = { state: 'running', stage: 'preparing', chunk: 0, chunks: 0, percent: 0, detail: 'Getting ready…' };
    this.deps.onChange();
    void this.run(options, video, this.abort);
    return { ok: true };
  }

  cancel(): void {
    this.abort?.abort();
  }

  private async run(options: ExportOptions, video: HTMLVideoElement, abort: AbortController): Promise<void> {
    const { site } = this.deps;
    try {
      const engine = (await import(/* @vite-ignore */ chrome.runtime.getURL(ENGINE_PATH))) as typeof import('../export/engine');
      const player = site === 'generic' ? null : findPlayer(site);
      const file = await engine.runExport({
        video,
        options,
        lyrics: options.format === 'mp4' ? this.deps.lyrics() : null,
        title: titleOf(document.title),
        signal: abort.signal,
        report: (p) => (this.progress = p),
        problem: () => (player && isAdShowing(player) ? 'An ad interrupted the recording. Try again when the video plays without ads.' : null),
      });
      save(file.blob, file.name);
      this.progress = { state: 'done', stage: 'finishing', chunk: 0, chunks: 0, percent: 100, detail: `Saved ${file.name}`, file: { name: file.name, bytes: file.blob.size } };
    } catch (e) {
      const cancelled = e instanceof Error && e.message === 'Export cancelled';
      this.progress = {
        state: cancelled ? 'cancelled' : 'error',
        stage: this.progress?.stage ?? 'preparing',
        chunk: 0,
        chunks: this.progress?.chunks ?? 0,
        percent: this.progress?.percent ?? 0,
        detail: cancelled ? 'Export cancelled.' : 'The export stopped.',
        ...(cancelled ? {} : { error: e instanceof Error ? e.message : String(e) }),
      };
      if (!cancelled) console.warn('[All Mixer!] export failed:', e);
    } finally {
      this.abort = null;
      this.deps.onChange();
    }
  }
}

/** The browser's download of a blob: an invisible link that is clicked. */
function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
