import { describe, expect, it } from 'vitest';
import { MODEL_FORMAT, modelState, parseManifest, STALL_MS, type InstalledModel, type Progress, type RemoteRecord } from './model-store';

const files = { 'roformer.onnx': 100, 'roformer-meta.json': 10 };
const inst = (version: number): InstalledModel => ({ version, files });
const remote = (version: number, format = MODEL_FORMAT): RemoteRecord => ({ format, version, files, checkedAt: 0 });
const prog = (p: Partial<Progress>): Progress => ({ phase: 'downloading', version: 2, done: 5, total: 110, at: 1000, ...p });

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    expect(parseManifest({ format: 1, version: 2, files })).toEqual({ format: 1, version: 2, files });
  });
  it('rejects missing files, bad sizes and non-objects', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest({ format: 1, version: 0, files })).toBeNull();
    expect(parseManifest({ format: 1, version: 1, files: { 'roformer.onnx': 1 } })).toBeNull();
    expect(parseManifest({ format: 1, version: 1, files: { ...files, 'roformer.onnx': -1 } })).toBeNull();
    expect(parseManifest({ version: 1, files })).toBeNull();
  });
});

describe('modelState', () => {
  it('missing, with the size when the manifest is known', () => {
    expect(modelState(undefined, undefined, undefined, 0)).toEqual({ kind: 'missing', size: null });
    expect(modelState(undefined, remote(1), undefined, 0)).toEqual({ kind: 'missing', size: 110 });
  });
  it('downloading while the record is fresh, a stalled one counts as not running', () => {
    expect(modelState(undefined, remote(1), prog({}), 1000 + 10)).toEqual({ kind: 'downloading', done: 5, total: 110 });
    expect(modelState(undefined, remote(1), prog({}), 1000 + STALL_MS + 1)).toEqual({ kind: 'missing', size: 110 });
  });
  it('error on a first install', () => {
    expect(modelState(undefined, remote(1), prog({ phase: 'error', error: 'HTTP 503' }), 0)).toEqual({ kind: 'error', message: 'HTTP 503' });
  });
  it('ready, update, and no update from an older or other-format manifest', () => {
    expect(modelState(inst(2), remote(2), undefined, 0)).toEqual({ kind: 'ready', version: 2 });
    expect(modelState(inst(2), remote(3), undefined, 0)).toEqual({ kind: 'update', version: 3, size: 110 });
    expect(modelState(inst(2), remote(3, MODEL_FORMAT + 1), undefined, 0)).toEqual({ kind: 'ready', version: 2 });
    expect(modelState(inst(2), undefined, undefined, 0)).toEqual({ kind: 'ready', version: 2 });
  });
  it('an old error does not hide a working install', () => {
    expect(modelState(inst(2), remote(2), prog({ phase: 'error', error: 'x' }), 0)).toEqual({ kind: 'ready', version: 2 });
  });
  it('a first install needs a newer extension when only another format is published', () => {
    expect(modelState(undefined, remote(1, MODEL_FORMAT + 1), undefined, 0)).toEqual({ kind: 'incompatible' });
  });
});
