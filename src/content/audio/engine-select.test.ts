import { describe, expect, it, vi } from 'vitest';
import { GEOMETRY, ML_WARMUP_P90_MS, type FromMlWorker, type MlGeometry, type MlModel } from '../../worklet/protocol';
import { EngineSelector, KEEP_WARM_MS, type MlHostLike } from './engine-select';
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
  const models: MlModel[] = [];
  const delays: (number | null)[] = [];
  const drumFlags: boolean[] = [];
  let listener: LatencyListener = () => {};
  const chain = {
    setMlPort: vi.fn(),
    setMlGeometry: vi.fn(),
    setEngine: vi.fn(() => accept),
    canRunMl: vi.fn(() => canRun),
    onLatencyChange: (cb: LatencyListener) => {
      listener = cb;
      return () => {};
    },
  };
  const sel = new EngineSelector(chain, (model, delayMs, drums) => {
    const h = new FakeHost();
    hosts.push(h);
    models.push(model);
    delays.push(delayMs);
    drumFlags.push(drums);
    return h;
  });
  const miss = () => listener({ engine: 'bypass', reason: 'deadline-miss' } as never, 0);
  return { chain, sel, hosts, models, delays, drumFlags, miss };
}
const ready = (p90: number, geometry?: MlGeometry): FromMlWorker => ({ type: 'ready', p50: p90 / 2, p90, p95: p90, createMs: 1, adapter: 'x', geometry });
const req = (on = true, model?: MlModel, delayMs?: number | null, drums?: boolean) => ({ on, model, delayMs, drums });
/** A plan from the RoFormer worker: 3 s block, 0.5 s overlap, 3 s slack. */
const planned: MlGeometry = { block: 132224, resultOffset: 22016, latency: 132224 + 22016 + 132224 + 128, warmupP90Ms: 2600 };

describe('EngineSelector', () => {
  it('reports every status change through onChange', () => {
    const { sel, hosts } = setup();
    const seen: string[] = [];
    sel.onChange = (c) => seen.push(c.state);
    sel.update(req(true));
    hosts[0].onStatus!(ready(1));
    sel.update(req(false));
    expect(seen).toEqual(['warming', 'on', 'off']);
  });

  it('reload probes the model in use again (new model files), and does nothing for another model, the default or when off', () => {
    const { sel, hosts } = setup();
    sel.reload('roformer');
    expect(hosts).toHaveLength(0);
    sel.update(req(true, 'mdx'));
    sel.reload('roformer');
    expect(hosts).toHaveLength(1);
    sel.update(req(true, 'roformer'));
    hosts[1].onStatus!({ type: 'unavailable', reason: 'the High quality model is not downloaded' });
    expect(sel.status.state).toBe('unavailable');
    sel.reload('deux');
    expect(hosts).toHaveLength(2);
    sel.reload('roformer');
    expect(hosts).toHaveLength(3);
    expect(hosts[1].disposed).toBe(true);
    expect(sel.status).toEqual({ state: 'warming' });
  });

  it('the drum split goes to the host; changing it restarts the probe; the default model takes the geometry its worker plans', () => {
    const { sel, hosts, drumFlags, chain } = setup();
    sel.update(req(true, 'mdx'));
    expect(drumFlags).toEqual([false]);
    sel.update(req(true, 'mdx', null, true));
    expect(hosts).toHaveLength(2);
    expect(drumFlags).toEqual([false, true]);
    expect(hosts[0].disposed).toBe(true);
    const g: MlGeometry = { ...GEOMETRY.mdx, resultOffset: GEOMETRY.mdx.resultOffset + 129792, latency: GEOMETRY.mdx.latency + 129792 + 20000, drums: true };
    hosts[1].onStatus!(ready(900, g)); // far over the plain MDX gate: the worker has checked its own
    expect(chain.setMlGeometry).toHaveBeenLastCalledWith(g);
    expect(sel.status.state).toBe('on');
    sel.update(req(true, 'mdx', null, true));
    expect(hosts).toHaveLength(2); // unchanged request: no restart
  });

  it('reload of the drum model probes again only while the split is on', () => {
    const { sel, hosts } = setup();
    sel.update(req(true, 'roformer'));
    sel.reload('drums');
    expect(hosts).toHaveLength(1);
    sel.update(req(true, 'roformer', 4000, true));
    expect(hosts).toHaveLength(2);
    hosts[1].onStatus!({ type: 'unavailable', reason: 'the Drum split model is not downloaded' });
    sel.reload('drums');
    expect(hosts).toHaveLength(3);
    expect(sel.status).toEqual({ state: 'warming' });
  });

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
    hosts[0].onStatus!(ready(ML_WARMUP_P90_MS - 30));
    expect(chain.setEngine).toHaveBeenCalledWith('ml', 'auto');
    expect(sel.status).toEqual({ state: 'on' });
  });

  it('unavailable: slow warm-up (p90 ≥ limit) disposes the host', () => {
    const { sel, hosts, chain } = setup();
    sel.update(req());
    hosts[0].onStatus!(ready(ML_WARMUP_P90_MS));
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

  it('Separate off while ML runs sends the worklet back to bypass and keeps the warmed-up host', () => {
    const { sel, hosts, chain } = setup();
    sel.update(req());
    hosts[0].onStatus!(ready(20));
    chain.setEngine.mockClear();
    sel.update(req(false));
    expect(chain.setEngine).toHaveBeenCalledWith('bypass', 'auto');
    expect(hosts[0].disposed).toBe(false);
    expect(sel.status).toEqual({ state: 'off' });
  });

  describe('keeping the host warm after Separate turns off', () => {
    it('turning on again resumes without a new warm-up', () => {
      vi.useFakeTimers();
      const { sel, hosts, chain } = setup();
      const seen: string[] = [];
      sel.update(req(true, 'roformer', 4000));
      hosts[0].onStatus!(ready(20, planned));
      sel.update(req(false, 'roformer', 4000));
      vi.advanceTimersByTime(KEEP_WARM_MS - 1000);
      sel.onChange = (c) => seen.push(c.state);
      chain.setMlGeometry.mockClear();
      chain.setEngine.mockClear();
      sel.update(req(true, 'roformer', 4000));
      expect(hosts).toHaveLength(1);
      expect(seen).toEqual(['on']); // never "warming": no pause, no spinner
      expect(chain.setMlGeometry).toHaveBeenCalledWith(planned);
      expect(chain.setEngine).toHaveBeenCalledWith('ml', 'auto');
      vi.advanceTimersByTime(2 * KEEP_WARM_MS);
      expect(hosts[0].disposed).toBe(false); // in use again: the idle timer is gone
      vi.useRealTimers();
    });

    it('the host is disposed after the idle time', () => {
      vi.useFakeTimers();
      const { sel, hosts } = setup();
      sel.update(req());
      hosts[0].onStatus!(ready(20));
      sel.update(req(false));
      vi.advanceTimersByTime(KEEP_WARM_MS);
      expect(hosts[0].disposed).toBe(true);
      sel.update(req());
      expect(hosts).toHaveLength(2);
      expect(sel.status).toEqual({ state: 'warming' });
      vi.useRealTimers();
    });

    it('other settings when it turns on again: the kept host is dropped and a new one probes', () => {
      const { sel, hosts } = setup();
      sel.update(req(true, 'mdx'));
      hosts[0].onStatus!(ready(20));
      sel.update(req(false));
      sel.update(req(true, 'roformer'));
      expect(hosts[0].disposed).toBe(true);
      expect(hosts).toHaveLength(2);
      expect(sel.status).toEqual({ state: 'warming' });
    });

    it('new model files while it is kept drop the host', () => {
      const { sel, hosts } = setup();
      sel.update(req(true, 'roformer'));
      hosts[0].onStatus!(ready(20, planned));
      sel.update(req(false, 'roformer'));
      sel.reload('deux');
      expect(hosts[0].disposed).toBe(false);
      sel.reload('roformer');
      expect(hosts[0].disposed).toBe(true);
    });

    it('a host that never passed its warm-up is not kept', () => {
      const { sel, hosts } = setup();
      sel.update(req());
      sel.update(req(false));
      expect(hosts[0].disposed).toBe(true);
    });
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

  it('hands the model to the host, and the default geometry to the chain before the port', () => {
    const { sel, chain, models } = setup();
    sel.update(req(true, 'roformer'));
    expect(models).toEqual(['roformer']);
    expect(chain.setMlGeometry).toHaveBeenCalledWith(GEOMETRY.roformer);
    expect(chain.setMlGeometry.mock.invocationCallOrder[0]).toBeLessThan(chain.setMlPort.mock.invocationCallOrder[0]);
  });

  it('a RoFormer worker plans the chunk: its geometry reaches the chain before ML starts, and the selector adds no gate', () => {
    const { sel, hosts, chain } = setup();
    sel.update(req(true, 'roformer'));
    hosts[0].onStatus!(ready(5000, planned)); // far over any fixed gate: the worker already checked it
    expect(chain.setMlGeometry).toHaveBeenLastCalledWith(planned);
    expect(chain.setMlGeometry.mock.invocationCallOrder.at(-1)).toBeLessThan(chain.setEngine.mock.invocationCallOrder[0]);
    expect(chain.setEngine).toHaveBeenCalledWith('ml', 'auto');
    expect(sel.status).toEqual({ state: 'on' });
  });

  it('the GPU preference goes to the host; a change restarts the probe', () => {
    const gpus: string[] = [];
    const chain = { setEngine: vi.fn(() => true), setMlPort: vi.fn(), setMlGeometry: vi.fn(), canRunMl: vi.fn(() => true), onLatencyChange: () => () => {} };
    const sel = new EngineSelector(chain, (_m, _d, _r, gpu) => (gpus.push(gpu), new FakeHost()));
    sel.update({ on: true });
    sel.update({ on: true, gpu: 'auto' });
    expect(gpus).toEqual(['auto']);
    sel.update({ on: true, gpu: 'low-power' });
    expect(gpus).toEqual(['auto', 'low-power']);
  });
  it('the delay budget goes to the host; a change restarts the probe, for the default model too', () => {
    const { sel, hosts, delays, chain } = setup();
    sel.update(req(true, 'roformer', null));
    sel.update(req(true, 'roformer', null));
    expect(hosts).toHaveLength(1);
    sel.update(req(true, 'roformer', 6000));
    expect(hosts).toHaveLength(2);
    expect(hosts[0].disposed).toBe(true);
    expect(delays).toEqual([null, 6000]);
    hosts[1].onStatus!(ready(100, planned));
    chain.setEngine.mockClear();
    sel.update(req(true, 'mdx', 6000));
    expect(chain.setEngine).toHaveBeenCalledWith('bypass', 'auto');
    expect(delays.at(-1)).toBe(6000);
    sel.update(req(true, 'mdx', 9000));
    expect(hosts).toHaveLength(4);
    expect(delays.at(-1)).toBe(9000);
  });

  it('a model change while on goes back to the original mix and probes the new model', () => {
    const { sel, hosts, chain, models } = setup();
    sel.update(req(true, 'mdx'));
    hosts[0].onStatus!(ready(50));
    expect(sel.status.state).toBe('on');
    chain.setEngine.mockClear();
    sel.update(req(true, 'roformer'));
    expect(chain.setEngine).toHaveBeenCalledWith('bypass', 'auto');
    expect(hosts[0].disposed).toBe(true);
    expect(models).toEqual(['mdx', 'roformer']);
    expect(sel.status).toEqual({ state: 'warming' });
    hosts[1].onStatus!(ready(100, planned));
    expect(sel.status).toEqual({ state: 'on' });
  });

  it('an unchanged model does not restart the probe', () => {
    const { sel, hosts } = setup();
    sel.update(req(true, 'roformer'));
    sel.update(req(true, 'roformer'));
    expect(hosts).toHaveLength(1);
  });

  it('a model change after the runtime stop retries', () => {
    const { sel, hosts, miss } = setup();
    sel.update(req(true, 'roformer'));
    hosts[0].onStatus!(ready(100, planned));
    miss();
    expect(sel.status.state).toBe('stopped');
    sel.update(req(true, 'mdx'));
    expect(hosts).toHaveLength(2);
    expect(sel.status).toEqual({ state: 'warming' });
  });
});
