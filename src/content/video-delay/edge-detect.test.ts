import { describe, expect, it } from 'vitest';
import { ActivityEdges, AudioEdgeDetector } from './edge-detect';

const SR = 1000; // 1 sample per ms keeps the arithmetic obvious

/** `quiet` ms of silence, `loud` ms of sound, then `tail` ms of silence. */
function signal(quiet: number, loud: number, tail: number): Float32Array {
  const a = new Float32Array(quiet + loud + tail);
  a.fill(0.5, quiet, quiet + loud);
  return a;
}

describe('AudioEdgeDetector', () => {
  it('gives the exact onset sample time for silence → sound', () => {
    const d = new AudioEdgeDetector(SR);
    // Buffer ends at t = 1 s, so sample i is at (1000 - (299 - i)) ms.
    const edges = d.feed(signal(150, 150, 0), 1);
    expect(edges).toEqual([{ kind: 'on', at: 1000 - 299 + 150 }]);
  });

  it('reports the last loud sample only after 100 ms of quiet', () => {
    const d = new AudioEdgeDetector(SR);
    const s = signal(150, 100, 99);
    expect(d.feed(s, 1)).toEqual([{ kind: 'on', at: 1000 - 348 + 150 }]);
    // One more quiet ms confirms it; the edge is the last loud sample (index 249 → 250 ms in).
    expect(d.feed(new Float32Array(2), 1.002)).toEqual([{ kind: 'off', at: 1000 - 348 + 249 }]);
  });

  it('ignores gaps shorter than 100 ms', () => {
    const d = new AudioEdgeDetector(SR);
    const a = new Float32Array(500);
    a.fill(0.5, 150, 200);
    a.fill(0.5, 280, 330); // 80 ms gap
    const kinds = d.feed(a, 1).map((e) => e.kind);
    expect(kinds).toEqual(['on', 'off']); // one run: the 80 ms gap is no edge
  });

  it('does not double count samples in overlapping buffers', () => {
    const d = new AudioEdgeDetector(SR);
    const s = signal(200, 100, 200);
    const all = [...d.feed(s.slice(0, 300), 0.3), ...d.feed(s.slice(100, 400), 0.4), ...d.feed(s.slice(200), 0.5)];
    expect(all.map((e) => e.kind)).toEqual(['on', 'off']);
  });
});

describe('ActivityEdges', () => {
  it('reports on at the first event and off at the last after the gap', () => {
    const e = new ActivityEdges(100);
    expect(e.event(0)).toEqual([{ kind: 'on', at: 0 }]);
    expect(e.event(30)).toEqual([]);
    expect(e.poll(129)).toEqual([]);
    expect(e.poll(130)).toEqual([{ kind: 'off', at: 30 }]);
    expect(e.poll(500)).toEqual([]);
  });

  it('emits off then on when an event arrives after a long gap', () => {
    const e = new ActivityEdges(100);
    e.event(0);
    expect(e.event(300)).toEqual([
      { kind: 'off', at: 0 },
      { kind: 'on', at: 300 },
    ]);
  });
});
