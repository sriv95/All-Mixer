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
  const miss = () => listener({ engine: 'bypass', reason: 'deadline-miss' } as never, 0);
  return { chain, sel, hosts, miss };
}
const ready = (p95: number): FromMlWorker => ({ type: 'ready', p50: p95 / 2, p95, createMs: 1, adapter: 'x' });
const req = (on = true) => ({ on });

describe('EngineSelector', () => {
  it('is off until Separate turns on, and never probes while off', () => {
    const { sel, hosts } = setup();
    sel.update(req(false));
    expect(hosts).toHaveLength(0);
    expect(sel.status).toEqual({ state: 'off' });
  });

  it('on → warming → on after a fast warm-up', () => {
    const { sel, hosts, chain } = setup();
    sel.update(req());
    expect(hosts).toHaveLength(1);
    expect(chain.setMlPort).toHaveBeenCalledTimes(1);
    expect(sel.status).toEqual({ state: 'warming' });
    hosts[0].onStatus!(ready(30));
    expect(chain.setEngine).toHaveBeenCalledWith('ml', 'auto');
    expect(sel.status).toEqual({ state: 'on' });
  });

  it('unavailable: slow warm-up (p95 ≥ limit) disposes the host', () => {
    const { sel, hosts, chain } = setup();
    sel.update(req());
    hosts[0].onStatus!(ready(56));
    expect(chain.setEngine).not.toHaveBeenCalled();
    expect(hosts[0].disposed).toBe(true);
    expect(sel.status.state).toBe('unavailable');
    expect(sel.status.cause).toMatch(/slow/);
  });

  it('unavailable: worker message carries its reason', () => {
    const { sel, hosts } = setup();
    sel.update(req());
    hosts[0].onStatus!({ type: 'unavailable', reason: 'no webgpu' });
    expect(hosts[0].disposed).toBe(true);
    expect(sel.status).toEqual({ state: 'unavailable', cause: 'no webgpu' });
  });

  it('unavailable: setEngine refuses (wrong sample rate)', () => {
    const { sel, hosts } = setup(false);
    sel.update(req());
    hosts[0].onStatus!(ready(20));
    expect(sel.status.state).toBe('unavailable');
    expect(sel.status.cause).toMatch(/44\.1/);
    expect(hosts[0].disposed).toBe(true);
  });

  it('unavailable: gives up before creating a host when the context cannot run ML', () => {
    const { sel, hosts, chain } = setup(true, false);
    sel.update(req());
    expect(hosts).toHaveLength(0);
    expect(chain.setMlPort).not.toHaveBeenCalled();
    expect(sel.status.state).toBe('unavailable');
    expect(sel.status.cause).toMatch(/44\.1/);
  });

  it('runtime deadline-miss → stopped; gain updates do not restart ML; off/on retries', () => {
    const { sel, hosts, miss } = setup();
    sel.update(req());
    hosts[0].onStatus!(ready(20));
    miss();
    expect(hosts[0].disposed).toBe(true);
    expect(sel.status).toEqual({ state: 'stopped', cause: 'ML missed its deadline' });
    sel.update(req());
    expect(hosts).toHaveLength(1);
    expect(sel.status.state).toBe('stopped');
    sel.update(req(false));
    sel.update(req());
    expect(hosts).toHaveLength(2);
    expect(sel.status).toEqual({ state: 'warming' });
    hosts[1].onStatus!(ready(20));
    expect(sel.status).toEqual({ state: 'on' });
  });

  it('off/on retries after unavailable', () => {
    const { sel, hosts } = setup();
    sel.update(req());
    hosts[0].onStatus!({ type: 'unavailable', reason: 'x' });
    sel.update(req()); // other setting changes: no new probe
    expect(hosts).toHaveLength(1);
    sel.update(req(false));
    sel.update(req());
    expect(hosts).toHaveLength(2);
    expect(sel.status.state).toBe('warming');
  });

  it('Separate off while ML runs sends the worklet back to bypass', () => {
    const { sel, hosts, chain } = setup();
    sel.update(req());
    hosts[0].onStatus!(ready(20));
    chain.setEngine.mockClear();
    sel.update(req(false));
    expect(chain.setEngine).toHaveBeenCalledWith('bypass', 'auto');
    expect(hosts[0].disposed).toBe(true);
    expect(sel.status).toEqual({ state: 'off' });
  });

  it('Separate off during warm-up disposes the host and ignores its late result', () => {
    const { sel, hosts, chain } = setup();
    sel.update(req());
    sel.update(req(false));
    expect(hosts[0].disposed).toBe(true);
    hosts[0].onStatus!(ready(20));
    expect(chain.setEngine).not.toHaveBeenCalled();
    expect(sel.status).toEqual({ state: 'off' });
  });
});
