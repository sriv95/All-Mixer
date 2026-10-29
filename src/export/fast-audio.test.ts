import { describe, expect, it, vi } from 'vitest';
import type { TapData, TapStatus } from '../shared/bridge';
import { fastAudio, firstHole, type AudioTap } from './fast-audio';

const status = (covered: [number, number][], incomplete: number[] = []) => ({ covered, incomplete });

describe('firstHole', () => {
  it('whole audio: no hole, also when the track ends a little before the video', () => {
    expect(firstHole(status([[0, 100]]), 100)).toBeNull();
    expect(firstHole(status([[0, 99.8]]), 100)).toBeNull();
  });
  it('the end of the range that starts at 0 is the first hole', () => {
    expect(firstHole(status([[0, 30], [60, 100]]), 100)).toBe(30);
    expect(firstHole(status([[20, 100]]), 100)).toBe(0);
    expect(firstHole(status([]), 100)).toBe(0);
  });
  it('small gaps between ranges are not holes', () => {
    expect(firstHole(status([[0, 30], [30.2, 100]]), 100)).toBeNull();
  });
  it('a cluster that was cut short counts even inside a covered range, the earlier hole wins', () => {
    expect(firstHole(status([[0, 100]], [40]), 100)).toBe(40);
    expect(firstHole(status([[0, 30]], [40]), 100)).toBe(30);
  });
});

/** A player that fetches `chunk` seconds from wherever it is asked to seek. */
function fakePlayer(dur: number, opts: { chunk?: number; stuckAt?: number; usable?: boolean; decodedDur?: number; badAt?: number } = {}) {
  const chunk = opts.chunk ?? 40;
  const covered: [number, number][] = [[0, Math.min(chunk, dur)]];
  const seeks: number[] = [];
  const merge = () => {
    covered.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i + 1 < covered.length; ) {
      if (covered[i + 1]![0] <= covered[i]![1] + 0.05) {
        covered[i]![1] = Math.max(covered[i]![1], covered[i + 1]![1]);
        covered.splice(i + 1, 1);
      } else i++;
    }
  };
  const video = {
    duration: dur,
    currentSrc: 'blob:x',
    muted: false,
    paused: false,
    pause: vi.fn(() => void (video.paused = true)),
    set currentTime(t: number) {
      seeks.push(t);
      if (opts.stuckAt !== undefined && t >= opts.stuckAt - 1) return; // the player brings nothing here
      covered.push([t, Math.min(dur, t + chunk)]);
      merge();
    },
    get currentTime() {
      return seeks.at(-1) ?? 0;
    },
  };
  const tap: AudioTap = {
    status: vi.fn(async (): Promise<TapStatus | null> => ({ usable: opts.usable ?? true, mime: 'audio/webm', covered: covered.map((c) => [...c] as [number, number]), incomplete: [], bytes: 1 })),
    take: vi.fn(async (): Promise<TapData | null> => ({ mime: 'audio/webm', data: new ArrayBuffer(8) })),
  };
  const decode = vi.fn(async () => ({ duration: opts.decodedDur ?? dur, channels: [new Float32Array(4).fill(0.5), new Float32Array(4).fill(-0.5)] }));
  return { video: video as unknown as HTMLVideoElement, tap, decode, seeks, covered };
}

const run = (p: ReturnType<typeof fakePlayer>, extra: Partial<Parameters<typeof fastAudio>[0]> = {}) =>
  fastAudio({ video: p.video, tap: p.tap, signal: new AbortController().signal, progress: () => {}, decode: p.decode, sleep: async () => {}, ...extra });

describe('fastAudio', () => {
  it('seeks to the first hole until the player has brought the whole audio, then decodes it', async () => {
    const p = fakePlayer(200, { chunk: 60 });
    const progress = vi.fn();
    const pcm = await run(p, { progress });
    expect(pcm?.l[0]).toBe(0.5);
    expect(pcm?.r[0]).toBe(-0.5);
    // each seek lands a little before the hole
    expect(p.seeks.length).toBeGreaterThanOrEqual(3);
    expect(p.seeks[0]).toBeCloseTo(59.7, 1);
    expect(progress.mock.calls.at(-1)![0]).toBe(1);
    expect(p.video.pause).toHaveBeenCalled();
    expect(p.video.muted).toBe(true);
  });

  it('a mono track is used for both channels', async () => {
    const p = fakePlayer(30);
    p.decode.mockResolvedValue({ duration: 30, channels: [new Float32Array(4).fill(0.25)] });
    const pcm = await run(p);
    expect(pcm?.r).toBe(pcm?.l);
  });

  it('a short video that is already whole needs no seek', async () => {
    const p = fakePlayer(20, { chunk: 60 });
    expect(await run(p)).not.toBeNull();
    expect(p.seeks).toEqual([]);
  });

  it.each([
    ['no tap on this source', (p: ReturnType<typeof fakePlayer>) => vi.mocked(p.tap.status).mockResolvedValue(null)],
    ['a tap that cannot be used (an MP4 track, too long)', (p: ReturnType<typeof fakePlayer>) => (p.tap.status = vi.fn(async () => ({ usable: false, mime: 'audio/mp4', covered: [], incomplete: [], bytes: 0 })))],
    ['nothing to take', (p: ReturnType<typeof fakePlayer>) => vi.mocked(p.tap.take).mockResolvedValue(null)],
    ['a decoder that throws', (p: ReturnType<typeof fakePlayer>) => p.decode.mockRejectedValue(new Error('bad data'))],
    ['a decoded sound that is too short (a segment is missing)', (p: ReturnType<typeof fakePlayer>) => p.decode.mockResolvedValue({ duration: 150, channels: [new Float32Array(1)] })],
    ['a decoded sound that is too long (another timeline in it)', (p: ReturnType<typeof fakePlayer>) => p.decode.mockResolvedValue({ duration: 260, channels: [new Float32Array(1)] })],
    ['a decoded sound without channels', (p: ReturnType<typeof fakePlayer>) => p.decode.mockResolvedValue({ duration: 200, channels: [] })],
  ])('returns null (the caller records) for %s', async (_n, arrange) => {
    const p = fakePlayer(200);
    arrange(p);
    expect(await run(p)).toBeNull();
  });

  it('gives up when the player brings nothing new for a hole, after a few tries', async () => {
    const p = fakePlayer(200, { chunk: 40, stuckAt: 100 });
    const sleeps: number[] = [];
    // each wait is a few polls; the stall timer is real time, so let the fake clock move
    let now = 0;
    const date = vi.spyOn(Date, 'now').mockImplementation(() => now);
    expect(await run(p, { sleep: async (ms) => void ((now += ms * 20), sleeps.push(ms)) })).toBeNull();
    date.mockRestore();
    expect(p.seeks.filter((t) => t > 90).length).toBe(3);
  });

  it('does nothing for a video that is too long to decode at once, or has no fixed length', async () => {
    for (const dur of [4000, Infinity, 0]) {
      const p = fakePlayer(dur === Infinity || dur === 0 ? dur : dur);
      expect(await run(p)).toBeNull();
      expect(p.video.pause).not.toHaveBeenCalled();
    }
  });

  it('stops quietly when the run is cancelled', async () => {
    const p = fakePlayer(200);
    const ac = new AbortController();
    const seen: number[] = [];
    const pcm = await run(p, { signal: ac.signal, progress: (f) => (seen.push(f), ac.abort()) });
    expect(pcm).toBeNull();
    expect(p.tap.take).not.toHaveBeenCalled();
  });

  it('an ad that starts while reading ends the run with its reason', async () => {
    const p = fakePlayer(200);
    await expect(run(p, { problem: () => 'An ad interrupted the recording.' })).rejects.toThrow('An ad interrupted');
  });
});
