import { describe, expect, it } from 'vitest';
import { pairTransition, windowFor, type PairEdge } from './transitions';

const e = (source: PairEdge['source'], kind: 'on' | 'off', t: number, inputAt?: number): PairEdge => ({ source, kind, t, inputAt });

describe('pairTransition', () => {
  it('pairs the first off edges inside the pause window', () => {
    const tr = pairTransition('pause', 10000, [e('audio', 'off', 10100), e('audio', 'off', 10900), e('video', 'off', 10050), e('overlay', 'off', 10080)]);
    expect(tr.pauseOffsetMs).toBe(20); // audio - overlay
    expect(tr.missing).toEqual([]);
  });

  it('falls back to the video when there is no overlay', () => {
    expect(pairTransition('pause', 10000, [e('audio', 'off', 10100), e('video', 'off', 10050)]).pauseOffsetMs).toBe(50);
  });

  it('accepts an edge 300 ms before the pause but ignores earlier or later ones', () => {
    expect(pairTransition('pause', 10000, [e('audio', 'off', 9700), e('video', 'off', 9700)]).missing).toEqual([]);
    const tr = pairTransition('pause', 10000, [e('audio', 'off', 9600), e('video', 'off', 11600)]);
    expect(tr.pauseOffsetMs).toBeUndefined();
    expect(tr.missing).toEqual(['audioOff', 'videoOff']);
  });

  it('ignores on edges for a pause and off edges for a play', () => {
    expect(pairTransition('pause', 0, [e('audio', 'on', 100)]).missing).toContain('audioOff');
    expect(pairTransition('play', 0, [e('audio', 'off', 100)]).missing).toContain('audioOn');
  });

  it('pairs play edges after the event and computes the pipeline offset', () => {
    const tr = pairTransition('play', 5000, [e('audio', 'on', 5200, 5150), e('video', 'on', 5100), e('audio', 'on', 4900)]);
    expect(tr.playOffsetMs).toBe(100);
    expect(tr.pipelineMs).toBe(50);
    expect(tr.missing).toEqual([]);
  });

  it('lists a missing edge', () => {
    const tr = pairTransition('play', 5000, [e('video', 'on', 5100)]);
    expect(tr.playOffsetMs).toBeUndefined();
    expect(tr.missing).toEqual(['audioOn']);
  });
});

describe('play slack', () => {
  it('pairs a video edge stamped a hair before the play event, not one 100 ms before', () => {
    expect(pairTransition('play', 5000, [e('audio', 'on', 5100, 5050), e('video', 'on', 4999.9)]).missing).toEqual([]);
    expect(pairTransition('play', 5000, [e('audio', 'on', 5100, 5050), e('video', 'on', 4900)]).missing).toEqual(['videoOn']);
  });
});

describe('pairTransition reuse', () => {
  it('never pairs one edge with two transitions', () => {
    const edges = [e('audio', 'on', 5200, 5150), e('video', 'on', 5100), e('overlay', 'on', 5120)];
    const used = new Set<PairEdge>();
    const a = pairTransition('play', 5000, edges, 0, 0, used);
    const b = pairTransition('play', 5300, edges, 0, 0, used);
    expect(a.missing).toEqual([]);
    expect(b.missing).toEqual(['audioOn', 'videoOn']);
    expect(b.playOffsetMs).toBeUndefined();
  });
});

describe('windowFor with delay', () => {
  it('keeps 1500 ms without an overlay', () => {
    expect(windowFor('play', 1000)).toEqual([1000, 2500]);
    expect(windowFor('pause', 1000, 0, 0)).toEqual([700, 2500]);
  });
  it('extends to delay + latency + 1000 ms', () => {
    expect(windowFor('play', 1000, 2000, 2000)[1]).toBe(6000);
    expect(windowFor('pause', 1000, 2000, 0)).toEqual([700, 4000]);
  });
  it('never shrinks below 1500 ms', () => {
    expect(windowFor('play', 0, 100, 0)[1]).toBe(1500);
  });
  it('pairs late overlay and audio edges only with the wide window', () => {
    const edges: PairEdge[] = [
      { source: 'video', kind: 'on', t: 1100 },
      { source: 'overlay', kind: 'on', t: 3100 },
      { source: 'audio', kind: 'on', t: 3000, inputAt: 1000 },
    ];
    expect(pairTransition('play', 1000, edges).missing).toContain('audioOn');
    const t = pairTransition('play', 1000, edges, 2000, 2000);
    expect(t.missing).toEqual([]);
    expect(t.playOffsetMs).toBe(-100);
  });
});
