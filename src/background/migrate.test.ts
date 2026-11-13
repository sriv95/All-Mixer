import { describe, expect, it } from 'vitest';
import type { ModelFiles } from '../shared/model-files';
import { keyInstalled, keyRemote, type ModelId } from '../shared/model-store';
import { migrateModels } from './migrate';

function setup(names: string[], d: Record<string, unknown>) {
  const m = new Set(names);
  const files = { list: async () => [...m], remove: async (n: string) => void m.delete(n) } as unknown as ModelFiles;
  const area = {
    get: async (k: string) => (k in d ? { [k]: d[k] } : {}),
    set: async (o: Record<string, unknown>) => void Object.assign(d, o),
    remove: async (k: string) => void delete d[k],
  };
  const installs: string[] = [];
  const install = async (id: ModelId) => {
    installs.push(id);
    d[keyInstalled(id)] = { version: 1, files: {} };
  };
  return { m, files, area, installs, install };
}
const OLD = 'modelInstalled.roformer';
const chunks = ['v1-roformer.onnx.0000', 'v1-roformer-meta.json.0000', 'v1-deux.onnx.0000', 'v2-sw.onnx.0001', 'v1-kim2.onnx.0000', 'v1-kim2-meta.json.0000', 'v1-drums.onnx.0000', 'stray.txt'];

describe('migrateModels', () => {
  it('prunes chunks of unknown models only and drops the old speeds and records', async () => {
    const d: Record<string, unknown> = { 'modelRemote.roformer': {}, mlSpeeds: { 'roformer|1|0.3|gpu': { baseMs: 1, at: 1 }, 'deux|1|0.3|gpu': { baseMs: 1, at: 1 } } };
    const s = setup(chunks, d);
    await migrateModels(s.area, s.files, s.install);
    expect([...s.m].sort()).toEqual(['stray.txt', 'v1-deux.onnx.0000', 'v1-drums.onnx.0000', 'v1-kim2-meta.json.0000', 'v1-kim2.onnx.0000', 'v2-sw.onnx.0001']);
    expect(Object.keys(d.mlSpeeds as object)).toEqual(['deux|1|0.3|gpu']);
    expect(d['modelRemote.roformer']).toBeUndefined();
    expect(s.installs).toEqual([]);
  });
  it('installs kim2 when the old model was installed, then forgets it', async () => {
    const d: Record<string, unknown> = { [OLD]: { version: 1, files: {} } };
    const s = setup(chunks, d);
    await migrateModels(s.area, s.files, s.install);
    expect(s.installs).toEqual(['kim2']);
    expect(d[OLD]).toBeUndefined();
    expect(keyInstalled('kim2') in d).toBe(true);
  });
  it('keeps the old record when the kim2 download failed, so the next start retries', async () => {
    const d: Record<string, unknown> = { [OLD]: { version: 1, files: {} } };
    const s = setup([], d);
    await migrateModels(s.area, s.files, async () => {});
    expect(d[OLD]).toBeDefined();
  });
  it('does nothing the second time', async () => {
    const d: Record<string, unknown> = { [OLD]: { version: 1, files: {} }, [keyRemote('kim2')]: { version: 1 } };
    const s = setup(chunks, d);
    await migrateModels(s.area, s.files, s.install);
    const after = JSON.stringify([d, [...s.m]]);
    await migrateModels(s.area, s.files, s.install);
    expect(JSON.stringify([d, [...s.m]])).toBe(after);
    expect(s.installs).toEqual(['kim2']);
  });
});
