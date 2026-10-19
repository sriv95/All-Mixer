import { describe, expect, it } from 'vitest';
import { adapterName, gpuOptions, gpuSelected, probeGpuNames } from './gpu';

describe('gpu names', () => {
  it('joins what WebGPU reports and falls back to unknown', () => {
    expect(adapterName({ vendor: 'nvidia', architecture: 'ampere', description: 'NVIDIA GeForce RTX 3060' })).toBe('nvidia ampere NVIDIA GeForce RTX 3060');
    expect(adapterName({})).toBe('unknown');
    expect(adapterName(undefined)).toBe('unknown');
  });
  it('names each preference, skipping fallback adapters and failures', async () => {
    const gpu = {
      requestAdapter: async (o?: { powerPreference: string }) => {
        if (!o) return { info: { description: 'A' } };
        if (o.powerPreference === 'high-performance') return { info: { description: 'B' } };
        return { isFallbackAdapter: true, info: { description: 'soft' } };
      },
    };
    expect(await probeGpuNames(gpu)).toEqual({ auto: 'A', 'high-performance': 'B' });
    expect(await probeGpuNames({ requestAdapter: async () => { throw new Error('x'); } })).toEqual({});
    expect(await probeGpuNames(undefined)).toEqual({});
  });
});

describe('gpu options', () => {
  const two = { auto: 'A', 'high-performance': 'A', 'low-power': 'B' };
  it('lists one entry per distinct GPU name', () => {
    expect(gpuOptions(two)).toEqual([{ value: 'high-performance', label: 'A' }, { value: 'low-power', label: 'B' }]);
    expect(gpuOptions({ 'high-performance': 'A', 'low-power': 'A' })).toEqual([{ value: 'high-performance', label: 'A' }]);
  });
  it('uses generic labels when no name is known', () => {
    expect(gpuOptions({}).map((o) => o.value)).toEqual(['auto', 'high-performance', 'low-power']);
  });
  it('shows Automatic, or a preference that shares a name, as the entry with that name', () => {
    expect(gpuSelected(two, 'auto')).toBe('high-performance');
    expect(gpuSelected(two, 'low-power')).toBe('low-power');
    expect(gpuSelected({ 'high-performance': 'A', 'low-power': 'A', auto: 'A' }, 'low-power')).toBe('high-performance');
    expect(gpuSelected({}, 'auto')).toBe('auto');
  });
});
