// Build-time fetch of the Default vocal model (UVR MDX-Net 9482 retrained, hosted fp32 'compat' v2) (SRI-117): download, verify SHA-256, convert to fp16
// weights (fp32 input/output, dynamic time axis, scripts/mdx-to-fp16.py) and write public/ml/mdx.onnx.
// Needs python with onnx + onnxconverter-common: PY=/path/to/python node scripts/fetch-mdx-model.mjs [--from <onnx>]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'https://huggingface.co/sriv95/all-mixer-models/resolve/main/v2/compat-mdx.onnx'; // same repo as MODEL_BASE_URL (src/shared/model-store.ts)
const SOURCE_SHA256 = '396cf20f6299a02c76992020dc4156b70bb715605e3be47dd808cac147a48dbf';
const OUTPUT_BYTES = 14872262; // fp16 file with onnx 1.23 / onnxconverter-common 1.16; other versions may differ by a few bytes

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheFile = join(root, '.cache/models/compat-mdx-v2.onnx');
const outFile = join(root, 'public/ml/mdx.onnx');
// PY wins; else the uv venv (POSIX bin/ or Windows Scripts/), else whatever python is on PATH.
const venvPy = ['.venv/bin/python', '.venv/Scripts/python.exe'].map((p) => join(root, p)).find(existsSync);
const python = process.env.PY ?? venvPy ?? (process.platform === 'win32' ? 'python' : 'python3');
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
execFileSync(python, ['-W', 'ignore', join(root, 'scripts/mdx-to-fp16.py'), src, outFile], { stdio: 'inherit' });
const out = readFileSync(outFile);
if (Math.abs(out.length - OUTPUT_BYTES) > 4096) throw new Error(`unexpected fp16 model size ${out.length} (expected ≈ ${OUTPUT_BYTES})`);
console.log(`wrote ${outFile}\n  sha256 ${sha256(out)}\n  size   ${out.length} bytes`);
