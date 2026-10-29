import { describe, expect, it } from 'vitest';
import { cluster, el, initSegment } from './webm-fixture';
import { clusterHead, readId, readSize, startsWithId, timecodeScaleNs, CLUSTER_ID, EBML_ID } from './webm';

describe('EBML numbers', () => {
  it('reads ids with their marker bits and sizes without', () => {
    expect(readId(Uint8Array.of(0x1f, 0x43, 0xb6, 0x75), 0)).toEqual([CLUSTER_ID, 4]);
    expect(readId(Uint8Array.of(0xe7), 0)).toEqual([0xe7, 1]);
    expect(readSize(Uint8Array.of(0x82), 0)).toEqual([2, 1]);
    expect(readSize(Uint8Array.of(0x10, 0, 1, 0), 0)).toEqual([256, 4]);
  });
  it('an all-ones size is unknown; a zero first byte or a cut-off number is not a number', () => {
    expect(readSize(Uint8Array.of(0xff), 0)).toEqual([null, 1]);
    expect(readSize(Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), 0)).toEqual([null, 8]);
    expect(readId(Uint8Array.of(0), 0)).toBeNull();
    expect(readId(Uint8Array.of(0x1f, 0x43), 0)).toBeNull();
    expect(readSize(Uint8Array.of(0x10, 0), 0)).toBeNull();
  });
  it('tells an init segment from a Cluster', () => {
    expect(startsWithId(initSegment(), EBML_ID)).toBe(true);
    expect(startsWithId(cluster(0), CLUSTER_ID)).toBe(true);
    expect(startsWithId(cluster(0), EBML_ID)).toBe(false);
  });
});

describe('clusterHead', () => {
  it('gives the timecode and the whole size', () => {
    const c = cluster(5000, 40);
    expect(clusterHead(c)).toEqual({ timecode: 5000, total: c.length });
  });
  it('skips a Void before the Timecode', () => {
    const c = Uint8Array.from(el([0x1f, 0x43, 0xb6, 0x75], [0xec, 0x82, 0, 0, 0xe7, 0x81, 9]));
    expect(clusterHead(c)).toEqual({ timecode: 9, total: c.length });
  });
  it('an unknown size has no total', () => {
    const c = Uint8Array.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7, 0x81, 3]);
    expect(clusterHead(c)).toEqual({ timecode: 3, total: null });
  });
  it('is null when the header is cut or it is not a Cluster', () => {
    expect(clusterHead(cluster(1).subarray(0, 6))).toBeNull();
    expect(clusterHead(initSegment())).toBeNull();
  });
});

describe('timecodeScaleNs', () => {
  it('reads the scale of the init segment, and falls back to milliseconds', () => {
    expect(timecodeScaleNs(initSegment(1_000_000))).toBe(1_000_000);
    expect(timecodeScaleNs(initSegment(500_000))).toBe(500_000);
    expect(timecodeScaleNs(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3))).toBe(1_000_000);
  });
});
