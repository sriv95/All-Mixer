import type { CaptionTrack, PlayerInfo } from '../../shared/bridge';
import type { FoundLyrics } from '../../lyrics/lrclib-types';
import type { Lyrics, SyncedLyrics, TrackInfo } from '../../lyrics/types';
import { alignWithCaptions, linesFromAsrCaptions, linesFromCaptions, type CaptionTrackData } from '../../lyrics/align';
import { parseJson3 } from '../../lyrics/captions';
import { parseLrc } from '../../lyrics/lrc';
import type { Site } from '../youtube-dom';
import { captionOptions, chooseCaptionTracks, trackFromPlayer, type CaptionOption, type CaptionPick } from './track-info';

/** Caption track picker, shown while the lyrics come from captions and the video has more than one option. */
export interface CaptionPicker {
  options: CaptionOption[];
  selected: CaptionPick;
}

/** Which lyrics source the user wants. */
export type SourcePref = 'auto' | 'lrclib' | 'captions';

/** What the footer's source menu needs. */
export interface SourceMenu {
  pref: SourcePref;
  available: { lrclib: boolean; captions: boolean };
  /** The pick could not be honoured for this video (missing source); the auto order was used instead. */
  fellBack?: 'lrclib' | 'captions';
}

export type LyricsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; lyrics: Lyrics; track: TrackInfo; captions?: CaptionPicker; sources?: SourceMenu }
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
  /** Media time of the picture on screen (delayed-video overlay, D1); null when there is no overlay. */
  presentedTime?(): number | null;
  /** True while the delayed overlay still has frames queued (the presented time may sit still before the next one is drawn). */
  presentedBusy?(): boolean;
}

/** Fetched caption track. `index` points into `PlayerInfo.captionTracks`. */
export interface FetchedCaptions extends CaptionTrackData {
  /** Language of the cues. */
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
  /** Foreign-language subtitles (default track, else the first): last resort when there is no ASR and no manual track in the song language. */
  other?: FetchedCaptions;
}

const baseLang = (code: string) => code.split('-')[0];

const hasSynced = (found: FoundLyrics | null): boolean => !!found?.synced && parseLrc(found.synced).length > 0;

/** The caption track shown when captions win: pick / preferred language, then song-language subtitles, ASR, any other track. */
export const captionCandidate = (c: CaptionSet): FetchedCaptions | undefined => c.display ?? c.manual ?? c.asr ?? c.other;

export interface SourceChoice {
  use: 'lrclib-synced' | 'lrclib-plain' | 'captions' | null;
  caption?: FetchedCaptions;
  /** The user's pick had nothing for this video. */
  fellBack?: 'lrclib' | 'captions';
}

/** Automatic order: song captions, LRCLIB synced, other captions (ASR first), LRCLIB plain. */
function autoSource(found: FoundLyrics | null, c: CaptionSet): SourceChoice {
  // A fetched human track in the picked / preferred language counts as song captions, and wins over the default manual track.
  const song = (c.display && !c.display.asr ? c.display : undefined) ?? c.manual;
  if (song) return { use: 'captions', caption: song };
  if (hasSynced(found)) return { use: 'lrclib-synced' };
  const caption = captionCandidate(c);
  if (caption) return { use: 'captions', caption };
  if (found?.plain) return { use: 'lrclib-plain' };
  return { use: null };
}

/**
 * Pick the source to show. Pure, exported for tests.
 * `picked`: the user chose a caption language for this video, which means "captions" even in auto mode.
 */
export function chooseSource(found: FoundLyrics | null, c: CaptionSet, pref: SourcePref = 'auto', picked = false): SourceChoice {
  const want = picked ? 'captions' : pref;
  if (want === 'lrclib') {
    if (hasSynced(found)) return { use: 'lrclib-synced' };
    if (found?.plain) return { use: 'lrclib-plain' };
    return { ...autoSource(found, c), fellBack: 'lrclib' };
  }
  if (want === 'captions') {
    const caption = captionCandidate(c);
    if (caption) return { use: 'captions', caption };
    return { ...autoSource(found, c), fellBack: 'captions' };
  }
  return autoSource(found, c);
}

/** Build the lyrics for a choice. Pure, exported for tests. */
export function buildLyrics(choice: SourceChoice, found: FoundLyrics | null, captions: CaptionSet): Lyrics | null {
  if (choice.use === 'lrclib-synced' && found?.synced) {
    const base: SyncedLyrics = { kind: 'synced', lines: parseLrc(found.synced), source: 'lrclib', offset: 0, hasWordTiming: false };
    base.hasWordTiming = base.lines.some((l) => l.words);
    return alignWithCaptions(base, captions.asr ?? captions.manual ?? null);
  }
  if (choice.use === 'lrclib-plain' && found?.plain) return { kind: 'plain', text: found.plain, source: 'lrclib' };
  const shown = choice.caption;
  if (choice.use !== 'captions' || !shown) return null;
  if (shown.asr) {
    const lines = linesFromAsrCaptions(shown.cues);
    return { kind: 'synced', lines, source: 'youtube-auto-captions', offset: 0, hasWordTiming: lines.some((l) => l.words) };
  }
  const base: SyncedLyrics = { kind: 'synced', lines: linesFromCaptions(shown.cues), source: 'youtube-captions', offset: 0, hasWordTiming: false };
  const asr = captions.asr;
  // ASR word timing only fits subtitles in the same language.
  const sameLang = !asr?.lang || !shown.lang || baseLang(asr.lang) === baseLang(shown.lang);
  return asr && sameLang ? alignWithCaptions(base, asr) : base;
}

/** Turn LRCLIB + caption data into what we show. Pure, exported for tests. */
export function resolveLyrics(found: FoundLyrics | null, captions: CaptionSet, pref: SourcePref = 'auto', picked = false): Lyrics | null {
  return buildLyrics(chooseSource(found, captions, pref, picked), found, captions);
}

export class LyricsController {
  private readonly surfaces = new Set<LyricsSurface>();
  private state: LyricsState = { kind: 'idle' };
  private videoId: string | null = null;
  private loadedFor: string | null = null;
  private abort: AbortController | null = null;
  private video: HTMLVideoElement | null = null;
  private raf = 0;
  private lastPresented: number | null = null;
  private lastMoved = 0;
  /** LRCLIB result and caption tracks for `loadedFor`, kept for re-alignment. */
  private base: { videoId: string; info: PlayerInfo; track: TrackInfo; found: FoundLyrics | null } | null = null;
  /** A captions event arrived while `load()` was still running; re-align as soon as `base` is set. */
  private pendingRealign: string | null = null;
  private retryTimers: ReturnType<typeof setTimeout>[] = [];
  /** Caption track the user picked for one video. */
  private pick: ({ videoId: string } & CaptionPick) | null = null;
  /** Language of the last picked track; preferred on later videos in this tab. */
  private preferredLang: string | null = null;
  /** Lyrics source the user chose; kept for later videos in this tab. */
  private sourcePref: SourcePref = 'auto';

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

  /** The user picked another caption track (language menu). */
  selectCaptionTrack(pick: CaptionPick): void {
    const base = this.base;
    const t = base?.info.captionTracks[pick.index];
    if (!base || !t || base.videoId !== this.videoId) return;
    this.pick = { videoId: base.videoId, index: pick.index };
    this.preferredLang = t.languageCode;
    void this.realign(base.videoId, true);
  }

  /** The user chose a lyrics source (source menu). Re-resolves from the loaded data, no new LRCLIB request. */
  selectSource(pref: SourcePref): void {
    this.sourcePref = pref;
    this.pick = null;
    const id = this.videoId;
    if (id) void this.realign(id, true);
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
    if (active && this.video && (!this.video.paused || this.draining())) this.startLoop();
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
      const choice = chooseSource(found, captions, this.sourcePref, this.pick?.videoId === videoId);
      const lyrics = buildLyrics(choice, found, captions);
      this.setState(lyrics ? this.ready(lyrics, choice, info, track, found, captions) : { kind: 'not-found', track });
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

  private ready(lyrics: Lyrics, choice: SourceChoice, info: PlayerInfo, track: TrackInfo, found: FoundLyrics | null, captions: CaptionSet): LyricsState {
    const sources: SourceMenu = {
      pref: this.sourcePref,
      available: { lrclib: !!found && (hasSynced(found) || !!found.plain), captions: !!captionCandidate(captions) },
      ...(choice.fellBack ? { fellBack: choice.fellBack } : {}),
    };
    const shown = choice.use === 'captions' ? choice.caption : undefined;
    if (shown?.index === undefined) return { kind: 'ready', lyrics, track, sources };
    const options = captionOptions(info.captionTracks);
    if (options.length < 2) return { kind: 'ready', lyrics, track, sources };
    return { kind: 'ready', lyrics, track, sources, captions: { options, selected: { index: shown.index } } };
  }

  /** Track to show instead of the default choice: this video's pick, else the tab's preferred language. */
  private displayPick(videoId: string, tracks: readonly CaptionTrack[], ): CaptionPick | null {
    if (this.pick?.videoId === videoId) return this.pick;
    const lang = this.preferredLang;
    if (!lang) return null;
    const native = nativeIndex(tracks, lang);
    return native >= 0 ? { index: native } : null;
  }

  private async captions(videoId: string, info: PlayerInfo): Promise<CaptionSet> {
    const tracks = info.captionTracks;
    const choice = chooseCaptionTracks(tracks, info.defaultCaptionLang);
    const asrIdx = choice.asr ? tracks.indexOf(choice.asr) : -1;
    const manualIdx = choice.manual ? tracks.indexOf(choice.manual) : -1;
    const want = this.displayPick(videoId, tracks);
    // Only foreign-language subtitles (no ASR track, no manual track in the spoken language): the default one, else the first.
    const otherIdx = !want && asrIdx < 0 && manualIdx < 0 && tracks.length > 0 ? Math.max(0, nativeIndex(tracks, info.defaultCaptionLang)) : -1;
    const get = async (i: number): Promise<FetchedCaptions | undefined> => {
      const t = tracks[i];
      if (!t) return undefined;
      const raw = await this.deps.getTimedText(videoId, t).catch(() => null);
      const cues = raw ? parseJson3(raw) : [];
      return cues.length ? { cues, asr: t.kind === 'asr', lang: t.languageCode, index: i } : undefined;
    };
    const plain = !!want && (want.index === asrIdx || want.index === manualIdx);
    const [asr, manual, extra, other] = await Promise.all([
      get(asrIdx),
      get(manualIdx),
      want && !plain ? get(want.index) : undefined,
      get(otherIdx),
    ]);
    const display = !want ? undefined : plain ? (want.index === asrIdx ? asr : manual) : extra;
    return { asr, manual, display, other };
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
    const choice = chooseSource(base.found, captions, this.sourcePref, this.pick?.videoId === videoId);
    const lyrics = buildLyrics(choice, base.found, captions);
    if (!lyrics) return false;
    const cur = this.state.kind === 'ready' ? this.state.lyrics : null;
    if (!force && cur && sameTiming(cur, lyrics)) return false;
    this.setState(this.ready(lyrics, choice, base.info, base.track, base.found, captions));
    return true;
  }

  private tick = (): void => {
    const v = this.video;
    if (!v || this.state.kind !== 'ready') return;
    const t = this.deps.presentedTime?.() ?? v.currentTime;
    for (const s of this.surfaces) if (s.active) s.update(t);
  };

  private readonly onVideoEvent = (): void => this.refresh();

  /** Paused, but the delayed picture may still be playing out its queue; the loop stops itself once the time stops moving. */
  private draining(): boolean {
    return this.deps.presentedTime?.() != null || this.deps.presentedBusy?.() === true;
  }

  private startLoop(): void {
    if (this.raf) return;
    this.lastMoved = performance.now();
    const loop = () => {
      this.tick();
      const p = this.deps.presentedTime?.() ?? null;
      const now = performance.now();
      if (p !== this.lastPresented) this.lastMoved = now;
      this.lastPresented = p;
      if (this.video?.paused && !this.deps.presentedBusy?.() && now - this.lastMoved > DRAIN_IDLE_MS) {
        this.raf = 0;
        return;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}

/** After a pause, stop the frame loop once the presented time has not moved for this long. */
const DRAIN_IDLE_MS = 250;

/** Delays after CC turns on, measured from the button press. */
const REALIGN_RETRY_MS = [1000, 3000, 6000];

/** Track in `lang`: a manual one first, else any (ASR). -1 if none. */
function nativeIndex(tracks: readonly CaptionTrack[], lang?: string): number {
  if (!lang) return -1;
  const manual = tracks.findIndex((t) => t.kind !== 'asr' && t.languageCode === lang);
  return manual >= 0 ? manual : tracks.findIndex((t) => t.languageCode === lang);
}

const VIDEO_EVENTS = ['play', 'pause', 'waiting', 'seeked', 'ratechange', 'loadedmetadata'] as const;

function sameTiming(a: Lyrics, b: Lyrics): boolean {
  if (a.kind !== 'synced' || b.kind !== 'synced') return a.kind === b.kind;
  return a.source === b.source && a.offset === b.offset && a.hasWordTiming === b.hasWordTiming && a.lines.length === b.lines.length;
}
