import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Content script: one self-contained IIFE, appended to dist/ after the main build.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: false,
    target: 'chrome120',
    lib: {
      entry: resolve(__dirname, 'src/content/content.ts'),
      formats: ['iife'],
      name: 'AllMixerContent',
      fileName: () => 'content.js',
    },
  },
});
