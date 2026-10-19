// Debug: get becruily's guitar model into the extension on any machine without the Hugging Face repo (for a model that is
// not published yet, or a changed export).
//   bun run fetch-guitar [--no-serve] [--port 8765]
// 1. exports it to models-out (guitar.onnx + guitar-meta.json) unless it is there with scripts/export-roformer.py (needs
//    `uv sync`; downloads a 45 MB checkpoint, about a minute),
// 2. writes a repo of just this model to models-out/guitar-hf (manifest.json + v1/), apart from models-out/hf so a
//    full publish folder is never overwritten,
// 3. serves it on localhost with CORS and Range (the downloader asks for 8 MiB ranges) until Ctrl-C.
// Then, in the extension service-worker console:
//   chrome.storage.local.set({'debug.modelBaseUrl': 'http://localhost:8765'})
// and press Download in the popup (Advanced > Split instrumental), choose Guitar in "Split out", turn the split on. The URL
// replaces the base of every model download.
import { execFileSync } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const FORMAT = 2; // MODEL_FORMAT in src/shared/model-store.ts
const IDS = ['guitar']; // ModelId there
const filesOf = (id) => [`${id}.onnx`, `${id}-meta.json`]; // modelFileNames there
const root = resolve(import.meta.dirname, '..');
const src = resolve(root, 'models-out');
const repo = resolve(src, 'guitar-hf');
const arg = (name) => process.argv.indexOf(name);
const port = arg('--port') > 0 ? Number(process.argv[arg('--port') + 1]) : 8765;

const missing = IDS.filter((id) => !filesOf(id).every((f) => existsSync(resolve(src, f))));
if (missing.length) execFileSync('uv', ['run', 'python', 'scripts/export-roformer.py', ...missing], { cwd: root, stdio: 'inherit' });
mkdirSync(resolve(repo, 'v1'), { recursive: true });
const models = {};
for (const id of IDS) {
  const files = {};
  for (const f of filesOf(id)) {
    copyFileSync(resolve(src, f), resolve(repo, 'v1', f));
    files[f] = statSync(resolve(repo, 'v1', f)).size;
  }
  models[id] = { version: 1, files };
}
writeFileSync(resolve(repo, 'manifest.json'), JSON.stringify({ format: FORMAT, models }) + '\n');
console.log(`wrote ${repo}`, JSON.stringify(models));
if (arg('--no-serve') > 0) process.exit(0);

createServer((req, res) => {
  const p = resolve(repo, '.' + decodeURIComponent(req.url.split('?')[0]));
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length', 'Accept-Ranges': 'bytes' };
  if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
  if (!p.startsWith(repo + '/') || !existsSync(p) || statSync(p).isDirectory()) return void res.writeHead(404, cors).end();
  const size = statSync(p).size;
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  if (!m) return void (res.writeHead(200, { ...cors, 'Content-Length': size }), createReadStream(p).pipe(res));
  const start = Number(m[1]), end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
  if (start > end) return void res.writeHead(416, { ...cors, 'Content-Range': `bytes */${size}` }).end();
  res.writeHead(206, { ...cors, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  createReadStream(p, { start, end }).pipe(res);
}).listen(port, () => {
  console.log(`serving ${repo} on http://localhost:${port} (Ctrl-C to stop)`);
  console.log(`extension service-worker console:\n  chrome.storage.local.set({'debug.modelBaseUrl': 'http://localhost:${port}'})`);
});
