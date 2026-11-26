import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { buildTarget, define, FIREFOX, outDir } from './vite.target';

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
      const to = resolve(outDir, 'ml');
      mkdirSync(to, { recursive: true });
      for (const f of ORT_FILES) copyFileSync(resolve(from, f), resolve(to, f));
    },
  };
}

// package.json is the single source of the version (SRI-73): stamp it into the built manifest.json (dist/, or dist-firefox/ merged with manifest.firefox.json).
function manifestVersion(): Plugin {
  return {
    name: 'all-mixer-manifest-version',
    closeBundle() {
      const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8'));
      if (!/^\d+(\.\d+){0,3}$/.test(version)) {
        this.error(`package.json version "${version}" is not a valid Chrome manifest version (1-4 dot-separated integers)`);
      }
      const file = resolve(outDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      if (FIREFOX) {
        // Shallow overlay; null deletes the key.
        const overlay = JSON.parse(readFileSync(resolve(import.meta.dirname, 'manifest.firefox.json'), 'utf8'));
        for (const [k, v] of Object.entries(overlay)) { if (v === null) delete manifest[k]; else manifest[k] = v; }
      }
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
  define,
  plugins: [tailwindcss(), mlAssets(), manifestVersion()],
  worker: { format: 'es', rollupOptions: { output: { entryFileNames: 'ml/[name].js', chunkFileNames: 'ml/[name]-[hash].js' } } },
  build: {
    outDir,
    emptyOutDir: true,
    target: buildTarget,
    modulePreload: false,
    rollupOptions: {
      // lucide-react marks files "use client" (React Server Components): meaningless in a popup bundle.
      onwarn(warning, warn) {
        if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
      },
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
