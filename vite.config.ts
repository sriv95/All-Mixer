import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// ML engine assets (SRI-24): the model is fetched at build time (public/ml/vocals.onnx, copied by
// publicDir) and ORT's WebGPU wasm is copied next to the worker, which loads it by URL.
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.mjs'];
function mlAssets(): Plugin {
  return {
    name: 'all-mixer-ml-assets',
    buildStart() {
      if (!existsSync(resolve(__dirname, 'public/ml/vocals.onnx'))) {
        this.error('public/ml/vocals.onnx is missing: run npm run fetch-model');
      }
    },
    closeBundle() {
      const from = resolve(__dirname, 'node_modules/onnxruntime-web/dist');
      const to = resolve(__dirname, 'dist/ml');
      mkdirSync(to, { recursive: true });
      for (const f of ORT_FILES) copyFileSync(resolve(from, f), resolve(to, f));
    },
  };
}

// Main build: popup page + background service worker (ES module).
// Content script is built separately (vite.content.config.ts) because
// content scripts cannot be ES modules and must be a single IIFE file.
export default defineConfig({
  root: 'src',
  publicDir: resolve(__dirname, 'public'),
  plugins: [mlAssets()],
  worker: { format: 'es', rollupOptions: { output: { entryFileNames: 'ml/[name].js', chunkFileNames: 'ml/[name]-[hash].js' } } },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/popup.html'),
        ml: resolve(__dirname, 'src/ml/ml.html'),
        background: resolve(__dirname, 'src/background/background.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
