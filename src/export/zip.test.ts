import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crc32, zip } from './zip';

const enc = (s: string) => new TextEncoder().encode(s);

describe('zip', () => {
  it('crc32 matches the reference value', () => {
    expect(crc32(enc('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('writes a structure that unzip can read back byte for byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'am-zip-'));
    const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 31) & 255);
    writeFileSync(join(dir, 'a.zip'), zip([{ name: '01-mix.mp3', data: bytes }, { name: '02-vocals.mp3', data: enc('héllo') }, { name: 'empty.bin', data: new Uint8Array(0) }]));
    try {
      expect(execFileSync('unzip', ['-t', join(dir, 'a.zip')]).toString()).toMatch(/No errors detected/);
      expect(new Uint8Array(execFileSync('unzip', ['-p', join(dir, 'a.zip'), '01-mix.mp3'], { maxBuffer: 1 << 24 }))).toEqual(bytes);
      expect(execFileSync('unzip', ['-p', join(dir, 'a.zip'), '02-vocals.mp3']).toString()).toBe('héllo');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // no unzip on this machine: the checks above are skipped
      throw e;
    }
    expect(readFileSync(join(dir, 'a.zip')).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4]));
  });
});
