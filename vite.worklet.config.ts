import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Separator AudioWorklet: one self-contained ES module, loaded by the content
// script with audioWorklet.addModule(chrome.runtime.getURL(...)).
export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'dist/worklet'),
    emptyOutDir: false,
    target: 'chrome120',
    lib: {
      entry: resolve(import.meta.dirname, 'src/worklet/separator-processor.ts'),
      formats: ['es'],
      fileName: () => 'separator-worklet.js',
    },
  },
});
