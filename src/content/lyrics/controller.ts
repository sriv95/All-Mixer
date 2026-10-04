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

  constructor(
    private readonly site: Site,
    private readonly deps: LyricsDeps,
  ) {}

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
      const choice = chooseCaptionTracks(info.captionTracks);
      const cap = (t: CaptionTrack | undefined, asr: boolean): Promise<CaptionTrackData | undefined> =>
        t
          ? this.deps.getTimedText(videoId, t).then(
              (raw) => {
                const cues = raw ? parseJson3(raw) : [];
                return cues.length ? { cues, asr } : undefined;
              },
              () => undefined,
            )
          : Promise.resolve(undefined);
      const [found, asr, manual] = await Promise.all([
        this.deps.fetchLyrics(track).catch(() => null),
        cap(choice.asr, true),
        cap(choice.manual, false),
      ]);
      if (ctrl.signal.aborted) return;
      const lyrics = resolveLyrics(this.site, found, { asr, manual });
      this.setState(lyrics ? { kind: 'ready', lyrics, track } : { kind: 'not-found', track });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      console.warn('[All Mixer!] lyrics failed:', e);
      this.loadedFor = null;
      this.setState({ kind: 'error' });
    }
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
