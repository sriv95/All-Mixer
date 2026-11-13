import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('exits non-zero naming the ids that have no version', () => {
  const r = spawnSync('node', ['scripts/model-manifest.mjs', 'kim2=1', 'deux=2'], { encoding: 'utf8' });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('missing version for: sw, drums, guitar, compat');
});
