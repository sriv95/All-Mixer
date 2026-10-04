// Loads public/ml/vocals.onnx in onnxruntime-web (WASM EP, from spike/node_modules) and runs it.
// Usage: node scripts/check-model-session.mjs [reference.onnx]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../spike/package.json', import.meta.url));
const ort = require('onnxruntime-web');
ort.env.wasm.numThreads = 1;

const run = async (path, data, dims) => {
  const s = await ort.InferenceSession.create(readFileSync(path), { executionProviders: ['wasm'] });
  console.log(path, 'inputs', s.inputNames, 'outputs', s.outputNames);
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, dims) });
  const t = out[s.outputNames[0]];
  return t;
};

const zeros = await run('public/ml/vocals.onnx', new Float32Array(2 * 64 * 1024), [2, 1, 64, 1024]);
console.log('zeros [2,1,64,1024] ->', zeros.dims, 'max', Math.max(...zeros.data.subarray(0, 4096)));
const raw = readFileSync('spike/bench/ref/parity/x.f32');
const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const ref = process.argv[2] ?? 'spike/ml/models/vocals_stream.onnx';
for (const T of [64, 128]) {
  const xs = x.slice(0, 2 * T * 1024);
  const a = await run('public/ml/vocals.onnx', xs, [2, 1, T, 1024]);
  const b = await run(ref, xs, [2, 1, T, 1024]);
  let d = 0;
  for (let i = 0; i < a.data.length; i++) d = Math.max(d, Math.abs(a.data[i] - b.data[i]));
  console.log(`T=${T} out ${a.dims} max abs diff vs ${ref}: ${d}`);
}
