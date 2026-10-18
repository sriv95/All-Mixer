import { describe, expect, it } from 'vitest';
import { customFound } from './custom';

describe('customFound', () => {
  it('timestamped text is synced', () => {
    const f = customFound('[00:01.00] a\n[00:02.00] b\n[00:03.00] c\n[00:04.00] d\n');
    expect(f?.synced).toContain('[00:01.00] a');
    expect(f?.plain).toBeUndefined();
  });

  it('other text is plain, and the track names go into the record', () => {
    const f = customFound('a\nb\nc\nd', { title: 'Song', artist: 'Band', duration: 200 });
    expect(f?.plain).toBe('a\nb\nc\nd');
    expect(f?.synced).toBeUndefined();
    expect(f?.record).toMatchObject({ trackName: 'Song', artistName: 'Band', duration: 200 });
  });

  it('too short is null', () => {
    expect(customFound('one line')).toBeNull();
    expect(customFound('  ')).toBeNull();
  });
});
