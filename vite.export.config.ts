import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Export engine (src/export/engine.ts): one self-contained ES module with the encoders (mediabunny, LAME). The content script
// loads it with import(chrome.runtime.getURL('export/engine.js')) when the first export starts, so pages that never export do not carry it.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'dist/export'),
    emptyOutDir: false,
    target: 'chrome120',
    lib: {
      entry: resolve(import.meta.dirname, 'src/export/engine.ts'),
      formats: ['es'],
      fileName: () => 'engine.js',
    },
  },
});
