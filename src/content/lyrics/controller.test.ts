import { describe, expect, it, vi } from 'vitest';
import type { PlayerInfo } from '../../shared/bridge';
import type { FoundLyrics } from '../../lyrics/lrclib-types';
import { LyricsController, resolveLyrics, type LyricsDeps, type LyricsState, type LyricsSurface } from './controller';

const record = { id: 1, trackName: 'Song', artistName: 'Band', duration: 200 };
const SYNCED = '[00:01.00]hello world\n[00:03.00]second line';

function json3(words: { t: number; w: string }[]): string {
  return JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 60000, segs: words.map(({ t, w }) => ({ utf8: ` ${w}`, tOffsetMs: t * 1000 })) }] });
}

class FakeSurface implements LyricsSurface {
  active = true;
  states: LyricsState[] = [];
  times: number[] = [];
  render(s: LyricsState) {
    this.states.push(s);
  }
  update(t: number) {
    this.times.push(t);
  }
  get last() {
    return this.states[this.states.length - 1];
  }
}

const info = (videoId: string, p: Partial<PlayerInfo> = {}): PlayerInfo => ({
  videoId,
  title: 'Band - Song (Official Video)',
  author: 'BandVEVO',
  lengthSeconds: 200,
  captionTracks: [],
  ...p,
});

function deps(over: Partial<LyricsDeps> = {}): LyricsDeps {
  return {
    getPlayerInfo: vi.fn(async (id: string) => info(id)),
    getTimedText: vi.fn(async () => null),
    fetchLyrics: vi.fn(async (): Promise<FoundLyrics | null> => ({ synced: SYNCED, record })),
    ...over,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('resolveLyrics', () => {
  it('prefers LRCLIB synced lyrics', () => {
    const l = resolveLyrics('youtube', { synced: SYNCED, plain: 'x', record }, {});
    expect(l).toMatchObject({ kind: 'synced', source: 'lrclib' });
  });

  it('uses manual captions when LRCLIB only has plain lyrics', () => {
    const manual = { asr: false, cues: [{ start: 2, end: 4, text: 'hello world' }] };
    expect(resolveLyrics('youtube', { plain: 'hello world', record }, { manual })).toMatchObject({ kind: 'synced', source: 'youtube-captions' });
    // Not a known song on youtube.com: don't show random captions as lyrics.
    expect(resolveLyrics('youtube', null, { manual })).toBeNull();
    expect(resolveLyrics('ytmusic', null, { manual })).toMatchObject({ source: 'youtube-captions' });
  });

  it('falls back to plain lyrics, then null', () => {
    expect(resolveLyrics('youtube', { plain: 'la la', record }, {})).toEqual({ kind: 'plain', text: 'la la', source: 'lrclib' });
    expect(resolveLyrics('youtube', null, {})).toBeNull();
  });
});

describe('LyricsController', () => {
  it('loads only when a surface is active and uses the parsed track', async () => {
    const d = deps();
    const c = new LyricsController('youtube', d);
    const s = new FakeSurface();
    s.active = false;
    c.addSurface(s);
    c.setVideoId('v1');
    await flush();
    expect(d.getPlayerInfo).not.toHaveBeenCalled();

    s.active = true;
    c.refresh();
    await flush();
    expect(d.fetchLyrics).toHaveBeenCalledWith({ videoId: 'v1', title: 'Song', artist: 'Band', duration: 200 });
    expect(s.states.map((x) => x.kind)).toEqual(['idle', 'idle', 'loading', 'ready']);
  });

  it('aligns with ASR captions when available', async () => {
    const asrTrack = { baseUrl: 'u', languageCode: 'en', kind: 'asr' };
    const words = [
      { t: 11, w: 'hello' },
      { t: 11.5, w: 'world' },
      { t: 13, w: 'second' },
      { t: 13.4, w: 'line' },
    ];
    const d = deps({
      getPlayerInfo: vi.fn(async (id: string) => info(id, { captionTracks: [asrTrack] })),
      getTimedText: vi.fn(async () => json3([...words, ...words.map((w) => ({ ...w, t: w.t + 0.05 })), ...words.map((w) => ({ ...w, t: w.t - 0.05 }))])),
    });
    const c = new LyricsController('youtube', d);
    const s = new FakeSurface();
    c.addSurface(s);
    c.setVideoId('v1');
    await flush();
    const st = s.last;
    expect(st.kind).toBe('ready');
    if (st.kind !== 'ready' || st.lyrics.kind !== 'synced') throw new Error('not synced');
    expect(st.lyrics.offset).toBeCloseTo(10, 0);
    expect(st.lyrics.hasWordTiming).toBe(true);
  });

  it('drops results for a video the user already left', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = deps({
      fetchLyrics: vi.fn(async (t) => {
        if (t.videoId === 'old') await gate;
        return { synced: SYNCED, record };
      }),
    });
    const c = new LyricsController('youtube', d);
    const s = new FakeSurface();
    c.addSurface(s);
    c.setVideoId('old');
    await flush();
    c.setVideoId('new');
    await flush();
    release();
    await flush();
    const st = s.last;
    expect(st.kind === 'ready' && st.track.videoId).toBe('new');
  });

  it('reports not-found and error', async () => {
    const c = new LyricsController('youtube', deps({ fetchLyrics: vi.fn(async () => null) }));
    const s = new FakeSurface();
    c.addSurface(s);
    c.setVideoId('v');
    await flush();
    expect(s.last.kind).toBe('not-found');

    const c2 = new LyricsController('youtube', deps({ getPlayerInfo: vi.fn(async () => null) }));
    const s2 = new FakeSurface();
    c2.addSurface(s2);
    c2.setVideoId('v');
    await flush();
    expect(s2.last.kind).toBe('error');
  });

  it('ticks with the audio delay applied and seeks the video', async () => {
    const c = new LyricsController('youtube', { ...deps(), audioDelay: () => 0.25 });
    const s = new FakeSurface();
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 5, writable: true });
    c.addSurface(s);
    c.setVideo(video);
    c.setVideoId('v');
    await flush();
    expect(s.times.at(-1)).toBeCloseTo(4.75);
    c.seek(42);
    expect(video.currentTime).toBe(42);
  });
});
