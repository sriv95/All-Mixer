// Prepare the "Best quality" model for upload to the public Hugging Face repo that the extension downloads from
// (MODEL_BASE_URL in src/shared/model-store.ts):
//   bun run export-roformer            -> models-out/roformer.onnx + roformer-meta.json
//   bun run model-manifest <version>   -> models-out/hf/manifest.json + models-out/hf/v<version>/...
//   hf upload <owner>/<repo> models-out/hf .
// Upload the version folder first and manifest.json last: the extension offers an update as soon as the manifest names it.
// A new version number means new weights or a new export of the same format; a change of the file contract with
// src/ml/roformer.ts needs a new MODEL_FORMAT in the extension and here.
import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FORMAT = 1; // MODEL_FORMAT in src/shared/model-store.ts
const version = Number(process.argv[2]);
if (!Number.isSafeInteger(version) || version < 1) {
  console.error('usage: node scripts/model-manifest.mjs <version, integer >= 1>');
  process.exit(1);
}
const src = resolve(import.meta.dirname, '../models-out');
const out = resolve(src, 'hf');
const dir = resolve(out, `v${version}`);
mkdirSync(dir, { recursive: true });
const files = {};
for (const f of ['roformer.onnx', 'roformer-meta.json']) {
  copyFileSync(resolve(src, f), resolve(dir, f));
  files[f] = statSync(resolve(dir, f)).size;
}
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify({ format: FORMAT, version, files }) + '\n');
console.log(`wrote ${out}/manifest.json and v${version}/`, files);
