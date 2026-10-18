import { describe, expect, it } from 'vitest';
import type { ContentStatus } from './messages';
import { separationView } from './separation-view';

const status = (sep?: Partial<NonNullable<ContentStatus['separation']>>): ContentStatus =>
  ({ site: 'youtube', videoFound: true, audio: 'active', gain: 1, videoDelay: { state: 'off', delayMs: 0 },
    separation: sep && { state: 'on', latency: { processingMs: 1949 }, ...sep } }) as unknown as ContentStatus;

describe('separationView', () => {
  it('is off in Default mode and without separation info', () => {
    expect(separationView('default', status({ state: 'on' }))).toEqual({ kind: 'off' });
    expect(separationView('separate', status())).toEqual({ kind: 'off' });
    expect(separationView('separate', undefined)).toEqual({ kind: 'off' });
    expect(separationView('separate', status({ state: 'off' }))).toEqual({ kind: 'off' });
  });

  it('is warming while the separator loads or ML warms up', () => {
    expect(separationView('separate', status({ state: 'loading' }))).toEqual({ kind: 'warming' });
    expect(separationView('separate', status({ choice: { state: 'warming' } }))).toEqual({ kind: 'warming' });
  });

  it('is live with the delay in seconds with one decimal', () => {
    expect(separationView('separate', status({ choice: { state: 'on' } }))).toEqual({ kind: 'live', delayS: '1.9' });
  });

  it('carries the cause of unavailable, stopped and error', () => {
    expect(separationView('separate', status({ choice: { state: 'unavailable', cause: 'no webgpu' } }))).toEqual({ kind: 'unavailable', cause: 'no webgpu' });
    expect(separationView('separate', status({ choice: { state: 'stopped', cause: 'ML missed its deadline' } }))).toEqual({ kind: 'stopped', cause: 'ML missed its deadline' });
    expect(separationView('separate', status({ state: 'error', error: 'no worklet' }))).toEqual({ kind: 'error', cause: 'no worklet' });
    expect(separationView('separate', status({ state: 'error' }))).toEqual({ kind: 'error', cause: 'unknown' });
  });
});
