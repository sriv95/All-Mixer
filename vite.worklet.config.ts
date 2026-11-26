import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { buildTarget, define, outDir } from './vite.target';

// Separator AudioWorklet: one self-contained ES module, loaded by the content
// script with audioWorklet.addModule(chrome.runtime.getURL(...)).
export default defineConfig({
  publicDir: false,
  define,
  build: {
    outDir: resolve(outDir, 'worklet'),
    emptyOutDir: false,
    target: buildTarget,
    lib: {
      entry: resolve(import.meta.dirname, 'src/worklet/separator-processor.ts'),
      formats: ['es'],
      fileName: () => 'separator-worklet.js',
    },
  },
});
