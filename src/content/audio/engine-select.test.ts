import { describe, expect, it, vi } from 'vitest';
import type { FromMlWorker } from '../../worklet/protocol';
import { EngineSelector, type MlHostLike } from './engine-select';
import type { LatencyListener } from './latency';

class FakeHost implements MlHostLike {
  onStatus: ((m: FromMlWorker) => void) | null = null;
  disposed = false;
  start(cb: (m: FromMlWorker) => void) {
    this.onStatus = cb;
    return {} as MessagePort;
  }
  dispose() {
    this.disposed = true;
  }
}

function setup(accept = true, canRun = true) {
  const hosts: FakeHost[] = [];
  let listener: LatencyListener = () => {};
  const chain = {
    setMlPort: vi.fn(),
    setEngine: vi.fn(() => accept),
    canRunMl: vi.fn(() => canRun),
    onLatencyChange: (cb: LatencyListener) => {
      listener = cb;
      return () => {};
    },
  };
  const sel = new EngineSelector(chain, () => {
    const h = new FakeHost();
    hosts.push(h);
    return h;
  });
  const miss = () => listener({ engine: 'dsp', reason: 'deadline-miss' } as never, 0);
  return { chain, sel, hosts, miss };
}
const ready = (p95: number): FromMlWorker => ({ type: 'ready', p50: p95 / 2, p95, createMs: 1, adapter: 'x' });
const req = (quality: 'auto' | 'light' | 'quality', on = true) => ({ on, quality });

describe('EngineSelector', () => {
  it('Light never creates the ML host', () => {
    const { sel, hosts, chain } = setup();
    sel.update(req('light'));
    expect(hosts).toHaveLength(0);
    expect(chain.setMlPort).not.toHaveBeenCalled();
    expect(sel.status).toEqual({ engine: 'dsp', reason: 'user' });
  });

  it('Auto: fast warm-up switches to ml', () => {
    const { sel, hosts, chain } = setup();
    sel.update(req('auto'));
    expect(hosts).toHaveLength(1);
    expect(chain.setMlPort).toHaveBeenCalledTimes(1);
    expect(sel.status.engine).toBe('dsp');
    hosts[0].onStatus!(ready(30));
    expect(chain.setEngine).toHaveBeenCalledWith('ml', 'auto');
    expect(sel.status).toEqual({ engine: 'ml', reason: 'auto' });
  });

  it('Auto: slow warm-up stays on dsp and disposes', () => {
    const { sel, hosts, chain } = setup();
    sel.update(req('auto'));
    hosts[0].onStatus!(ready(56));
    expect(chain.setEngine).not.toHaveBeenCalled();
    expect(hosts[0].disposed).toBe(true);
    expect(sel.status).toMatchObject({ engine: 'dsp', reason: 'auto' });
    expect(sel.status.cause).toMatch(/slow/);
  });

  it('Auto: unavailable stays on dsp and disposes', () => {
    const { sel, hosts } = setup();
    sel.update(req('auto'));
    hosts[0].onStatus!({ type: 'unavailable', reason: 'no webgpu' });
    expect(hosts[0].disposed).toBe(true);
    expect(sel.status).toEqual({ engine: 'dsp', reason: 'auto', cause: 'ML unavailable: no webgpu' });
  });

  it('Quality: unavailable or slow reports deadline-miss', () => {
    const a = setup();
    a.sel.update(req('quality'));
    a.hosts[0].onStatus!({ type: 'unavailable', reason: 'x' });
    expect(a.sel.status).toMatchObject({ engine: 'dsp', reason: 'deadline-miss' });
    const b = setup();
    b.sel.update(req('quality'));
    b.hosts[0].onStatus!(ready(80));
    expect(b.sel.status).toMatchObject({ engine: 'dsp', reason: 'deadline-miss' });
  });

  it('Quality while ml runs changes nothing', () => {
    const { sel, hosts, chain } = setup();
    sel.update(req('auto'));
    hosts[0].onStatus!(ready(20));
    chain.setEngine.mockClear();
    sel.update(req('quality'));
    expect(hosts).toHaveLength(1);
    expect(chain.setEngine).not.toHaveBeenCalled();
    expect(sel.status.engine).toBe('ml');
  });

  it('runtime deadline-miss pins dsp; gain updates do not restart ML', () => {
    const { sel, hosts, miss } = setup();
    sel.update(req('auto'));
    hosts[0].onStatus!(ready(20));
    miss();
    expect(hosts[0].disposed).toBe(true);
    expect(sel.status).toMatchObject({ engine: 'dsp', reason: 'deadline-miss' });
    sel.update(req('auto'));
    expect(hosts).toHaveLength(1);
    // Separate off and on again, or a setting change, allows a new probe.
    sel.update(req('auto', false));
    sel.update(req('auto'));
    expect(hosts).toHaveLength(2);
  });

  it('setting change Light ↔ Auto', () => {
    const { sel, hosts, chain } = setup();
    sel.update(req('auto'));
    hosts[0].onStatus!(ready(20));
    sel.update(req('light'));
    expect(chain.setEngine).toHaveBeenLastCalledWith('dsp', 'user');
    expect(hosts[0].disposed).toBe(true);
    expect(sel.status).toEqual({ engine: 'dsp', reason: 'user' });
    sel.update(req('auto'));
    expect(hosts).toHaveLength(2);
    hosts[1].onStatus!(ready(20));
    expect(sel.status.engine).toBe('ml');
  });

  it('refused ML (wrong sample rate) falls back with a cause; separate off disposes', () => {
    const { sel, hosts } = setup(false);
    sel.update(req('auto'));
    hosts[0].onStatus!(ready(20));
    expect(sel.status.engine).toBe('dsp');
    expect(sel.status.cause).toMatch(/44\.1/);
    sel.update(req('auto', false));
    sel.update(req('auto'));
    sel.update(req('auto', false));
    expect(hosts[1].disposed).toBe(true);
  });

  it('Quality warm-up is reported as auto, not a failure', () => {
    const { sel } = setup();
    sel.update(req('quality'));
    expect(sel.status).toMatchObject({ engine: 'dsp', reason: 'auto', cause: 'ML warming up' });
  });

  it('gives up before creating a host when the context cannot run ML', () => {
    const { sel, hosts, chain } = setup(true, false);
    sel.update(req('quality'));
    expect(hosts).toHaveLength(0);
    expect(chain.setMlPort).not.toHaveBeenCalled();
    expect(sel.status).toMatchObject({ engine: 'dsp', reason: 'deadline-miss' });
    expect(sel.status.cause).toMatch(/44\.1/);
  });

  it('Separate off while ML runs sends the worklet back to dsp', () => {
    const { sel, hosts, chain } = setup();
    sel.update(req('auto'));
    hosts[0].onStatus!(ready(20));
    chain.setEngine.mockClear();
    sel.update(req('auto', false));
    expect(chain.setEngine).toHaveBeenCalledWith('dsp', 'user');
    expect(hosts[0].disposed).toBe(true);
  });
});
