import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Content scripts: self-contained IIFEs, appended to dist/ after the main build.
// ENTRY=page builds the main-world bridge (src/page/bridge.ts) instead.
const page = process.env.ENTRY === 'page';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: false,
    target: 'chrome120',
    lib: {
      entry: resolve(__dirname, page ? 'src/page/bridge.ts' : 'src/content/content.ts'),
      formats: ['iife'],
      name: page ? 'AllMixerPage' : 'AllMixerContent',
      fileName: () => (page ? 'page-bridge.js' : 'content.js'),
    },
  },
});
