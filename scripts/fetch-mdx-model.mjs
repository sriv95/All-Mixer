// Build-time fetch of the UVR MDX-Net 9482 vocal model (SRI-117): download, verify SHA-256, convert to fp16
// weights (fp32 input/output, dynamic time axis, scripts/mdx-to-fp16.py) and write public/ml/mdx.onnx.
// Needs python with onnx + onnxconverter-common: PY=/path/to/python node scripts/fetch-mdx-model.mjs [--from <onnx>]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR_MDXNET_9482.onnx';
const SOURCE_SHA256 = 'f4f365207c56deb115bceedff3ad8fe98a751c745f9e370cecec6226b8b47184';
const OUTPUT_BYTES = 14872262; // fp16 file with onnx 1.23 / onnxconverter-common 1.16; other versions may differ by a few bytes

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheFile = join(root, '.cache/models/UVR_MDXNET_9482.onnx');
const outFile = join(root, 'public/ml/mdx.onnx');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

async function getSource() {
  const i = process.argv.indexOf('--from');
  if (i !== -1) {
    const p = process.argv[i + 1];
    if (!p) throw new Error('--from needs a path');
    return resolve(p);
  }
  if (existsSync(cacheFile) && sha256(readFileSync(cacheFile)) === SOURCE_SHA256) {
    console.log(`cache hit: ${cacheFile} (no download)`);
    return cacheFile;
  }
  console.log(`downloading ${URL_}`);
  const res = await fetch(URL_);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, Buffer.from(await res.arrayBuffer()));
  return cacheFile;
}

const src = await getSource();
const got = sha256(readFileSync(src));
if (got !== SOURCE_SHA256) throw new Error(`${src}: SHA-256 mismatch\n  expected ${SOURCE_SHA256}\n  actual   ${got}`);
mkdirSync(dirname(outFile), { recursive: true });
execFileSync(process.env.PY ?? 'python3', ['-W', 'ignore', join(root, 'scripts/mdx-to-fp16.py'), src, outFile], { stdio: 'inherit' });
const out = readFileSync(outFile);
if (Math.abs(out.length - OUTPUT_BYTES) > 4096) throw new Error(`unexpected fp16 model size ${out.length} (expected ≈ ${OUTPUT_BYTES})`);
console.log(`wrote ${outFile}\n  sha256 ${sha256(out)}\n  size   ${out.length} bytes`);
