import { beforeAll, describe, expect, it, vi } from 'vitest';
import { cluster, initSegment } from './webm-fixture';

// happy-dom has no Media Source Extensions: the smallest stand-ins the hooks need.
class FakeBuffer extends EventTarget {
  timestampOffset = 0;
  ranges: [number, number][] = [];
  appended: Uint8Array[] = [];
  calls = 0;
  get buffered() {
    const r = this.ranges;
    return { length: r.length, start: (i: number) => r[i]![0], end: (i: number) => r[i]![1] };
  }
  appendBuffer(d: ArrayBuffer | ArrayBufferView) {
    this.calls++;
    try {
      this.appended.push(ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d));
    } catch {
      /* a buffer whose memory is gone: the real player's would throw too, the test only counts the call */
    }
  }
}
class FakeSource extends EventTarget {
  readyState = 'open';
  addSourceBuffer() {
    return new FakeBuffer();
  }
}

let urlCounter = 0;
const g = globalThis as unknown as Record<string, unknown>;
g.MediaSource = FakeSource;
g.SourceBuffer = FakeBuffer;
URL.createObjectURL = vi.fn(() => `blob:fake-${++urlCounter}`);

const { installAudioTap, tapStatus, tapTake } = await import('./audio-tap');

beforeAll(() => installAudioTap());

const open = (mime = 'audio/webm; codecs="opus"') => {
  const ms = new FakeSource() as unknown as MediaSource;
  const url = URL.createObjectURL(ms);
  const sb = ms.addSourceBuffer(mime) as unknown as FakeBuffer;
  return { ms, url, sb };
};
const done = (sb: FakeBuffer, ...r: [number, number][]) => {
  sb.ranges = r;
  sb.dispatchEvent(new Event('updateend'));
};

describe('installAudioTap', () => {
  it('copies what the player appends, still passes every byte on, and reports what was buffered', () => {
    const { url, sb } = open();
    const c0 = cluster(0, 200);
    sb.appendBuffer(initSegment());
    sb.appendBuffer(c0.slice(0, 90));
    sb.appendBuffer(c0.slice(90));
    done(sb, [0, 10]);
    expect(sb.appended.map((a) => a.length)).toEqual([initSegment().length, 90, c0.length - 90]); // the player got all of it
    const st = tapStatus(url)!;
    expect(st).toMatchObject({ usable: true, covered: [[0, 10]], incomplete: [], mime: 'audio/webm; codecs="opus"' });
    const file = new Uint8Array(tapTake(url)!.data);
    expect(file.length).toBe(initSegment().length + c0.length);
  });

  it('keeps what was buffered once even after the player evicts it', () => {
    const { url, sb } = open();
    sb.appendBuffer(initSegment());
    sb.appendBuffer(cluster(0));
    done(sb, [0, 10]);
    sb.appendBuffer(cluster(10_000));
    done(sb, [10, 20]); // the player removed [0, 10) meanwhile
    expect(tapStatus(url)!.covered).toEqual([[0, 20]]);
  });

  it('has nothing for another source, and ignores video buffers', () => {
    const a = open();
    expect(tapStatus('blob:other')).toBeNull();
    const video = a.ms.addSourceBuffer('video/mp4; codecs="av01"') as unknown as FakeBuffer;
    video.appendBuffer(new Uint8Array([1, 2, 3]));
    expect(tapStatus(a.url)).toMatchObject({ mime: 'audio/webm; codecs="opus"' });
  });

  it('an AAC (mp4) track is not read; the player still plays it', () => {
    const { url, sb } = open('audio/mp4; codecs="mp4a.40.2"');
    sb.appendBuffer(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]));
    expect(tapStatus(url)).toMatchObject({ usable: false, reason: expect.stringMatching(/not read/) });
    expect(tapTake(url)).toBeNull();
    expect(sb.appended).toHaveLength(1);
  });

  it('a shifted timeline (an ad in the same source) makes the copy unusable', () => {
    const { url, sb } = open();
    sb.appendBuffer(initSegment());
    sb.timestampOffset = 30;
    sb.appendBuffer(cluster(0));
    expect(tapStatus(url)).toMatchObject({ usable: false, reason: 'the audio is shifted in time' });
    expect(sb.appended).toHaveLength(2);
  });

  it('a failing copy never keeps the bytes from the player', () => {
    const { url, sb } = open();
    const bad = new Uint8Array(3);
    Object.defineProperty(bad, 'buffer', { get: () => { throw new Error('detached'); } });
    expect(() => sb.appendBuffer(bad)).not.toThrow();
    expect(sb.calls).toBe(1);
    expect(tapStatus(url)).toMatchObject({ usable: false, reason: expect.stringMatching(/copy failed/) });
  });

  it('drops the tap when the source closes, and keeps only the newest few', () => {
    const { ms, url } = open();
    ms.dispatchEvent(new Event('sourceclose'));
    expect(tapStatus(url)).toBeNull();
    const urls = Array.from({ length: 6 }, () => open().url);
    expect(tapStatus(urls[0]!)).toBeNull();
    expect(tapStatus(urls[5]!)).not.toBeNull();
  });
});
