import { describe, expect, it, vi } from 'vitest';
import type { PlayerInfo } from '../../shared/bridge';
import type { FoundLyrics } from '../../lyrics/lrclib-types';
import { LyricsController, chooseSource, resolveLyrics, type LyricsDeps, type LyricsState, type LyricsSurface } from './controller';

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
  it('uses LRCLIB synced lyrics', () => {
    const l = resolveLyrics({ synced: SYNCED, plain: 'x', record }, {});
    expect(l).toMatchObject({ kind: 'synced', source: 'lrclib' });
  });

  it('uses manual captions when LRCLIB has no synced lyrics', () => {
    const manual = { asr: false, cues: [{ start: 2, end: 4, text: 'hello world' }] };
    expect(resolveLyrics({ plain: 'hello world', record }, { manual })).toMatchObject({ kind: 'synced', source: 'youtube-captions' });
    expect(resolveLyrics(null, { manual })).toMatchObject({ source: 'youtube-captions' });
  });

  it('falls back to the ASR transcript with word timing when nothing else exists', () => {
    const asr = { asr: true, cues: [{ start: 1, end: 9, text: 'hello world', words: [{ start: 1, text: 'hello' }, { start: 1.5, text: 'world' }] }, { start: 3, end: 5, text: 'again' }] };
    const l = resolveLyrics(null, { asr });
    expect(l).toMatchObject({ kind: 'synced', source: 'youtube-auto-captions', hasWordTiming: true });
    if (l?.kind !== 'synced') throw new Error('synced expected');
    // Overlapping ASR cue is cut at the next cue.
    expect(l.lines[0]).toMatchObject({ start: 1, end: 3, text: 'hello world' });
    expect(l.lines[0].words?.map((w) => w.text).join('')).toBe('hello world');
    // An ASR transcript beats plain LRCLIB lyrics.
    expect(resolveLyrics({ plain: 'la la', record }, { asr })).toMatchObject({ source: 'youtube-auto-captions' });
  });

  it('shows the picked track and aligns it only with ASR in the same language', () => {
    const asr = { asr: true, lang: 'en', cues: [{ start: 1, end: 3, text: 'hello world', words: [{ start: 1, text: 'hello' }, { start: 2, text: 'world' }] }] };
    const es = { asr: false, lang: 'es', cues: [{ start: 1, end: 3, text: 'hola mundo' }] };
    const l = resolveLyrics(null, { asr, display: es });
    expect(l).toMatchObject({ source: 'youtube-captions', hasWordTiming: false });
    if (l?.kind !== 'synced') throw new Error('synced expected');
    expect(l.lines[0].text).toBe('hola mundo');
  });

  it('falls back to plain lyrics, then null', () => {
    expect(resolveLyrics({ plain: 'la la', record }, {})).toEqual({ kind: 'plain', text: 'la la', source: 'lrclib' });
    expect(resolveLyrics(null, {})).toBeNull();
  });
});

const cap = (text: string, lang = 'en', asr = false) => ({ asr, lang, cues: [{ start: 1, end: 3, text }] });
const kindOf = (c: ReturnType<typeof chooseSource>) => (c.use === 'captions' ? `captions:${c.caption?.cues[0]?.text}` : c.use);

describe('chooseSource', () => {
  const synced = { synced: SYNCED, record };
  const plain = { plain: 'la la', record };
  const manual = cap('manual');
  const asr = cap('asr', 'en', true);
  const foreign = cap('foreign', 'es');

  it('follows the automatic order', () => {
    expect(kindOf(chooseSource(synced, { manual, asr }))).toBe('captions:manual');
    expect(kindOf(chooseSource(synced, { asr }))).toBe('lrclib-synced');
    expect(kindOf(chooseSource(null, { asr }))).toBe('captions:asr');
    expect(kindOf(chooseSource(plain, { asr }))).toBe('captions:asr');
    expect(kindOf(chooseSource(plain, {}))).toBe('lrclib-plain');
    expect(kindOf(chooseSource(synced, { other: foreign }))).toBe('lrclib-synced');
    expect(kindOf(chooseSource(null, { other: foreign }))).toBe('captions:foreign');
    expect(chooseSource(null, {}).use).toBeNull();
  });

  it('ranks a manual track in the preferred language as song captions', () => {
    expect(kindOf(chooseSource(synced, { asr, display: foreign }))).toBe('captions:foreign');
    // An ASR display is not song captions.
    expect(kindOf(chooseSource(synced, { display: asr }))).toBe('lrclib-synced');
  });

  it("honours the 'lrclib' pick", () => {
    expect(kindOf(chooseSource(synced, { manual }, 'lrclib'))).toBe('lrclib-synced');
    expect(kindOf(chooseSource(plain, { manual }, 'lrclib'))).toBe('lrclib-plain');
    expect(chooseSource(null, { manual }, 'lrclib')).toMatchObject({ use: 'captions', fellBack: 'lrclib' });
    expect(chooseSource(null, {}, 'lrclib')).toMatchObject({ use: null, fellBack: 'lrclib' });
  });

  it("honours the 'captions' pick", () => {
    const c = chooseSource(synced, { asr }, 'captions');
    expect(kindOf(c)).toBe('captions:asr');
    expect(c.fellBack).toBeUndefined();
    expect(chooseSource(synced, {}, 'captions')).toMatchObject({ use: 'lrclib-synced', fellBack: 'captions' });
  });

  it('treats a per-video language pick as captions even in auto mode', () => {
    expect(kindOf(chooseSource(synced, { asr, display: asr }, 'auto', true))).toBe('captions:asr');
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
    expect(d.fetchLyrics).toHaveBeenCalledWith({ videoId: 'v1', title: 'Song', artist: 'Band', duration: 200, alternates: [{ artist: 'Song', title: 'Band' }] });
    expect(s.states.map((x) => x.kind)).toEqual(['idle', 'idle', 'loading', 'ready']);
  });

  it('loads for hidden prefetch surfaces too', async () => {
    const d = deps();
    const c = new LyricsController('ytmusic', d);
    c.addSurface(Object.assign(new FakeSurface(), { active: false, prefetch: true }));
    c.setVideoId('v1');
    await flush();
    expect(d.fetchLyrics).toHaveBeenCalledTimes(1);
  });

  it('reload() fetches the video’s lyrics again', async () => {
    const d = deps();
    const c = new LyricsController('ytmusic', d);
    c.addSurface(Object.assign(new FakeSurface(), { active: true }));
    c.setVideoId('v1');
    await flush();
    expect(d.fetchLyrics).toHaveBeenCalledTimes(1);
    c.reload();
    await flush();
    expect(d.fetchLyrics).toHaveBeenCalledTimes(2);
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

  it('ticks with the presented time and seeks the video', async () => {
    const c = new LyricsController('youtube', { ...deps(), presentedTime: () => 4.75 });
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

  it('applies the video’s timing offset to the ticked time and to seeks', async () => {
    let offset = 500;
    const c = new LyricsController('youtube', { ...deps(), presentedTime: () => 4.75, offsetMs: (id) => (id === 'v' ? offset : 0) });
    const s = new FakeSurface();
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 5, writable: true });
    c.addSurface(s);
    c.setVideo(video);
    c.setVideoId('v');
    await flush();
    expect(s.times.at(-1)).toBeCloseTo(4.25);
    c.seek(42);
    expect(video.currentTime).toBeCloseTo(42.5);
    offset = -250;
    c.refresh();
    expect(s.times.at(-1)).toBeCloseTo(5);
  });

  it('falls back to currentTime without a presented time', async () => {
    const c = new LyricsController('youtube', { ...deps(), presentedTime: () => null });
    const s = new FakeSurface();
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 5, writable: true });
    c.addSurface(s);
    c.setVideo(video);
    c.setVideoId('v');
    await flush();
    expect(s.times.at(-1)).toBe(5);
  });

  it('keeps updating from the presented time after pause, then stops', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    try {
      let presented = 10;
      const c = new LyricsController('youtube', { ...deps(), presentedTime: () => presented });
      const s = new FakeSurface();
      const video = document.createElement('video');
      Object.defineProperty(video, 'currentTime', { value: 12, writable: true });
      Object.defineProperty(video, 'paused', { value: false, writable: true });
      c.addSurface(s);
      c.setVideo(video);
      c.setVideoId('v');
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      await vi.advanceTimersByTimeAsync(50);
      // Pause: currentTime froze at 12, but the picture plays on for another 0.5 s.
      (video as { paused: boolean }).paused = true;
      video.dispatchEvent(new Event('pause'));
      for (let i = 0; i < 30; i++) {
        presented += 1 / 60;
        await vi.advanceTimersByTimeAsync(17);
      }
      expect(s.times.at(-1)).toBeCloseTo(presented, 1);
      expect(s.times.at(-1)).toBeLessThan(12);
      // Frozen: the loop gives up.
      await vi.advanceTimersByTimeAsync(600);
      const n = s.times.length;
      await vi.advanceTimersByTimeAsync(200);
      expect(s.times.length).toBe(n);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the loop alive while frames are queued, even if the time sits still', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    try {
      let presented = 10;
      let busy = true;
      const c = new LyricsController('youtube', { ...deps(), presentedTime: () => presented, presentedBusy: () => busy });
      const s = new FakeSurface();
      const video = document.createElement('video');
      Object.defineProperty(video, 'currentTime', { value: 60, writable: true });
      Object.defineProperty(video, 'paused', { value: true, writable: true });
      c.addSurface(s);
      c.setVideo(video);
      c.setVideoId('v');
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      // Seek while paused: the old picture holds for 1 s before the first new frame is drawn.
      video.dispatchEvent(new Event('seeked'));
      await vi.advanceTimersByTimeAsync(1000);
      presented = 20;
      await vi.advanceTimersByTimeAsync(34);
      expect(s.times.at(-1)).toBeCloseTo(20);
      // Queue empty: the loop stops 250 ms after the time stopped moving.
      busy = false;
      await vi.advanceTimersByTimeAsync(600);
      const n = s.times.length;
      await vi.advanceTimersByTimeAsync(200);
      expect(s.times.length).toBe(n);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-aligns when the player loads captions later (CC turned on)', async () => {
    let notify!: (id: string) => void;
    let captions: string | null = null;
    const asrTrack = { baseUrl: 'u', languageCode: 'en', kind: 'asr' };
    const words = [
      { t: 6, w: 'hello' },
      { t: 6.5, w: 'world' },
      { t: 8, w: 'second' },
      { t: 8.4, w: 'line' },
    ];
    const d = deps({
      getPlayerInfo: vi.fn(async (id: string) => info(id, { captionTracks: [asrTrack] })),
      getTimedText: vi.fn(async () => captions),
      onCaptionsAvailable: (cb) => (notify = cb),
    });
    const c = new LyricsController('youtube', d);
    const s = new FakeSurface();
    c.addSurface(s);
    c.setVideoId('v1');
    await flush();
    const first = s.last;
    expect(first.kind === 'ready' && first.lyrics.kind === 'synced' && first.lyrics.offset).toBe(0);
    expect(d.fetchLyrics).toHaveBeenCalledTimes(1);

    captions = json3([...words, ...words.map((w) => ({ ...w, t: w.t + 0.05 })), ...words.map((w) => ({ ...w, t: w.t - 0.05 }))]);
    notify('other-video');
    await flush();
    expect(s.last).toBe(first);
    notify('v1');
    await flush();
    const st = s.last;
    expect(st.kind === 'ready' && st.lyrics.kind === 'synced' && Math.round(st.lyrics.offset)).toBe(5);
    expect(d.fetchLyrics).toHaveBeenCalledTimes(1); // no new LRCLIB request
  });

  const WORDS = [
    { t: 6, w: 'hello' },
    { t: 6.5, w: 'world' },
    { t: 8, w: 'second' },
    { t: 8.4, w: 'line' },
  ];
  const CAPTIONS = () => json3([...WORDS, ...WORDS.map((w) => ({ ...w, t: w.t + 0.05 })), ...WORDS.map((w) => ({ ...w, t: w.t - 0.05 }))]);
  const asrTrack = { baseUrl: 'u', languageCode: 'en', kind: 'asr' };
  const offsetOf = (st: LyricsState) => (st.kind === 'ready' && st.lyrics.kind === 'synced' ? Math.round(st.lyrics.offset) : null);

  it('does not lose a captions event that arrives while load() is running', async () => {
    let notify!: (id: string) => void;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let captions: string | null = null;
    const d = deps({
      getPlayerInfo: vi.fn(async (id: string) => info(id, { captionTracks: [asrTrack] })),
      fetchLyrics: vi.fn(async () => {
        await gate;
        return { synced: SYNCED, record };
      }),
      getTimedText: vi.fn(async () => captions),
      onCaptionsAvailable: (cb) => (notify = cb),
    });
    const c = new LyricsController('youtube', d);
    const s = new FakeSurface();
    c.addSurface(s);
    c.setVideoId('v1');
    await flush();
    captions = CAPTIONS(); // the player has the data now, our load() fetched before that
    notify('v1');
    await flush();
    release();
    await flush();
    await flush();
    expect(offsetOf(s.last)).toBe(5);
  });

  it('retries realign after CC turns on and stops after the first change', async () => {
    vi.useFakeTimers();
    try {
      let captions: string | null = null;
      const d = deps({
        getPlayerInfo: vi.fn(async (id: string) => info(id, { captionTracks: [asrTrack] })),
        getTimedText: vi.fn(async () => captions),
      });
      const c = new LyricsController('youtube', d);
      const s = new FakeSurface();
      c.addSurface(s);
      c.setVideoId('v1');
      await vi.advanceTimersByTimeAsync(0);
      expect(offsetOf(s.last)).toBe(0);
      const calls = () => (d.getTimedText as ReturnType<typeof vi.fn>).mock.calls.length;
      const base = calls();

      c.realignWithRetries();
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls()).toBe(base + 1); // +1 s: still no data
      expect(offsetOf(s.last)).toBe(0);
      captions = CAPTIONS();
      await vi.advanceTimersByTimeAsync(2000);
      expect(offsetOf(s.last)).toBe(5); // +3 s: aligned
      await vi.advanceTimersByTimeAsync(10000);
      expect(calls()).toBe(base + 2); // no +6 s attempt

      // Nothing ever comes (no captions served): three tries, then it stops.
      captions = null;
      c.setVideoId('v2');
      await vi.advanceTimersByTimeAsync(0);
      const b2 = calls();
      c.realignWithRetries();
      await vi.advanceTimersByTimeAsync(20000);
      expect(calls()).toBe(b2 + 3);

      // Video change cancels pending retries.
      const b3 = calls();
      c.realignWithRetries();
      c.setVideoId('v3');
      await vi.advanceTimersByTimeAsync(0);
      const b4 = calls();
      await vi.advanceTimersByTimeAsync(20000);
      expect(calls()).toBe(b4);
      expect(b4).toBeGreaterThanOrEqual(b3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows subtitles when LRCLIB has nothing, with a language menu that switches track', async () => {
    const tracks = [
      { baseUrl: 'u-asr', languageCode: 'en', kind: 'asr', name: 'English' },
      { baseUrl: 'u-en', languageCode: 'en', name: 'English' },
      { baseUrl: 'u-es', languageCode: 'es', name: 'Spanish' },
    ];
    const cue = (text: string) => JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: text }] }] });
    const bodies: Record<string, string> = { 'u-asr': cue('hello there'), 'u-en': cue('Hello there'), 'u-es': cue('Hola') };
    const d = deps({
      fetchLyrics: vi.fn(async () => null),
      getPlayerInfo: vi.fn(async (id: string) => info(id, { captionTracks: tracks })),
      getTimedText: vi.fn(async (_id: string, t: { baseUrl: string }) => bodies[t.baseUrl] ?? null),
    });
    const c = new LyricsController('youtube', d);
    const s = new FakeSurface();
    c.addSurface(s);
    c.setVideoId('v');
    await flush();
    expect(s.last).toMatchObject({ kind: 'ready', lyrics: { source: 'youtube-captions' }, captions: { selected: { index: 1 } } });
    if (s.last.kind !== 'ready') throw new Error('ready expected');
    expect(s.last.captions?.options.map((o) => o.label)).toEqual(['English (auto-generated)', 'English', 'Spanish']);

    c.selectCaptionTrack({ index: 2 });
    await flush();
    expect(s.last).toMatchObject({ kind: 'ready', captions: { selected: { index: 2 } } });
    if (s.last.kind !== 'ready' || s.last.lyrics.kind !== 'synced') throw new Error('synced expected');
    expect(s.last.lyrics.lines[0].text).toBe('Hola');

    // The picked language is preferred on the next video.
    c.setVideoId('w');
    await flush();
    expect(s.last).toMatchObject({ kind: 'ready', captions: { selected: { index: 2 } } });
  });

  it('has no language menu for LRCLIB lyrics', async () => {
    const tracks = [
      { baseUrl: 'a', languageCode: 'en', name: 'English' },
      { baseUrl: 'b', languageCode: 'es', name: 'Spanish' },
    ];
    const c = new LyricsController('youtube', deps({ getPlayerInfo: vi.fn(async (id: string) => info(id, { captionTracks: tracks })) }));
    const s = new FakeSurface();
    c.addSurface(s);
    c.setVideoId('v');
    await flush();
    expect(s.last).toMatchObject({ kind: 'ready', lyrics: { source: 'lrclib' } });
    expect(s.last.kind === 'ready' && s.last.captions).toBeFalsy();
  });
  describe('source pick and caption language', () => {
    const tracks = [
      { baseUrl: 'u-asr', languageCode: 'en', kind: 'asr', name: 'English', isTranslatable: true },
      { baseUrl: 'u-es', languageCode: 'es', name: 'Spanish' },
    ];
    const cue = (text: string) => JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: text }] }] });
    const make = (over: Partial<LyricsDeps> = {}) =>
      deps({
        getPlayerInfo: vi.fn(async (id: string) => info(id, { captionTracks: tracks })),
        getTimedText: vi.fn(async (_id: string, t: { baseUrl: string }) => cue(t.baseUrl)),
        ...over,
      });
    const srcOf = (st: LyricsState) => (st.kind === 'ready' ? st.lyrics.source : st.kind);

    it('switches source without a new LRCLIB request and keeps the pick on the next video', async () => {
      const d = make();
      const c = new LyricsController('youtube', d);
      const s = new FakeSurface();
      c.addSurface(s);
      c.setVideoId('v1');
      await flush();
      expect(srcOf(s.last)).toBe('lrclib');
      expect(s.last).toMatchObject({ sources: { pref: 'auto', available: { lrclib: true, captions: true } } });

      c.selectSource('captions');
      expect(s.last).toMatchObject({ sources: { pref: 'captions' } }); // shown before the realign finishes
      await flush();
      expect(srcOf(s.last)).toBe('youtube-auto-captions');
      expect(s.last).toMatchObject({ sources: { pref: 'captions' } });
      c.selectSource('lrclib');
      await flush();
      expect(srcOf(s.last)).toBe('lrclib');
      expect(d.fetchLyrics).toHaveBeenCalledTimes(1);

      c.selectSource('captions');
      await flush();
      c.setVideoId('v2');
      await flush();
      expect(srcOf(s.last)).toBe('youtube-auto-captions');
      expect(d.fetchLyrics).toHaveBeenCalledTimes(2);
    });

    it('falls back to the auto order and says so when the picked source is missing', async () => {
      const c = new LyricsController('youtube', make({ fetchLyrics: vi.fn(async () => null) }));
      const s = new FakeSurface();
      c.addSurface(s);
      c.setVideoId('v1');
      await flush();
      expect(s.last).toMatchObject({ sources: { available: { lrclib: false, captions: true } } });
      c.selectSource('lrclib');
      await flush();
      expect(s.last).toMatchObject({ lyrics: { source: 'youtube-auto-captions' }, sources: { pref: 'lrclib', fellBack: 'lrclib' } });
    });

    it('lists every track and fetches the picked one', async () => {
      const d = make({ fetchLyrics: vi.fn(async () => null) });
      const c = new LyricsController('youtube', d);
      const s = new FakeSurface();
      c.addSurface(s);
      c.setVideoId('v1');
      await flush();
      if (s.last.kind !== 'ready') throw new Error('ready expected');
      expect(s.last.captions?.options.map((o) => o.label)).toEqual(['English (auto-generated)', 'Spanish']);

      c.selectCaptionTrack({ index: 1 });
      await flush();
      expect(d.getTimedText).toHaveBeenCalledWith('v1', tracks[1]);
      expect(s.last).toMatchObject({ captions: { selected: { index: 1 } } });
      if (s.last.kind !== 'ready' || s.last.lyrics.kind !== 'synced') throw new Error('synced expected');
      expect(s.last.lyrics.lines[0].text).toBe('u-es');

      // The picked language is preferred on the next video.
      c.setVideoId('v2');
      await flush();
      expect(s.last).toMatchObject({ captions: { selected: { index: 1 } } });
    });

    it('falls back to the default track when the preferred language is missing on the next video', async () => {
      const enOnly = [{ baseUrl: 'u-en2', languageCode: 'en', name: 'English' }];
      const d = make({
        fetchLyrics: vi.fn(async () => null),
        getPlayerInfo: vi.fn(async (id: string) => info(id, id === 'v1' ? { captionTracks: tracks } : { captionTracks: enOnly })),
      });
      const c = new LyricsController('youtube', d);
      const s = new FakeSurface();
      c.addSurface(s);
      c.setVideoId('v1');
      await flush();
      c.selectCaptionTrack({ index: 1 });
      await flush();
      c.setVideoId('v2');
      await flush();
      if (s.last.kind !== 'ready' || s.last.lyrics.kind !== 'synced') throw new Error('synced expected');
      expect(s.last.lyrics.lines[0].text).toBe('u-en2');
    });

    it('keeps a language pick on captions even when LRCLIB has synced lyrics', async () => {
      const c = new LyricsController('youtube', make());
      const s = new FakeSurface();
      c.addSurface(s);
      c.setVideoId('v1');
      await flush();
      c.selectCaptionTrack({ index: 1 });
      await flush();
      expect(s.last).toMatchObject({ lyrics: { source: 'youtube-captions' }, captions: { selected: { index: 1 } } });
    });
  });
});
