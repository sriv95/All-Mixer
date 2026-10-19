import { describe, expect, it } from 'vitest';
import { adapterName, probeGpuNames } from './gpu';

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
