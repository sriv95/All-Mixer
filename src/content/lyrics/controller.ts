import type { CaptionTrack, PlayerInfo } from '../../shared/bridge';
import type { FoundLyrics } from '../../lyrics/lrclib-types';
import type { Lyrics, SyncedLyrics, TrackInfo } from '../../lyrics/types';
import { alignWithCaptions, linesFromAsrCaptions, linesFromCaptions, type CaptionTrackData } from '../../lyrics/align';
import { parseJson3 } from '../../lyrics/captions';
import { parseLrc } from '../../lyrics/lrc';
import type { Site } from '../youtube-dom';
import { captionOptions, chooseCaptionTracks, trackFromPlayer, type CaptionOption } from './track-info';

/** Caption track picker, shown while the lyrics come from captions and the video has more than one track. */
export interface CaptionPicker {
  options: CaptionOption[];
  /** Index into the video's caption tracks. */
  selected: number;
}

export type LyricsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; lyrics: Lyrics; track: TrackInfo; captions?: CaptionPicker }
  | { kind: 'not-found'; track?: TrackInfo }
  | { kind: 'error' };

/** A place that shows lyrics (floating panel, YT Music lyrics tab). */
export interface LyricsSurface {
  /** True while the user can see it; the controller only fetches and ticks for active surfaces. */
  readonly active: boolean;
  /** Wants lyrics loaded even while hidden (e.g. to decide whether to enable YT Music's Lyrics tab). */
  readonly prefetch?: boolean;
  render(state: LyricsState): void;
  update(time: number): void;
}

export interface LyricsDeps {
  getPlayerInfo(videoId: string, signal: AbortSignal): Promise<PlayerInfo | null>;
  getTimedText(videoId: string, track: CaptionTrack): Promise<string | null>;
  fetchLyrics(track: TrackInfo): Promise<FoundLyrics | null>;
  /** Subscribe to "the player just loaded captions for this video" (user turned CC on). */
  onCaptionsAvailable?(cb: (videoId: string) => void): void;
  /** Seconds between `video.currentTime` and what the user hears (Separate-mode latency, D1). */
  audioDelay?(): number;
}

/** Fetched caption track. `index` points into `PlayerInfo.captionTracks`. */
export interface FetchedCaptions extends CaptionTrackData {
  lang?: string;
  index?: number;
}

export interface CaptionSet {
  /** Auto-generated track: alignment evidence, and the transcript of last resort. */
  asr?: FetchedCaptions;
  /** Human-made track in the spoken language. */
  manual?: FetchedCaptions;
  /** Track the user picked (or the language they picked before), shown instead of the default choice. */
  display?: FetchedCaptions;
}

/** The caption track to show when LRCLIB has no synced lyrics, or undefined. Plain LRCLIB lyrics beat an ASR transcript. */
export function fallbackCaptions(found: FoundLyrics | null, c: CaptionSet): FetchedCaptions | undefined {
  if (c.display) return c.display;
  if (c.manual) return c.manual;
  return found?.plain ? undefined : c.asr;
}

const baseLang = (code: string) => code.split('-')[0];

/** Turn LRCLIB + caption data into what we show. Pure, exported for tests. */
export function resolveLyrics(found: FoundLyrics | null, captions: CaptionSet): Lyrics | null {
  const evidence = captions.asr ?? captions.manual ?? null;
  if (found?.synced) {
    const lines = parseLrc(found.synced);
    if (lines.length > 0) {
      const base: SyncedLyrics = { kind: 'synced', lines, source: 'lrclib', offset: 0, hasWordTiming: lines.some((l) => l.words) };
      return alignWithCaptions(base, evidence);
    }
  }
  // No synced lyrics: show the video's subtitles, or its auto-generated transcript.
  const shown = fallbackCaptions(found, captions);
  if (shown?.asr) {
    const lines = linesFromAsrCaptions(shown.cues);
    return { kind: 'synced', lines, source: 'youtube-auto-captions', offset: 0, hasWordTiming: lines.some((l) => l.words) };
  }
  if (shown) {
    const base: SyncedLyrics = { kind: 'synced', lines: linesFromCaptions(shown.cues), source: 'youtube-captions', offset: 0, hasWordTiming: false };
    const asr = captions.asr;
    // ASR word timing only fits subtitles in the same language.
    const sameLang = !asr?.lang || !shown.lang || baseLang(asr.lang) === baseLang(shown.lang);
    return asr && sameLang ? alignWithCaptions(base, asr) : base;
  }
  if (found?.plain) return { kind: 'plain', text: found.plain, source: 'lrclib' };
  return null;
}

export class LyricsController {
  private readonly surfaces = new Set<LyricsSurface>();
  private state: LyricsState = { kind: 'idle' };
  private videoId: string | null = null;
  private loadedFor: string | null = null;
  private abort: AbortController | null = null;
  private video: HTMLVideoElement | null = null;
  private raf = 0;
  /** LRCLIB result and caption tracks for `loadedFor`, kept for re-alignment. */
  private base: { videoId: string; info: PlayerInfo; track: TrackInfo; found: FoundLyrics | null } | null = null;
  /** A captions event arrived while `load()` was still running; re-align as soon as `base` is set. */
  private pendingRealign: string | null = null;
  private retryTimers: ReturnType<typeof setTimeout>[] = [];
  /** Caption track the user picked for one video. */
  private pick: { videoId: string; index: number } | null = null;
  /** Language of the last picked track; preferred on later videos in this tab. */
  private preferredLang: string | null = null;

  constructor(
    private readonly site: Site,
    private readonly deps: LyricsDeps,
  ) {
    deps.onCaptionsAvailable?.((id) => void this.realign(id));
  }

  /** CC was turned on: the player fetches its captions a moment later, so re-align a few times until the timing changes. */
  realignWithRetries(delaysMs: readonly number[] = REALIGN_RETRY_MS): void {
    this.clearRetries();
    const videoId = this.videoId;
    if (!videoId) return;
    const attempt = (i: number): void => {
      const t = setTimeout(() => {
        if (this.videoId !== videoId) return;
        void this.realign(videoId).then((changed) => {
          if (changed || this.videoId !== videoId) return;
          if (i + 1 < delaysMs.length) attempt(i + 1);
        });
      }, delaysMs[i]! - (i > 0 ? delaysMs[i - 1]! : 0));
      this.retryTimers.push(t);
    };
    if (delaysMs.length) attempt(0);
  }

  get current(): LyricsState {
    return this.state;
  }

  addSurface(s: LyricsSurface): void {
    this.surfaces.add(s);
    s.render(this.state);
    this.refresh();
  }

  removeSurface(s: LyricsSurface): void {
    this.surfaces.delete(s);
  }

  setVideo(video: HTMLVideoElement): void {
    if (this.video === video) return;
    for (const ev of VIDEO_EVENTS) this.video?.removeEventListener(ev, this.onVideoEvent);
    this.video = video;
    for (const ev of VIDEO_EVENTS) video.addEventListener(ev, this.onVideoEvent);
    this.refresh();
  }

  /** Call on every SPA navigation / track change with the current video id (null off watch pages). */
  setVideoId(videoId: string | null): void {
    if (videoId === this.videoId) return;
    this.videoId = videoId;
    this.abort?.abort();
    this.abort = null;
    this.loadedFor = null;
    this.pendingRealign = null;
    this.clearRetries();
    this.setState({ kind: 'idle' });
    this.refresh();
  }

  /** The user picked another caption track (index into the video's caption tracks) in the language menu. */
  selectCaptionTrack(index: number): void {
    const base = this.base;
    const t = base?.info.captionTracks[index];
    if (!base || !t || base.videoId !== this.videoId) return;
    this.pick = { videoId: base.videoId, index };
    this.preferredLang = t.languageCode;
    void this.realign(base.videoId, true);
  }

  seek(time: number): void {
    const v = this.video;
    if (!v) return;
    v.currentTime = Math.max(0, time);
    this.tick();
  }

  /** Re-evaluate: start loading if someone is watching, and (re)start the frame loop. Surfaces call this when they open. */
  refresh(): void {
    const active = this.anyActive();
    const wanted = active || [...this.surfaces].some((s) => s.prefetch);
    if (wanted && this.videoId && this.loadedFor !== this.videoId) void this.load(this.videoId);
    if (active && this.video && !this.video.paused) this.startLoop();
    else this.stopLoop();
    if (active) this.tick();
  }

  destroy(): void {
    this.abort?.abort();
    this.clearRetries();
    this.stopLoop();
    for (const ev of VIDEO_EVENTS) this.video?.removeEventListener(ev, this.onVideoEvent);
    this.surfaces.clear();
  }

  private clearRetries(): void {
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers = [];
  }

  private anyActive(): boolean {
    for (const s of this.surfaces) if (s.active) return true;
    return false;
  }

  private setState(state: LyricsState): void {
    this.state = state;
    for (const s of this.surfaces) s.render(state);
    if (state.kind === 'ready') this.tick();
  }

  private async load(videoId: string): Promise<void> {
    this.loadedFor = videoId;
    this.base = null;
    this.abort?.abort();
    const ctrl = new AbortController();
    this.abort = ctrl;
    this.setState({ kind: 'loading' });
    try {
      const info = await this.deps.getPlayerInfo(videoId, ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (!info) {
        this.loadedFor = null; // allow a retry when a surface re-opens
        this.setState({ kind: 'error' });
        return;
      }
      const track = trackFromPlayer(this.site, info, this.video?.duration || 0);
      const [found, captions] = await Promise.all([this.deps.fetchLyrics(track).catch(() => null), this.captions(videoId, info)]);
      if (ctrl.signal.aborted) return;
      this.base = { videoId, info, track, found };
      const lyrics = resolveLyrics(found, captions);
      this.setState(lyrics ? this.ready(lyrics, info, track, found, captions) : { kind: 'not-found', track });
      if (this.pendingRealign === videoId) {
        this.pendingRealign = null;
        void this.realign(videoId);
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      console.warn('[All Mixer!] lyrics failed:', e);
      this.loadedFor = null;
      this.setState({ kind: 'error' });
    }
  }

  private ready(lyrics: Lyrics, info: PlayerInfo, track: TrackInfo, found: FoundLyrics | null, captions: CaptionSet): LyricsState {
    const shown = lyrics.source === 'lrclib' ? undefined : fallbackCaptions(found, captions);
    const options = captionOptions(info.captionTracks);
    if (shown?.index === undefined || options.length < 2) return { kind: 'ready', lyrics, track };
    return { kind: 'ready', lyrics, track, captions: { options, selected: shown.index } };
  }

  /** Index of the caption track to show instead of the default choice, or -1. */
  private displayIndex(videoId: string, tracks: readonly CaptionTrack[], defaultLang?: string): number {
    if (this.pick?.videoId === videoId) return this.pick.index;
    const lang = this.preferredLang ?? defaultLang;
    if (!lang) return -1;
    const manual = tracks.findIndex((t) => t.kind !== 'asr' && t.languageCode === lang);
    return manual >= 0 ? manual : tracks.findIndex((t) => t.languageCode === lang);
  }

  private async captions(videoId: string, info: PlayerInfo): Promise<CaptionSet> {
    const tracks = info.captionTracks;
    const choice = chooseCaptionTracks(tracks, info.defaultCaptionLang);
    const asrIdx = choice.asr ? tracks.indexOf(choice.asr) : -1;
    const manualIdx = choice.manual ? tracks.indexOf(choice.manual) : -1;
    let displayIdx = this.displayIndex(videoId, tracks);
    // Only foreign-language subtitles (no ASR track, no manual track in the spoken language): show the default one, else the first.
    if (displayIdx < 0 && asrIdx < 0 && manualIdx < 0 && tracks.length > 0) displayIdx = Math.max(0, this.displayIndex(videoId, tracks, info.defaultCaptionLang));
    const get = async (i: number): Promise<FetchedCaptions | undefined> => {
      const t = tracks[i];
      if (!t) return undefined;
      const raw = await this.deps.getTimedText(videoId, t).catch(() => null);
      const cues = raw ? parseJson3(raw) : [];
      return cues.length ? { cues, asr: t.kind === 'asr', lang: t.languageCode, index: i } : undefined;
    };
    const extra = displayIdx >= 0 && displayIdx !== asrIdx && displayIdx !== manualIdx ? displayIdx : -1;
    const [asr, manual, other] = await Promise.all([get(asrIdx), get(manualIdx), get(extra)]);
    const display = displayIdx < 0 ? undefined : displayIdx === asrIdx ? asr : displayIdx === manualIdx ? manual : other;
    return { asr, manual, display };
  }

  /**
   * Captions showed up after we loaded (CC turned on), or the user picked another caption track:
   * redo the alignment with the same LRCLIB result. True if the lyrics changed. `force` re-renders even if the timing looks the same.
   */
  async realign(videoId: string, force = false): Promise<boolean> {
    if (this.videoId !== videoId) return false;
    const base = this.base;
    if (!base || base.videoId !== videoId) {
      if (this.loadedFor === videoId) this.pendingRealign = videoId; // load() is still running
      return false;
    }
    const captions = await this.captions(videoId, base.info);
    if (this.base !== base) return false;
    const lyrics = resolveLyrics(base.found, captions);
    if (!lyrics) return false;
    const cur = this.state.kind === 'ready' ? this.state.lyrics : null;
    if (!force && cur && sameTiming(cur, lyrics)) return false;
    this.setState(this.ready(lyrics, base.info, base.track, base.found, captions));
    return true;
  }

  private tick = (): void => {
    const v = this.video;
    if (!v || this.state.kind !== 'ready') return;
    const t = v.currentTime - (this.deps.audioDelay?.() ?? 0);
    for (const s of this.surfaces) if (s.active) s.update(t);
  };

  private readonly onVideoEvent = (): void => this.refresh();

  private startLoop(): void {
    if (this.raf) return;
    const loop = () => {
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}

/** Delays after CC turns on, measured from the button press. */
const REALIGN_RETRY_MS = [1000, 3000, 6000];

const VIDEO_EVENTS = ['play', 'pause', 'seeked', 'ratechange', 'loadedmetadata'] as const;

function sameTiming(a: Lyrics, b: Lyrics): boolean {
  if (a.kind !== 'synced' || b.kind !== 'synced') return a.kind === b.kind;
  return a.source === b.source && a.offset === b.offset && a.hasWordTiming === b.hasWordTiming && a.lines.length === b.lines.length;
}
