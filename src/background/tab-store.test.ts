import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { TabStore, tabKey, type KeyValueArea } from './tab-store';

function memoryArea(): KeyValueArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(key) {
      return data.has(key) ? { [key]: data.get(key) } : {};
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

describe('TabStore', () => {
  it('returns defaults for an unknown tab', async () => {
    expect(await new TabStore(memoryArea()).get(1)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps settings per tab', async () => {
    const store = new TabStore(memoryArea());
    await store.set(1, { ...DEFAULT_SETTINGS, masterPct: 400 });
    await store.set(2, { ...DEFAULT_SETTINGS, mode: 'separate' });
    expect((await store.get(1)).masterPct).toBe(400);
    expect((await store.get(2)).masterPct).toBe(100);
    expect((await store.get(2)).mode).toBe('separate');
  });

  it('normalizes what it stores', async () => {
    const area = memoryArea();
    const saved = await new TabStore(area).set(3, { masterPct: 9999 });
    expect(saved.masterPct).toBe(600);
    expect(area.data.get(tabKey(3))).toEqual(saved);
  });

  it('drops separationQuality from settings stored by an older version', async () => {
    const area = memoryArea();
    area.data.set(tabKey(4), { ...DEFAULT_SETTINGS, mode: 'separate', separationQuality: 'light' });
    const got = await new TabStore(area).get(4);
    expect(got).toEqual({ ...DEFAULT_SETTINGS, mode: 'separate' });
    expect('separationQuality' in got).toBe(false);
    const saved = await new TabStore(area).set(4, { ...got, separationQuality: 'quality' });
    expect('separationQuality' in saved).toBe(false);
    expect('separationQuality' in (area.data.get(tabKey(4)) as object)).toBe(false);
  });

  it('removes a closed tab', async () => {
    const area = memoryArea();
    const store = new TabStore(area);
    await store.set(5, { masterPct: 300 });
    await store.remove(5);
    expect(area.data.size).toBe(0);
    expect(await store.get(5)).toEqual(DEFAULT_SETTINGS);
  });
});
