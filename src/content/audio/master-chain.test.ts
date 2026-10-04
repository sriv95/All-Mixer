import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  constructor(v: number) {
    this.value = v;
  }
  setTargetAtTime(v: number) {
    this.value = v;
  }
}
class FakeGain extends FakeNode {
  gain: FakeParam;
  constructor(_ctx: unknown, opts: { gain: number }) {
    super();
    this.gain = new FakeParam(opts.gain);
  }
}

let contexts: FakeContext[] = [];
class FakeContext extends EventTarget {
  state: AudioContextState = 'suspended';
  currentTime = 0;
  destination = new FakeNode();
  sources: { el: HTMLMediaElement; node: FakeNode }[] = [];
  allowResume = false;
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
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('GainNode', FakeGain);
  vi.stubGlobal('DynamicsCompressorNode', FakeNode);
  vi.stubGlobal('WaveShaperNode', FakeNode);
});

const video = () => document.createElement('video');

describe('MasterChain', () => {
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
