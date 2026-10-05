import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvProbe } from './av-probe';

const latency = () => ({ engine: 'bypass', reason: 'auto', sampleRate: 16000, processingSamples: 0, processingMs: 0, deviceMs: 0, videoDelayMs: 0 }) as const;

function setup(flag: { on: boolean }) {
  const analysers: unknown[] = [];
  vi.stubGlobal(
    'AnalyserNode',
    class {
      constructor() {
        analysers.push(this);
      }
      getFloatTimeDomainData() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const video = document.createElement('video');
  Object.assign(video, { requestVideoFrameCallback: () => 1, cancelVideoFrameCallback: () => {} });
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const probe = new AvProbe(() => flag.on);
  probe.attachVideo(video);
  probe.attachAudio({ sampleRate: 16000, currentTime: 0 } as unknown as AudioContext, source as unknown as AudioNode, latency);
  return { analysers, video, source, probe };
}

afterEach(() => vi.unstubAllGlobals());

describe('AvProbe', () => {
  it('creates no AnalyserNode and taps nothing while the flag is off', () => {
    const { analysers, source, probe } = setup({ on: false });
    expect(analysers).toHaveLength(0);
    expect(source.connect).not.toHaveBeenCalled();
    expect(probe.on).toBe(false);
  });

  it('turns on at the next play when the flag was set meanwhile', () => {
    const flag = { on: false };
    const { analysers, video, probe } = setup(flag);
    flag.on = true;
    video.dispatchEvent(new Event('play'));
    expect(probe.on).toBe(true);
    expect(analysers).toHaveLength(1);
    expect(probe.status.events.play).toBeTypeOf('number');
  });

  it('derives offsets from the latest edges', () => {
    const { probe } = setup({ on: true });
    probe.overlayFrame(1, 1000);
    const st = probe.status;
    expect(st.overlayOn).toBe(1000);
    expect(st.playOffsetMs).toBeUndefined(); // no audio edge yet
  });
});
