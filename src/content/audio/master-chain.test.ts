import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ML_LATENCY_SAMPLES } from '../../worklet/protocol';
import type { AvProbe } from '../av-probe';
import { MasterChain } from './master-chain';

// Minimal Web Audio fakes: enough to observe graph wiring and context state.
class FakeNode {
  connected: FakeNode[] = [];
  connect(n: FakeNode) {
    this.connected.push(n);
    return n;
  }
}
class FakeParam {
  value: number;
  /** [target, startTime] of every setTargetAtTime call. */
  targets: [number, number][] = [];
  constructor(v: number) {
    this.value = v;
  }
  setTargetAtTime(v: number, t = 0) {
    this.value = v;
    this.targets.push([v, t]);
  }
  cancelScheduledValues() {}
}
class FakeGain extends FakeNode {
  gain: FakeParam;
  constructor(_ctx: unknown, opts: { gain: number }) {
    super();
    this.gain = new FakeParam(opts.gain);
  }
}

let worklets: FakeWorklet[] = [];
class FakeWorklet extends FakeNode {
  messages: unknown[] = [];
  port = { postMessage: (m: unknown) => this.messages.push(m) };
  parameters = new Map([
    ['vocalGain', new FakeParam(1)],
    ['instrumentalGain', new FakeParam(1)],
  ]);
  constructor(
    readonly ctx: FakeContext,
    readonly name: string,
  ) {
    super();
    worklets.push(this);
  }
  addEventListener() {}
}

let contexts: FakeContext[] = [];
class FakeContext extends EventTarget {
  state: AudioContextState = 'suspended';
  currentTime = 0;
  destination = new FakeNode();
  sources: { el: HTMLMediaElement; node: FakeNode }[] = [];
  allowResume = false;
  sampleRate = 48000;
  modules: string[] = [];
  loadFails = false;
  audioWorklet = {
    addModule: (url: string) => {
      this.modules.push(url);
      return this.loadFails ? Promise.reject(new Error('blocked')) : Promise.resolve();
    },
  };
  constructor() {
    super();
    contexts.push(this);
  }
  resume() {
    if (this.allowResume && this.state !== 'running') {
      this.state = 'running';
      this.dispatchEvent(new Event('statechange'));
    }
    return Promise.resolve();
  }
  createMediaElementSource(el: HTMLMediaElement) {
    if (this.sources.some((s) => s.el === el)) throw new Error('already connected');
    const node = new FakeNode();
    this.sources.push({ el, node });
    return node;
  }
}

beforeEach(() => {
  contexts = [];
  worklets = [];
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorklet);
  vi.stubGlobal('GainNode', FakeGain);
  vi.stubGlobal('DynamicsCompressorNode', FakeNode);
  vi.stubGlobal('WaveShaperNode', FakeNode);
});

// jsdom reports every video as paused; tests that are not about pause start with a playing one.
const video = () => {
  const v = document.createElement('video');
  Object.defineProperty(v, 'paused', { value: false, configurable: true });
  return v;
};
const flushPromises = () => new Promise((r) => setTimeout(r, 0));

describe('MasterChain', () => {
  it('reports device latency in ms, 0 without a running context', () => {
    vi.stubGlobal(
      'AudioContext',
      class extends FakeContext {
        state: AudioContextState = 'running';
        baseLatency = 0.01;
        outputLatency = 0.04;
      },
    );
    const chain = new MasterChain();
    expect(chain.deviceLatencyMs).toBe(0);
    chain.setGain(2);
    expect(chain.deviceLatencyMs).toBeCloseTo(50, 5);
  });

  it('leaves page audio alone at 100%', () => {
    const chain = new MasterChain();
    chain.setVideo(video());
    chain.setGain(1);
    expect(contexts).toHaveLength(0);
    expect(chain.state).toBe('idle');
  });

  it('does not reroute (and mute) the video while the context is suspended', () => {
    const chain = new MasterChain();
    chain.setVideo(video());
    chain.setGain(3);
    expect(contexts[0].sources).toHaveLength(0);
    expect(chain.state).toBe('waiting-for-gesture');
  });

  it('connects after a user gesture resumes the context', async () => {
    const chain = new MasterChain();
    const v = video();
    chain.setVideo(v);
    chain.setGain(3);
    const ctx = contexts[0];
    ctx.allowResume = true;
    window.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve();
    expect(ctx.sources.map((s) => s.el)).toEqual([v]);
    expect(chain.state).toBe('active');
  });

  it('is not active until a video is routed', () => {
    vi.stubGlobal(
      'AudioContext',
      class extends FakeContext {
        state: AudioContextState = 'running';
      },
    );
    const chain = new MasterChain();
    chain.setGain(2);
    expect(chain.state).toBe('idle');
    chain.setVideo(video());
    expect(chain.state).toBe('active');
  });

  it('connects immediately when the context starts running', () => {
    vi.stubGlobal(
      'AudioContext',
      class extends FakeContext {
        state: AudioContextState = 'running';
      },
    );
    const chain = new MasterChain();
    const v = video();
    chain.setVideo(v);
    chain.setGain(6);
    expect(contexts[0].sources[0].el).toBe(v);
    expect(chain.state).toBe('active');
  });

  it('routes a replaced <video> once and keeps gain changes on the same graph', () => {
    vi.stubGlobal(
      'AudioContext',
      class extends FakeContext {
        state: AudioContextState = 'running';
      },
    );
    const chain = new MasterChain();
    const a = video();
    const b = video();
    chain.setVideo(a);
    chain.setGain(2);
    chain.setVideo(b);
    chain.setVideo(a); // same element again (e.g. SPA nav) must not throw
    chain.setGain(1);
    expect(chain.requestedGain).toBe(1);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].sources.map((s) => s.el)).toEqual([a, b]);
    expect(chain.state).toBe('active');
  });

  it('reports an error if another script already owns the element', () => {
    vi.stubGlobal(
      'AudioContext',
      class extends FakeContext {
        state: AudioContextState = 'running';
        createMediaElementSource(): FakeNode {
          throw new Error('HTMLMediaElement already connected previously to a different MediaElementSourceNode');
        }
      },
    );
    const chain = new MasterChain();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    chain.setVideo(video());
    chain.setGain(2);
    expect(chain.state).toBe('error');
    expect(chain.error).toMatch(/already connected/);
  });
});

describe('MasterChain separation', () => {
  const running = () =>
    vi.stubGlobal(
      'AudioContext',
      class extends FakeContext {
        state: AudioContextState = 'running';
        currentTime = 10;
        baseLatency = 0.01;
        outputLatency = 0.02;
      },
    );
  const on = { on: true, vocal: 0, instrumental: 1.5 };
  const off = { ...on, on: false };

  async function separating(probe: AvProbe | null = null) {
    running();
    const chain = new MasterChain(undefined, () => 'chrome-extension://x/worklet.js', probe);
    const v = video();
    chain.setVideo(v);
    const changes: [number, number, string][] = [];
    chain.onLatencyChange((info, at) => changes.push([info.processingSamples, at, info.engine]));
    chain.setSeparation(on);
    await flushPromises();
    const ctx = contexts[0];
    const source = ctx.sources[0].node;
    const sep = worklets[0];
    const direct = source.connected[0] as FakeGain;
    const sepOut = sep.connected[0] as FakeGain;
    return { chain, v, ctx, source, sep, direct, sepOut, changes };
  }

  it('loads the worklet only when Separate mode is first used', () => {
    running();
    const chain = new MasterChain(undefined, () => 'chrome-extension://x/worklet.js');
    chain.setVideo(video());
    chain.setGain(2);
    expect(contexts[0].modules).toEqual([]);
    expect(chain.separationState).toBe('off');
  });

  it('routes the video into the separator, which starts on the original mix with no delay', async () => {
    const { chain, ctx, source, sep, direct, sepOut, changes } = await separating();
    expect(ctx.modules).toEqual(['chrome-extension://x/worklet.js']);
    expect(sep.name).toBe('all-mixer-separator');
    expect(source.connected).toEqual([direct, sep]);
    expect(sep.messages).toEqual([{ type: 'active', on: true }]);
    const start = 10 + 0.01;
    expect(sepOut.gain.targets.at(-1)).toEqual([1, start]);
    expect(direct.gain.targets.at(-1)).toEqual([0, start]);
    expect(sep.parameters.get('vocalGain')!.value).toBe(0);
    expect(sep.parameters.get('instrumentalGain')!.value).toBe(1.5);
    expect(chain.separationState).toBe('on');
    expect(chain.latency).toMatchObject({ engine: 'bypass', processingSamples: 0, sampleRate: 48000 });
    expect(chain.latency.processingMs).toBe(0);
    expect(chain.latency.videoDelayMs).toBeCloseTo(30, 2);
    expect(changes).toHaveLength(1);
    expect(changes[0][0]).toBe(0);
    expect(changes[0][1]).toBeGreaterThan(performance.now());
  });

  it('changes stem gains without another crossfade or latency change', async () => {
    const { chain, sep, sepOut, changes } = await separating();
    const fades = sepOut.gain.targets.length;
    chain.setSeparation({ ...on, vocal: 6, instrumental: 0 });
    expect(sep.parameters.get('vocalGain')!.value).toBe(6);
    expect(sep.parameters.get('instrumentalGain')!.value).toBe(0);
    expect(sepOut.gain.targets).toHaveLength(fades);
    expect(changes).toHaveLength(1);
  });

  it('follows the worklet engine messages: latency, engine, reason, and the change time', async () => {
    const { chain, ctx, sep, changes } = await separating();
    const port = sep.port as { postMessage: (m: unknown, t?: unknown[]) => void; onmessage?: (e: { data: unknown }) => void };
    ctx.sampleRate = 44100; // the real context is created at the model rate for ML
    chain.setEngine('ml', 'auto');
    expect(sep.messages.at(-1)).toEqual({ type: 'engine', engine: 'ml', reason: 'auto' });
    port.onmessage!({ data: { type: 'engine', engine: 'ml', reason: 'auto', at: ctx.currentTime + 1 } });
    expect(chain.latency).toMatchObject({ engine: 'ml', reason: 'auto', processingSamples: ML_LATENCY_SAMPLES });
    expect(chain.latency.processingMs).toBeCloseTo((ML_LATENCY_SAMPLES / 44100) * 1000, 3);
    expect(changes.at(-1)![0]).toBe(ML_LATENCY_SAMPLES);
    // heard one processing delay after the input sample; device latency is added by the fake ctx
    const heard = (at: number, n: number) => performance.now() + (at + n / 44100 - ctx.currentTime) * 1000 + chain.latency.deviceMs;
    expect(changes.at(-1)![1]).toBeCloseTo(heard(ctx.currentTime + 1, ML_LATENCY_SAMPLES), -1);
    port.onmessage!({ data: { type: 'engine', engine: 'bypass', reason: 'deadline-miss', at: ctx.currentTime + 2 } });
    expect(chain.latency).toMatchObject({ engine: 'bypass', reason: 'deadline-miss', processingSamples: 0 });
    expect(changes.at(-1)![0]).toBe(0);
    expect(changes.at(-1)![1]).toBeCloseTo(heard(ctx.currentTime + 2, 0), -1);
  });

  it('ignores a switch to ML when the context is not at the model rate', async () => {
    const { chain, sep } = await separating();
    const n = sep.messages.length;
    chain.setEngine('ml', 'auto'); // fake ctx is 48000 Hz
    expect(sep.messages).toHaveLength(n);
  });

  it('fades back to the direct path and stops the worklet when leaving Separate mode', async () => {
    const { chain, sep, direct, sepOut, changes } = await separating();
    vi.useFakeTimers();
    try {
      chain.setSeparation(off);
      expect(direct.gain.value).toBe(1);
      expect(sepOut.gain.value).toBe(0);
      expect(chain.latency.engine).toBe('bypass');
      expect(changes.at(-1)![0]).toBe(0);
      expect(sep.messages).toHaveLength(1);
      vi.advanceTimersByTime(500);
      expect(sep.messages.at(-1)).toEqual({ type: 'active', on: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-entering before the worklet stops reuses its buffers (no prime wait)', async () => {
    const { chain, sep, sepOut } = await separating();
    chain.setSeparation(off);
    chain.setSeparation(on);
    expect(sep.messages).toEqual([{ type: 'active', on: true }]);
    expect(sepOut.gain.targets.at(-1)).toEqual([1, 10 + 0.01]);
  });

  it('drops a pending ML port when Separate turns off before the worklet loads', async () => {
    running();
    const chain = new MasterChain(undefined, () => 'chrome-extension://x/worklet.js');
    chain.setVideo(video());
    chain.setSeparation(on);
    const close = vi.fn();
    chain.setMlPort({ close } as unknown as MessagePort);
    chain.setSeparation(off);
    await flushPromises();
    expect(close).toHaveBeenCalled();
    expect(worklets[0].messages.some((m) => (m as { type: string }).type === 'ml-port')).toBe(false);
  });

  it('flushes the separator on seek', async () => {
    const { v, sep } = await separating();
    v.dispatchEvent(new Event('seeking'));
    expect(sep.messages.at(-1)).toEqual({ type: 'flush' });
  });

  it('holds the delay line on pause / ended, releases on playing, and still flushes on seek', async () => {
    const { v, sep } = await separating();
    v.dispatchEvent(new Event('pause'));
    expect(sep.messages.at(-1)).toEqual({ type: 'hold' });
    v.dispatchEvent(new Event('playing'));
    expect(sep.messages.at(-1)).toEqual({ type: 'release' });
    v.dispatchEvent(new Event('ended'));
    expect(sep.messages.at(-1)).toEqual({ type: 'hold' });
    v.dispatchEvent(new Event('seeking'));
    expect(sep.messages.at(-1)).toEqual({ type: 'flush' });
  });

  it('traces flush, engine and video events to the probe', async () => {
    const traces: [string, Record<string, unknown>][] = [];
    const probe = { trace: (k: string, d: Record<string, unknown>) => (traces.push([k, d]), true), attachAudio: () => {} } as unknown as AvProbe;
    const { chain, v, ctx } = await separating(probe);
    expect(traces.find(([k]) => k === 'video')![1]).toEqual({ changed: true, paused: false, workletOn: false });
    traces.length = 0;
    v.dispatchEvent(new Event('seeking'));
    v.dispatchEvent(new Event('emptied'));
    v.dispatchEvent(new Event('loadstart'));
    const flushes = traces.filter(([k]) => k === 'flush').map(([, d]) => d);
    expect(flushes.map((d) => d.event)).toEqual(['seeking', 'emptied', 'loadstart']);
    expect(flushes[0]).toEqual({ event: 'seeking', currentTime: 0, paused: false, ctxTime: ctx.currentTime, workletOn: true });
    const port = worklets[0].port as { onmessage?: (e: { data: unknown }) => void };
    port.onmessage!({ data: { type: 'engine', engine: 'bypass', reason: 'deadline-miss', at: 12 } });
    expect(traces.at(-1)).toEqual(['engine', { engine: 'bypass', reason: 'deadline-miss', at: 12 }]);
    chain.setVideo(video());
    expect(traces.at(-1)![0]).toBe('video');
    expect(traces.at(-1)![1]).toMatchObject({ changed: true, workletOn: true });
  });

  it('re-syncs hold / release when the media element is swapped', async () => {
    const { chain, v, sep } = await separating();
    v.dispatchEvent(new Event('pause'));
    expect(sep.messages.at(-1)).toEqual({ type: 'hold' });
    chain.setVideo(video()); // already playing: no `playing` event will fire
    expect(sep.messages.at(-1)).toEqual({ type: 'release' });
    const paused = video();
    Object.defineProperty(paused, 'paused', { value: true, configurable: true });
    chain.setVideo(paused);
    expect(sep.messages.at(-1)).toEqual({ type: 'hold' });
  });

  it('starts held when the video is already paused as the separator engages', async () => {
    running();
    const chain = new MasterChain(undefined, () => 'chrome-extension://x/worklet.js');
    const v = video();
    Object.defineProperty(v, 'paused', { value: true, configurable: true });
    chain.setVideo(v);
    chain.setSeparation(on);
    await flushPromises();
    expect(worklets[0].messages.slice(0, 2)).toEqual([{ type: 'active', on: true }, { type: 'hold' }]);
  });

  it('reports an error state and bypass latency when the worklet load fails', async () => {
    vi.stubGlobal(
      'AudioContext',
      class extends FakeContext {
        state: AudioContextState = 'running';
        loadFails = true;
      },
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chain = new MasterChain(undefined, () => 'chrome-extension://x/worklet.js');
    chain.setVideo(video());
    chain.setSeparation(on);
    await flushPromises();
    expect(chain.separationState).toBe('error');
    expect(chain.separationError).toBe('blocked');
    expect(chain.state).toBe('active');
    expect(chain.latency.engine).toBe('bypass');
    expect(worklets).toHaveLength(0);
  });
});
