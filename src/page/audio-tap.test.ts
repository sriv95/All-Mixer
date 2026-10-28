import { describe, expect, it } from 'vitest';
import { ClusterStore, Coverage } from './audio-tap';
import { cluster, initSegment } from './webm-fixture';

/** The player appends a segment in pieces of arbitrary size. */
const pieces = (b: Uint8Array, ...cuts: number[]): Uint8Array[] => {
  const out: Uint8Array[] = [];
  let at = 0;
  for (const c of [...cuts, b.length]) {
    out.push(b.slice(at, c));
    at = c;
  }
  return out;
};
const feed = (s: ClusterStore, ...bs: Uint8Array[]) => bs.forEach((b) => s.push(b));
const same = (a: Uint8Array | null, b: Uint8Array) => a !== null && a.length === b.length && a.every((v, i) => v === b[i]);
const join = (...bs: Uint8Array[]) => Uint8Array.from(bs.flatMap((b) => [...b]));

describe('ClusterStore', () => {
  it('keeps the init segment and the clusters in time order, whatever the order they were appended in', () => {
    const s = new ClusterStore();
    const [i, c0, c1, c2] = [initSegment(), cluster(0), cluster(10_000), cluster(20_000)];
    feed(s, i, c2, c0, c1); // a seek brought the last one first
    expect(same(s.file(), join(i, c0, c1, c2))).toBe(true);
    expect(s.incomplete()).toEqual([]);
  });

  it('puts the pieces of a cluster together', () => {
    const s = new ClusterStore();
    const c = cluster(0, 300);
    feed(s, initSegment(), ...pieces(c, 120, 200));
    expect(same(s.file(), join(initSegment(), c))).toBe(true);
  });

  it('a second copy of a cluster (the player fetched it again after a seek) is not kept twice', () => {
    const s = new ClusterStore();
    const c = cluster(0, 300);
    feed(s, initSegment(), ...pieces(c, 100), ...pieces(c, 100));
    expect(same(s.file(), join(initSegment(), c))).toBe(true);
    expect(s.bytes).toBe(initSegment().length + c.length);
  });

  it('a cluster cut short by a seek is reported, and the full copy that follows replaces it', () => {
    const s = new ClusterStore();
    const c = cluster(10_000, 300);
    feed(s, initSegment(), c.slice(0, 150));
    expect(s.incomplete()).toEqual([10]);
    feed(s, cluster(20_000), ...pieces(c, 100));
    expect(s.incomplete()).toEqual([]);
    expect(same(s.file(), join(initSegment(), c, cluster(20_000)))).toBe(true);
  });

  it('a new cluster after a cut one starts its own group (the cut bytes do not swallow it)', () => {
    const s = new ClusterStore();
    const next = cluster(20_000, 50);
    feed(s, initSegment(), cluster(10_000, 300).slice(0, 150), next);
    expect(s.incomplete()).toEqual([10]);
    expect(same(s.file(), join(initSegment(), cluster(10_000, 300).slice(0, 150), next))).toBe(true);
  });

  it('two clusters in one append are two clusters', () => {
    const s = new ClusterStore();
    const [a, b] = [cluster(0, 30), cluster(10_000, 30)];
    feed(s, initSegment(), join(a, b));
    expect(same(s.file(), join(initSegment(), a, b))).toBe(true);
  });

  it('the same init segment again is fine; another one means another format', () => {
    const s = new ClusterStore();
    feed(s, initSegment(), cluster(0), initSegment());
    expect(s.unusable).toBeNull();
    feed(s, Uint8Array.from([...initSegment(500_000)]));
    expect(s.unusable).toBe('the audio format changed');
    expect(s.file()).toBeNull();
    expect(s.bytes).toBe(0);
  });

  it('data that is no cluster, and more audio than the limit, make the copy unusable', () => {
    const odd = new ClusterStore();
    odd.push(Uint8Array.of(9, 9, 9, 9, 9));
    expect(odd.unusable).toMatch(/not a Cluster/);
    const big = new ClusterStore(500);
    feed(big, initSegment(), cluster(0, 300), cluster(10_000, 300));
    expect(big.unusable).toMatch(/too long/);
    expect(big.file()).toBeNull();
  });

  it('a cluster with a known size ignores bytes after its end that are not a cluster', () => {
    const s = new ClusterStore();
    const c = cluster(0, 30);
    feed(s, initSegment(), join(c, Uint8Array.of(0xec, 0x81, 0)));
    expect(same(s.file(), join(initSegment(), c))).toBe(true);
  });

  it('reads the timecode scale of the init segment for the start of an incomplete cluster', () => {
    const s = new ClusterStore();
    feed(s, initSegment(500_000), cluster(20_000, 300).slice(0, 100)); // 20000 × 0.5 ms
    expect(s.incomplete()).toEqual([10]);
  });
});

describe('Coverage', () => {
  it('joins ranges that touch or overlap and keeps what was once buffered', () => {
    const c = new Coverage();
    c.add(0, 10);
    c.add(30, 40);
    c.add(10.02, 30); // fills the hole
    expect(c.list()).toEqual([[0, 40]]);
    c.add(100, 110);
    c.add(60, 70);
    expect(c.list()).toEqual([[0, 40], [60, 70], [100, 110]]);
  });
  it('ignores an empty range', () => {
    const c = new Coverage();
    c.add(5, 5);
    expect(c.list()).toEqual([]);
  });
});
