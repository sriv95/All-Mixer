import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// ML engine assets (SRI-24, SRI-117): the models are fetched at build time (public/ml/vocals.onnx + mdx.onnx, copied by
// publicDir; the "Best quality" RoFormer is not packed, the user downloads it: src/background/model-manager.ts) and ORT's WebGPU wasm is copied next to the worker, which loads it by URL.
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.mjs'];
function mlAssets(): Plugin {
  return {
    name: 'all-mixer-ml-assets',
    buildStart() {
      for (const f of ['vocals.onnx', 'mdx.onnx']) {
        if (!existsSync(resolve(import.meta.dirname, 'public/ml', f))) this.error(`public/ml/${f} is missing: run bun run fetch-model (mdx.onnx needs PY=python with onnx + onnxconverter-common)`);
      }
    },
    closeBundle() {
      const from = resolve(import.meta.dirname, 'node_modules/onnxruntime-web/dist');
      const to = resolve(import.meta.dirname, 'dist/ml');
      mkdirSync(to, { recursive: true });
      for (const f of ORT_FILES) copyFileSync(resolve(from, f), resolve(to, f));
    },
  };
}

// package.json is the single source of the version (SRI-73): stamp it into dist/manifest.json.
function manifestVersion(): Plugin {
  return {
    name: 'all-mixer-manifest-version',
    closeBundle() {
      const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8'));
      if (!/^\d+(\.\d+){0,3}$/.test(version)) {
        this.error(`package.json version "${version}" is not a valid Chrome manifest version (1-4 dot-separated integers)`);
      }
      const file = resolve(import.meta.dirname, 'dist/manifest.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      manifest.version = version;
      writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    },
  };
}

// Main build: popup page + background service worker (ES module).
// Content script is built separately (vite.content.config.ts) because
// content scripts cannot be ES modules and must be a single IIFE file.
export default defineConfig({
  root: 'src',
  publicDir: resolve(import.meta.dirname, 'public'),
  plugins: [mlAssets(), manifestVersion()],
  worker: { format: 'es', rollupOptions: { output: { entryFileNames: 'ml/[name].js', chunkFileNames: 'ml/[name]-[hash].js' } } },
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'src/popup/popup.html'),
        ml: resolve(import.meta.dirname, 'src/ml/ml.html'),
        background: resolve(import.meta.dirname, 'src/background/background.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
