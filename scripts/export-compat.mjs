// The 'compat' model (src/shared/model-store.ts): the Default models (UVR MDX-Net 9482 + Spleeter vocals) in fp32, for GPUs
// without WebGPU shader-f16 (the packed ones are fp16). Writes models-out/compat-mdx.onnx and compat-vocals.onnx; upload them
// with `bun run model-manifest compat=1` (see scripts/model-manifest.mjs). Not packed into the extension.
// Same sources as fetch-mdx-model.mjs and fetch-model.mjs; needs python with onnx (uv sync): PY=/path/to/python to override.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDynamicDim } from './onnx-dyn-dim.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'models-out');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const venvPy = ['.venv/bin/python', '.venv/Scripts/python.exe'].map((p) => join(root, p)).find(existsSync);
const python = process.env.PY ?? venvPy ?? (process.platform === 'win32' ? 'python' : 'python3');

async function cached(url, file, sha) {
  const path = join(root, '.cache/models', file);
  if (!existsSync(path) || sha256(readFileSync(path)) !== sha) {
    console.log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  const got = sha256(readFileSync(path));
  if (got !== sha) throw new Error(`${file}: SHA-256 mismatch\n  expected ${sha}\n  actual   ${got}`);
  return path;
}

mkdirSync(outDir, { recursive: true });

const mdx = await cached(
  'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR_MDXNET_9482.onnx',
  'UVR_MDXNET_9482.onnx',
  'f4f365207c56deb115bceedff3ad8fe98a751c745f9e370cecec6226b8b47184',
);
execFileSync(python, ['-W', 'ignore', join(root, 'scripts/mdx-to-fp32.py'), mdx, join(outDir, 'compat-mdx.onnx')], { stdio: 'inherit' });

const MEMBER = 'sherpa-onnx-spleeter-2stems/vocals.onnx';
const tarball = await cached(
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/sherpa-onnx-spleeter-2stems.tar.bz2',
  'sherpa-onnx-spleeter-2stems.tar.bz2',
  'e26401d9c1801f43c0229731d78d32c2e80085e3aceedeb25f29d2de5fa68ca2',
);
const tmp = mkdtempSync(join(tmpdir(), 'export-compat-'));
execFileSync('tar', ['-xjf', tarball, '-C', tmp, MEMBER]);
writeFileSync(join(outDir, 'compat-vocals.onnx'), setDynamicDim(readFileSync(join(tmp, MEMBER))));
for (const f of ['compat-mdx.onnx', 'compat-vocals.onnx']) console.log(f, readFileSync(join(outDir, f)).length, 'bytes');
