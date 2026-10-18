// The "Best quality" model (Mel-Band RoFormer, Kim fine-tune) is not packed into the extension: the user downloads it
// from a public Hugging Face repo into the extension's own storage (OPFS). Pure logic shared by the background worker
// (download), the popup (state text) and the ML page (which model files to load). No chrome.* or DOM here.
//
// Repo layout (scripts/model-manifest.mjs writes it):
//   manifest.json                {"format":1,"version":2,"files":{"roformer.onnx":457696078,"roformer-meta.json":19712}}
//   v2/roformer.onnx, v2/roformer-meta.json
// A download is split into CHUNK-sized pieces, one OPFS file each (`v2-roformer.onnx.0007`): an interrupted download
// (the service worker can be stopped at any time) resumes at the first missing piece, and the reader concatenates
// the pieces as a Blob without copying.

/** Public repo with the model files. `chrome.storage.local['debug.modelBaseUrl']` overrides it (QA). */
export const MODEL_BASE_URL = 'https://huggingface.co/sriv95/all-mixer-models/resolve/main';

/** Version of the file contract with src/ml/roformer.ts (chunk length, mel bands, graph I/O). A repo manifest with another format needs another extension version. */
export const MODEL_FORMAT = 1;

export const CHUNK = 8 * 2 ** 20;

/** Files of one model version, name → size in bytes. */
export type ModelFileSizes = Record<string, number>;

export interface RemoteModel {
  format: number;
  version: number;
  files: ModelFileSizes;
}

/** chrome.storage.local keys */
export const KEY_INSTALLED = 'modelInstalled';
export const KEY_REMOTE = 'modelRemote';
export const KEY_PROGRESS = 'modelProgress';

/** What is on disk: the version that was downloaded completely. */
export interface InstalledModel {
  version: number;
  files: ModelFileSizes;
}

/** Last manifest fetched. */
export interface RemoteRecord extends RemoteModel {
  checkedAt: number;
}

export interface Progress {
  /** 'error' keeps the message in `error`. */
  phase: 'downloading' | 'error';
  version: number;
  done: number;
  total: number;
  /** Date.now() of the last update; a "downloading" record older than STALL_MS means the worker was stopped. */
  at: number;
  error?: string;
}

export const STALL_MS = 30_000;

const isSizes = (v: unknown): v is ModelFileSizes =>
  !!v && typeof v === 'object' && Object.values(v).every((n) => Number.isSafeInteger(n) && (n as number) > 0);

/** Validate a manifest fetched from the network. */
export function parseManifest(raw: unknown): RemoteModel | null {
  const r = raw as Partial<RemoteModel> | null;
  if (!r || !Number.isSafeInteger(r.version) || (r.version as number) < 1 || !Number.isSafeInteger(r.format)) return null;
  if (!isSizes(r.files) || !('roformer.onnx' in r.files) || !('roformer-meta.json' in r.files)) return null;
  return { format: r.format as number, version: r.version as number, files: r.files };
}

export const fileUrl = (base: string, version: number, name: string): string => `${base}/v${version}/${name}`;
export const manifestUrl = (base: string): string => `${base}/manifest.json`;
export const chunkName = (version: number, file: string, i: number): string => `v${version}-${file}.${String(i).padStart(4, '0')}`;
export const chunkCount = (size: number): number => Math.ceil(size / CHUNK);
export const chunkLength = (size: number, i: number): number => Math.min(CHUNK, size - i * CHUNK);
export const totalBytes = (files: ModelFileSizes): number => Object.values(files).reduce((a, b) => a + b, 0);

export type ModelState =
  | { kind: 'missing'; size: number | null }
  | { kind: 'downloading'; done: number; total: number }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; version: number }
  | { kind: 'update'; version: number; size: number }
  | { kind: 'incompatible' };

/** What the popup shows, from the three storage records. */
export function modelState(installed: InstalledModel | undefined, remote: RemoteRecord | undefined, progress: Progress | undefined, now: number): ModelState {
  if (progress?.phase === 'downloading' && now - progress.at < STALL_MS) return { kind: 'downloading', done: progress.done, total: progress.total };
  const usable = remote && remote.format === MODEL_FORMAT ? remote : undefined;
  if (progress?.phase === 'error' && (!installed || (usable && usable.version > installed.version))) return { kind: 'error', message: progress.error ?? 'download failed' };
  if (!installed) return remote && !usable ? { kind: 'incompatible' } : { kind: 'missing', size: usable ? totalBytes(usable.files) : null };
  if (usable && usable.version > installed.version) return { kind: 'update', version: usable.version, size: totalBytes(usable.files) };
  return { kind: 'ready', version: installed.version };
}

export const mb = (bytes: number): string => `${Math.round(bytes / 2 ** 20)} MB`;
