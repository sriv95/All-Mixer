import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { PreloadPlayer } from './preload-player';
import { StemCache, stemLevels } from './stem-cache';

// Web Audio is not in happy-dom: minimal stand-ins that record what the player schedules.
class FakeBuffer {
  data = [new Float32Array(0), new Float32Array(0)];
  length: number;
  constructor(o: { length: number }) {
    this.length = o.length;
    this.data = [new Float32Array(o.length), new Float32Array(o.length)];
  }
  copyToChannel(src: Float32Array, ch: number, at: number) {
    this.data[ch].set(src, at);
  }
}
const sources: { buffer: FakeBuffer; started?: [number, number]; stopped: boolean }[] = [];
class FakeSource {
  rec: (typeof sources)[number];
  constructor(_ctx: unknown, o: { buffer: FakeBuffer }) {
    this.rec = { buffer: o.buffer, stopped: false };
    sources.push(this.rec);
  }
  connect() {}
  disconnect() {}
  start(when: number, at: number) {
    this.rec.started = [when, at];
  }
  stop() {
    this.rec.stopped = true;
  }
}
class FakeGain {
  gain = { setTargetAtTime: vi.fn() };
  connect() {}
  disconnect() {}
}
class FakeAnalyser {
  fftSize: number;
  constructor(_c: unknown, o: { fftSize: number }) {
    this.fftSize = o.fftSize;
  }
  getFloatTimeDomainData(a: Float32Array) {
    a.fill(0);
    a[3] = -0.25;
  }
}

const ctx = Object.assign(new EventTarget(), { state: 'running', currentTime: 10 }) as unknown as AudioContext & { state: string; currentTime: number };
function video(over: { duration?: number; playbackRate?: number } = {}) {
  const v = Object.assign(document.createElement('video'), { currentTime: 5, playbackRate: over.playbackRate ?? 1 });
  Object.defineProperty(v, 'duration', { value: over.duration ?? 100, configurable: true });
  return v as HTMLVideoElement;
}
const live = (v: HTMLVideoElement) => {
  Object.defineProperties(v, { paused: { value: false, configurable: true }, readyState: { value: 4, configurable: true }, seeking: { value: false, configurable: true } });
  return v;
};

beforeEach(() => {
  vi.useFakeTimers();
  sources.length = 0;
  ctx.state = 'running';
  ctx.currentTime = 10;
  vi.stubGlobal('AudioBuffer', FakeBuffer);
  vi.stubGlobal('AudioBufferSourceNode', FakeSource);
  vi.stubGlobal('GainNode', FakeGain);
  vi.stubGlobal('AnalyserNode', FakeAnalyser);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const cache = () => new StemCache('abc', 'mdx:vocals,instrumental', 100, ['vocals', 'instrumental']);

describe('StemCache', () => {
  it('holds one stereo buffer per stem at the length of the video and fills it slice by slice', () => {
    const c = cache();
    expect(c.buffers.get('vocals')!.length).toBe(4_410_000);
    expect(c.bytes).toBe(2 * 4_410_000 * 8);
    c.add({ vocals: [Float32Array.of(1, 2), Float32Array.of(3, 4)], instrumental: [Float32Array.of(5, 6), Float32Array.of(7, 8)] }, 10);
    const v = c.buffers.get('vocals') as unknown as FakeBuffer;
    expect([...v.data[0].subarray(10, 12)]).toEqual([1, 2]);
    expect([...v.data[1].subarray(10, 12)]).toEqual([3, 4]);
  });
});

describe('stemLevels', () => {
  it('is the live formula: the vocal gain, and the instrumental gain on each other stem', () => {
    const s = { ...DEFAULT_SETTINGS, vocalPct: 40, instrumentalPct: 50, drumsPct: 20, othersPct: 80, splitInstrumental: true };
    expect(stemLevels(s, ['vocals', 'drums', 'others'])).toEqual({ vocals: 0.4, drums: 0.5 * 0.2, others: 0.5 * 0.8 });
    expect(stemLevels({ ...DEFAULT_SETTINGS, instrumentalPct: 30 }, ['instrumental'])).toEqual({ instrumental: 0.3 });
  });
});

describe('PreloadPlayer', () => {
  it('starts every stem at the position of the video, a little ahead of now, and stops on pause', () => {
    const v = live(video());
    const p = new PreloadPlayer(ctx, {} as AudioNode, v, cache());
    p.setActive(true);
    expect(sources).toHaveLength(2);
    for (const s of sources) expect(s.started).toEqual([10.02, 5.02]);
    expect(p.playing).toBe(true);
    Object.defineProperty(v, 'paused', { value: true, configurable: true });
    v.dispatchEvent(new Event('pause'));
    expect(sources.every((s) => s.stopped)).toBe(true);
    expect(p.playing).toBe(false);
    p.dispose();
  });

  it('plays nothing while inactive, while the context is suspended, or at another speed', () => {
    const v = live(video());
    const p = new PreloadPlayer(ctx, {} as AudioNode, v, cache());
    expect(sources).toHaveLength(0);
    ctx.state = 'suspended';
    p.setActive(true);
    expect(sources).toHaveLength(0);
    ctx.state = 'running';
    v.playbackRate = 1.5;
    v.dispatchEvent(new Event('ratechange'));
    expect(sources).toHaveLength(0);
    v.playbackRate = 1;
    v.dispatchEvent(new Event('ratechange'));
    expect(sources).toHaveLength(2);
    p.dispose();
  });

  it('restarts at the video position after a seek, and when the clocks drift apart', () => {
    const v = live(video());
    const p = new PreloadPlayer(ctx, {} as AudioNode, v, cache());
    p.setActive(true);
    v.currentTime = 40;
    v.dispatchEvent(new Event('seeked'));
    expect(sources.at(-1)!.started![1]).toBeCloseTo(40.02);
    const n = sources.length;
    ctx.currentTime = 11; // one second later: the cache is at 41.02, the video at 40 + 0.5
    v.currentTime = 40.5;
    vi.advanceTimersByTime(500);
    expect(sources.length).toBe(n + 2);
    expect(p.driftMs()).toBeCloseTo(0, 0); // restarted at the video position
    p.dispose();
  });

  it('reports the peak of what it plays', () => {
    const p = new PreloadPlayer(ctx, {} as AudioNode, live(video()), cache());
    expect(p.level()).toBe(0.25);
    p.dispose();
  });

  it('fits a video of the same id and length at 1× only (an ad is another length)', () => {
    const c = cache();
    expect(PreloadPlayer.fits(c, video({ duration: 100.2 }), 'abc')).toBe(true);
    expect(PreloadPlayer.fits(c, video({ duration: 15 }), 'abc')).toBe(false);
    expect(PreloadPlayer.fits(c, video({ duration: 100, playbackRate: 2 }), 'abc')).toBe(false);
    expect(PreloadPlayer.fits(c, video({ duration: 100 }), 'other')).toBe(false);
  });
});
