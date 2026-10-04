// Build-time fetch of the Spleeter vocals model (SRI-5 §0.2): download, verify SHA-256,
// make the time axis dynamic, write public/ml/vocals.onnx. Usage: node scripts/fetch-model.mjs [--from <tarball>]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setDynamicDim } from './onnx-dyn-dim.mjs';

const URL_ =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/sherpa-onnx-spleeter-2stems-fp16.tar.bz2';
const TARBALL_SHA256 = 'd54561979bd2e08a51e7dbd99ac36bb47564e089eefd403636dbca93e811bba2';
const MEMBER = 'sherpa-onnx-spleeter-2stems-fp16/vocals.fp16.onnx';
const MEMBER_SHA256 = '24cef84aedcd1fe87c0b743ef3370ad34dc1fabf6c9014d6128a75a538c7b668';
const OUTPUT_SHA256 = '75af77bb97da4a25a1ea5d86cc70785228e517ef00e3bb9e3e6bc893dcda8e51';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheFile = join(root, '.cache/models/sherpa-onnx-spleeter-2stems-fp16.tar.bz2');
const outFile = join(root, 'public/ml/vocals.onnx');

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
function check(what, buf, want) {
  const got = sha256(buf);
  if (got !== want) {
    throw new Error(`${what}: SHA-256 mismatch\n  expected ${want}\n  actual   ${got}`);
  }
}

async function getTarball() {
  const i = process.argv.indexOf('--from');
  if (i !== -1) {
    const p = process.argv[i + 1];
    if (!p) throw new Error('--from needs a path');
    const buf = readFileSync(resolve(p));
    check(`tarball ${p}`, buf, TARBALL_SHA256);
    console.log(`using local tarball ${p}`);
    return buf;
  }
  if (existsSync(cacheFile)) {
    const buf = readFileSync(cacheFile);
    if (sha256(buf) === TARBALL_SHA256) {
      console.log(`cache hit: ${cacheFile} (no download)`);
      return buf;
    }
    console.log('cached tarball hash mismatch, re-downloading');
  }
  console.log(`downloading ${URL_}`);
  const res = await fetch(URL_);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  check('downloaded tarball', buf, TARBALL_SHA256);
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, buf);
  return buf;
}

const tarball = await getTarball();
const tmp = mkdtempSync(join(tmpdir(), 'fetch-model-'));
try {
  const tarPath = join(tmp, 'm.tar.bz2');
  writeFileSync(tarPath, tarball);
  execFileSync('tar', ['-xjf', tarPath, '-C', tmp, MEMBER]);
  const src = readFileSync(join(tmp, MEMBER));
  check('vocals.fp16.onnx', src, MEMBER_SHA256);
  const out = setDynamicDim(src);
  check('patched vocals.onnx', out, OUTPUT_SHA256);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, out);
  console.log(`wrote ${outFile}\n  sha256 ${sha256(out)}\n  size   ${out.length} bytes`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
