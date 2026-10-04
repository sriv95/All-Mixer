import type { CaptionTrack, PlayerInfo } from '../../shared/bridge';
import type { FoundLyrics } from '../../lyrics/lrclib-types';
import type { Lyrics, SyncedLyrics, TrackInfo } from '../../lyrics/types';
import { alignWithCaptions, linesFromCaptions, type CaptionTrackData } from '../../lyrics/align';
import { parseJson3 } from '../../lyrics/captions';
import { parseLrc } from '../../lyrics/lrc';
import type { Site } from '../youtube-dom';
import { chooseCaptionTracks, trackFromPlayer } from './track-info';

export type LyricsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; lyrics: Lyrics; track: TrackInfo }
  | { kind: 'not-found'; track?: TrackInfo }
  | { kind: 'error' };

/** A place that shows lyrics (floating panel, YT Music lyrics tab). */
export interface LyricsSurface {
  /** True while the user can see it; the controller only fetches and ticks for active surfaces. */
  readonly active: boolean;
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

/** Turn LRCLIB + caption data into what we show. Pure, exported for tests. */
export function resolveLyrics(site: Site, found: FoundLyrics | null, captions: { asr?: CaptionTrackData; manual?: CaptionTrackData }): Lyrics | null {
  const evidence = captions.asr ?? captions.manual ?? null;
  if (found?.synced) {
    const lines = parseLrc(found.synced);
    if (lines.length > 0) {
      const base: SyncedLyrics = { kind: 'synced', lines, source: 'lrclib', offset: 0, hasWordTiming: lines.some((l) => l.words) };
      return alignWithCaptions(base, evidence);
    }
  }
  // Human-made captions are usually the lyrics on music uploads. Only trust them when we know this is a song.
  if (captions.manual && captions.manual.cues.length > 0 && (found?.plain || site === 'ytmusic')) {
    const lines = linesFromCaptions(captions.manual.cues);
    const base: SyncedLyrics = { kind: 'synced', lines, source: 'youtube-captions', offset: 0, hasWordTiming: false };
    return captions.asr ? alignWithCaptions(base, captions.asr) : base;
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

  constructor(
    private readonly site: Site,
    private readonly deps: LyricsDeps,
  ) {
    deps.onCaptionsAvailable?.((id) => void this.realign(id));
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
    this.setState({ kind: 'idle' });
    this.refresh();
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
    if (active && this.videoId && this.loadedFor !== this.videoId) void this.load(this.videoId);
    if (active && this.video && !this.video.paused) this.startLoop();
    else this.stopLoop();
    if (active) this.tick();
  }

  destroy(): void {
    this.abort?.abort();
    this.stopLoop();
    for (const ev of VIDEO_EVENTS) this.video?.removeEventListener(ev, this.onVideoEvent);
    this.surfaces.clear();
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
      const lyrics = resolveLyrics(this.site, found, captions);
      this.setState(lyrics ? { kind: 'ready', lyrics, track } : { kind: 'not-found', track });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      console.warn('[All Mixer!] lyrics failed:', e);
      this.loadedFor = null;
      this.setState({ kind: 'error' });
    }
  }

  private async captions(videoId: string, info: PlayerInfo): Promise<{ asr?: CaptionTrackData; manual?: CaptionTrackData }> {
    const choice = chooseCaptionTracks(info.captionTracks, info.defaultCaptionLang);
    const get = async (t: CaptionTrack | undefined, asr: boolean): Promise<CaptionTrackData | undefined> => {
      if (!t) return undefined;
      const raw = await this.deps.getTimedText(videoId, t).catch(() => null);
      const cues = raw ? parseJson3(raw) : [];
      return cues.length ? { cues, asr } : undefined;
    };
    const [asr, manual] = await Promise.all([get(choice.asr, true), get(choice.manual, false)]);
    return { asr, manual };
  }

  /** Captions showed up after we loaded (CC turned on): redo the alignment with the same LRCLIB result. */
  private async realign(videoId: string): Promise<void> {
    const base = this.base;
    if (!base || base.videoId !== videoId || this.videoId !== videoId) return;
    const captions = await this.captions(videoId, base.info);
    if (this.base !== base) return;
    const lyrics = resolveLyrics(this.site, base.found, captions);
    if (!lyrics) return;
    const cur = this.state.kind === 'ready' ? this.state.lyrics : null;
    if (cur && sameTiming(cur, lyrics)) return;
    this.setState({ kind: 'ready', lyrics, track: base.track });
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

const VIDEO_EVENTS = ['play', 'pause', 'seeked', 'ratechange', 'loadedmetadata'] as const;

function sameTiming(a: Lyrics, b: Lyrics): boolean {
  if (a.kind !== 'synced' || b.kind !== 'synced') return a.kind === b.kind;
  return a.source === b.source && a.offset === b.offset && a.hasWordTiming === b.hasWordTiming && a.lines.length === b.lines.length;
}
