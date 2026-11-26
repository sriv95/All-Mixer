import { resolve } from 'node:path';

// Build target shared by every vite config: Chrome by default, Firefox with FIREFOX=1 (npm run build:firefox).
export const FIREFOX = process.env.FIREFOX === '1';
export const outDir = resolve(import.meta.dirname, FIREFOX ? 'dist-firefox' : 'dist');
export const buildTarget = FIREFOX ? 'firefox128' : 'chrome120';
// Compile-time flag (typed in src/vite-env-target.d.ts): lets Firefox-only code tree-shake out of the Chrome bundle.
export const define = { __FIREFOX__: JSON.stringify(FIREFOX) };
