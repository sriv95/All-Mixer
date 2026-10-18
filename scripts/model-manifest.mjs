// Prepare the downloadable RoFormer models for upload to the public Hugging Face repo that the extension downloads
// from (MODEL_BASE_URL in src/shared/model-store.ts):
//   bun run export-roformer                           -> models-out/{roformer,deux}.onnx + -meta.json
//   bun run model-manifest roformer=1 deux=1          -> models-out/hf/manifest.json + models-out/hf/v<version>/...
//   hf upload <owner>/<repo> models-out/hf .
// List every model with its version (an unchanged model keeps its number; its files are only used for the sizes).
// Upload the version folders first and manifest.json last: the extension offers an update as soon as the manifest names it.
// A new version number means new weights or a new export of the same format; a change of the file contract with
// src/ml/roformer.ts needs a new MODEL_FORMAT in the extension and here.
import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FORMAT = 2; // MODEL_FORMAT in src/shared/model-store.ts
const IDS = ['roformer', 'deux']; // MODEL_IDS in src/shared/model-store.ts
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const bad = Object.entries(args).filter(([id, v]) => !IDS.includes(id) || !Number.isSafeInteger(Number(v)) || Number(v) < 1);
if (bad.length || !Object.keys(args).length) {
  console.error(`usage: node scripts/model-manifest.mjs ${IDS.map((id) => `${id}=<version, integer >= 1>`).join(' ')}`);
  process.exit(1);
}
const src = resolve(import.meta.dirname, '../models-out');
const out = resolve(src, 'hf');
const models = {};
for (const [id, v] of Object.entries(args)) {
  const dir = resolve(out, `v${v}`);
  mkdirSync(dir, { recursive: true });
  const files = {};
  for (const f of [`${id}.onnx`, `${id}-meta.json`]) {
    copyFileSync(resolve(src, f), resolve(dir, f));
    files[f] = statSync(resolve(dir, f)).size;
  }
  models[id] = { version: Number(v), files };
}
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify({ format: FORMAT, models }) + '\n');
console.log(`wrote ${out}/manifest.json`, JSON.stringify(models));
