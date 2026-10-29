import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LYRICS_PREFS } from '../shared/lyrics-prefs';
import { EXPORT_SAMPLE_RATE, defaultExportOptions, type ExportProgress } from '../shared/export';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { StemSlice } from './mix';

const capture = vi.hoisted(() => ({ openCapture: vi.fn() }));
vi.mock('./capture', async (orig) => ({ ...(await orig<typeof import('./capture')>()), openCapture: capture.openCapture }));

import { runPreload, type AudioTap } from './engine';
import type { OpenMlSession } from './ml-session';

const DUR = 40; // s → 3 chunks of 13.3 s

/** The parts of an HTMLVideoElement the engine touches. */
function fakeVideo(over: Record<string, unknown> = {}) {
  const v = Object.assign(new EventTarget(), {
    duration: DUR,
    currentSrc: 'blob:video',
    currentTime: 12,
    paused: false,
    muted: false,
    playbackRate: 1,
    seeking: false,
    ended: false,
    pause: vi.fn(() => void (v.paused = true)),
    play: vi.fn(async () => void (v.paused = false)),
    ...over,
  });
  return v;
}

/** Separator that returns what it is given, with the slice bookkeeping of the real one. */
function passthroughSession() {
  let start = 0;
  const pushed: number[] = [];
  return {
    pushed,
    open: (async () => ({
      adapter: 'fake',
      dispose: vi.fn(),
      separator: {
        backlog: 0,
        push: async (l: Float32Array, r: Float32Array): Promise<StemSlice | null> => {
          pushed.push(l.length);
          const s = { start, length: l.length, dry: [l, r] as [Float32Array, Float32Array] } as StemSlice;
          start += l.length;
          return s;
        },
        finish: async () => null,
      },
    })) as unknown as OpenMlSession,
  };
}

const sound = (n: number): { l: Float32Array; r: Float32Array } => ({ l: Float32Array.from({ length: n }, (_, i) => (i % 1000) / 1000), r: Float32Array.from({ length: n }, (_, i) => -(i % 1000) / 1000) });

function tapOf(pcm: ReturnType<typeof sound> | null, duration = DUR): AudioTap & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    status: async () => {
      calls.push('status');
      return pcm ? { usable: true, mime: 'audio/webm', covered: [[0, duration]], incomplete: [], bytes: 1 } : null;
    },
    take: async () => {
      calls.push('take');
      return pcm ? { mime: 'audio/webm', data: new ArrayBuffer(8) } : null;
    },
  };
}

const options = () => ({ ...defaultExportOptions(DEFAULT_SETTINGS, DEFAULT_LYRICS_PREFS), tracks: 'separate' as const });

// decodeAudioData is the browser's: the engine reaches it through fastAudio, so give it a context that "decodes" our test sound.
function stubDecoder(pcm: ReturnType<typeof sound>, seconds = DUR) {
  vi.stubGlobal(
    'OfflineAudioContext',
    class {
      async decodeAudioData() {
        return { duration: seconds, numberOfChannels: 2, getChannelData: (c: number) => (c === 0 ? pcm.l : pcm.r) };
      }
    },
  );
}

beforeEach(() => {
  capture.openCapture.mockReset();
  vi.unstubAllGlobals();
});

describe('runPreload with the audio the player already downloaded', () => {
  it('feeds the whole sound to the separator without recording, then gives the video back', async () => {
    const pcm = sound(DUR * EXPORT_SAMPLE_RATE);
    stubDecoder(pcm);
    const v = fakeVideo();
    const session = passthroughSession();
    const slices: StemSlice[] = [];
    const reports: ExportProgress[] = [];
    await runPreload(
      { video: v as unknown as HTMLVideoElement, options: options(), lyrics: null, title: '', signal: new AbortController().signal, report: (p) => reports.push(p), tap: tapOf(pcm), openSession: session.open },
      (s) => void slices.push(s),
    );
    expect(capture.openCapture).not.toHaveBeenCalled();
    // every sample arrives once, in order, in chunks of at most 15 s
    expect(session.pushed.reduce((a, b) => a + b, 0)).toBe(DUR * EXPORT_SAMPLE_RATE);
    expect(Math.max(...session.pushed)).toBeLessThanOrEqual(15 * EXPORT_SAMPLE_RATE);
    expect(slices.map((s) => s.start)).toEqual(slices.map((_, i) => slices.slice(0, i).reduce((a, s) => a + s.length, 0)));
    const got = new Float32Array(DUR * EXPORT_SAMPLE_RATE);
    for (const s of slices) got.set(s.dry[0], s.start);
    expect(got.every((x, i) => x === pcm.l[i])).toBe(true);
    // the video is where the user had it, playing and not muted
    expect(v.muted).toBe(false);
    expect(v.currentTime).toBe(12);
    expect(v.paused).toBe(false);
    expect(reports.map((r) => r.stage)).toContain('fetching');
    expect(reports.some((r) => r.stage === 'recording')).toBe(true);
  });

  it('puts a video that was paused back paused', async () => {
    const pcm = sound(DUR * EXPORT_SAMPLE_RATE);
    stubDecoder(pcm);
    const v = fakeVideo({ paused: true, currentTime: 7 });
    await runPreload({ video: v as unknown as HTMLVideoElement, options: options(), lyrics: null, title: '', signal: new AbortController().signal, report: () => {}, tap: tapOf(pcm), openSession: passthroughSession().open }, () => {});
    expect(v.play).not.toHaveBeenCalled();
    expect(v.currentTime).toBe(7);
  });

  it('records when the tap has nothing (the way it always worked)', async () => {
    capture.openCapture.mockImplementation(() => {
      throw new Error('recording path taken');
    });
    const v = fakeVideo({ currentTime: 0 });
    await expect(
      runPreload({ video: v as unknown as HTMLVideoElement, options: options(), lyrics: null, title: '', signal: new AbortController().signal, report: () => {}, tap: tapOf(null), openSession: passthroughSession().open }, () => {}),
    ).rejects.toThrow('recording path taken');
    expect(capture.openCapture).toHaveBeenCalledTimes(1);
  });

  it('records when no tap is given (other sites, or debug.noFastAudio)', async () => {
    capture.openCapture.mockImplementation(() => {
      throw new Error('recording path taken');
    });
    const v = fakeVideo({ currentTime: 0 });
    await expect(runPreload({ video: v as unknown as HTMLVideoElement, options: options(), lyrics: null, title: '', signal: new AbortController().signal, report: () => {}, openSession: passthroughSession().open }, () => {})).rejects.toThrow('recording path taken');
  });

  it('records when the decoded sound does not fit the video', async () => {
    capture.openCapture.mockImplementation(() => {
      throw new Error('recording path taken');
    });
    const pcm = sound(20 * EXPORT_SAMPLE_RATE);
    stubDecoder(pcm, 20);
    const v = fakeVideo({ currentTime: 0 });
    await expect(
      runPreload({ video: v as unknown as HTMLVideoElement, options: options(), lyrics: null, title: '', signal: new AbortController().signal, report: () => {}, tap: tapOf(pcm), openSession: passthroughSession().open }, () => {}),
    ).rejects.toThrow('recording path taken');
  });

  it('a cancel while the model works ends the run and still gives the video back', async () => {
    const pcm = sound(DUR * EXPORT_SAMPLE_RATE);
    stubDecoder(pcm);
    const v = fakeVideo();
    const ac = new AbortController();
    await expect(
      runPreload(
        { video: v as unknown as HTMLVideoElement, options: options(), lyrics: null, title: '', signal: ac.signal, report: () => {}, tap: tapOf(pcm), openSession: passthroughSession().open },
        () => void ac.abort(),
      ),
    ).rejects.toThrow('Export cancelled');
    expect(v.paused).toBe(false);
    expect(v.muted).toBe(false);
  });

  it('waits for a slow model instead of piling up chunks', async () => {
    const pcm = sound(DUR * EXPORT_SAMPLE_RATE);
    stubDecoder(pcm);
    const v = fakeVideo();
    const slow = passthroughSession();
    let inflight = 0;
    let maxInflight = 0;
    const open = (async () => {
      const s = (await slow.open(DEFAULT_SETTINGS, new AbortController().signal)) as unknown as { separator: { push: (l: Float32Array, r: Float32Array) => Promise<StemSlice | null> } };
      const push = s.separator.push;
      s.separator.push = async (l, r) => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((res) => setTimeout(res, 20));
        inflight--;
        return push(l, r);
      };
      return s;
    }) as unknown as OpenMlSession;
    await runPreload({ video: v as unknown as HTMLVideoElement, options: options(), lyrics: null, title: '', signal: new AbortController().signal, report: () => {}, tap: tapOf(pcm), openSession: open }, () => {});
    expect(maxInflight).toBe(1);
    expect(slow.pushed.reduce((a, b) => a + b, 0)).toBe(DUR * EXPORT_SAMPLE_RATE);
  });
});
