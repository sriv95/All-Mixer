import { describe, expect, it, vi } from 'vitest';
import { GEOMETRY, ML_WARMUP_P90_MS, type FromMlWorker, type MlModel } from '../../worklet/protocol';
import { EngineSelector, type MlHostLike } from './engine-select';
import type { LatencyListener } from './latency';

class FakeHost implements MlHostLike {
  onStatus: ((m: FromMlWorker) => void) | null = null;
  disposed = false;
  gate: boolean[] = [];
  setGate(on: boolean) {
    this.gate.push(on);
  }
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
  let listener: LatencyListener = () => {};
  const chain = {
    setMlPort: vi.fn(),
    setMlModel: vi.fn(),
    setEngine: vi.fn(() => accept),
    canRunMl: vi.fn(() => canRun),
    onLatencyChange: (cb: LatencyListener) => {
      listener = cb;
      return () => {};
    },
  };
  const sel = new EngineSelector(chain, (model) => {
    const h = new FakeHost();
    hosts.push(h);
    models.push(model);
    return h;
  });
  const miss = () => listener({ engine: 'bypass', reason: 'deadline-miss' } as never, 0);
  return { chain, sel, hosts, models, miss };
}
const ready = (p90: number): FromMlWorker => ({ type: 'ready', p50: p90 / 2, p90, p95: p90, createMs: 1, adapter: 'x' });
const req = (on = true, model?: MlModel) => ({ on, model });

describe('EngineSelector', () => {
  it('passes the gate to a new host and live changes to a running one, without a restart', () => {
    const { sel, hosts } = setup();
    sel.update({ on: true, model: 'roformer', gate: true });
    expect(hosts[0].gate).toEqual([true]);
    sel.update({ on: true, model: 'roformer', gate: false });
    expect(hosts).toHaveLength(1);
    expect(hosts[0].gate).toEqual([true, false]);
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

  it('hands the model to the host and the chain before the port', () => {
    const { sel, chain, models } = setup();
    sel.update(req(true, 'roformer'));
    expect(models).toEqual(['roformer']);
    expect(chain.setMlModel).toHaveBeenCalledWith('roformer');
    expect(chain.setMlModel.mock.invocationCallOrder[0]).toBeLessThan(chain.setMlPort.mock.invocationCallOrder[0]);
  });

  it('uses the warm-up gate of the model', () => {
    const { sel, hosts, chain } = setup();
    sel.update(req(true, 'roformer'));
    const gate = GEOMETRY.roformer.warmupP90Ms;
    expect(gate).toBeGreaterThan(ML_WARMUP_P90_MS); // the RoFormer step is far longer, with a bigger slack
    hosts[0].onStatus!(ready(gate - 20));
    expect(chain.setEngine).toHaveBeenCalledWith('ml', 'auto');
    expect(sel.status).toEqual({ state: 'on' });
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
    hosts[1].onStatus!(ready(GEOMETRY.roformer.warmupP90Ms - 20));
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
    hosts[0].onStatus!(ready(100));
    miss();
    expect(sel.status.state).toBe('stopped');
    sel.update(req(true, 'mdx'));
    expect(hosts).toHaveLength(2);
    expect(sel.status).toEqual({ state: 'warming' });
  });
});
