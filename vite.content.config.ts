import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Content scripts: self-contained IIFEs, appended to dist/ after the main build.
// ENTRY=page builds the main-world bridge (src/page/bridge.ts) instead, ENTRY=media the main-world media hook.
const entry = {
  page: { src: 'src/page/bridge.ts', name: 'AllMixerPage', file: 'page-bridge.js' },
  media: { src: 'src/page/media-hook.ts', name: 'AllMixerMedia', file: 'page-media-hook.js' },
}[process.env.ENTRY ?? ''] ?? { src: 'src/content/content.ts', name: 'AllMixerContent', file: 'content.js' };

export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: false,
    target: 'chrome120',
    lib: {
      entry: resolve(__dirname, entry.src),
      formats: ['iife'],
      name: entry.name,
      fileName: () => entry.file,
    },
  },
});
