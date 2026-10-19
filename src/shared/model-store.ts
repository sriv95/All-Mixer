// The Mel-Band RoFormer models ("High quality" = Kim fine-tune, "Best quality" = Deux), the drum split model (SCNet
// Tran Small) and the guitar model (debug only) are not packed into the extension: the user downloads each from a public Hugging Face repo into the extension's own storage (OPFS). Pure
// logic shared by the background worker (download), the popup (state text) and the ML page (which model files to
// load). No chrome.* or DOM here.
//
// Repo layout (scripts/model-manifest.mjs writes it); every model has its own version:
//   manifest.json   {"format":2,"models":{"roformer":{"version":1,"files":{"roformer.onnx":457696078,"roformer-meta.json":19712}},"deux":{...},"drums":{"version":1,"files":{"drums.onnx":43105845}}}}
//   v1/roformer.onnx, v1/roformer-meta.json, v1/deux.onnx, v1/deux-meta.json, v1/drums.onnx
// A download is split into CHUNK-sized pieces, one OPFS file each (`v1-roformer.onnx.0007`): an interrupted download
// (the service worker can be stopped at any time) resumes at the first missing piece, and the reader concatenates
// the pieces as a Blob without copying.

/** Public repo with the model files. `chrome.storage.local['debug.modelBaseUrl']` overrides it (QA). */
export const MODEL_BASE_URL = 'https://huggingface.co/sriv95/all-mixer-models/resolve/main';

/** Version of the file contract with src/ml/roformer.ts (mel bands, graph I/O; 2: the frames axis is dynamic). A repo manifest with another format needs another extension version. */
export const MODEL_FORMAT = 2;

export const CHUNK = 8 * 2 ** 20;

/**
 * The downloadable models. 'roformer' and 'deux' are the Model menu entries (src/worklet/protocol.ts MlModel);
 * 'drums' is SCNet Tran Small, the model of Split instrumental (src/ml/scnet.ts). 'guitar' is becruily's Mel-Band
 * RoFormer guitar stem model; it can take the place of the drum model there (src/ml/guitar-stage.ts). Its row and the
 * choice of the split model are hidden unless `chrome.storage.local[GUITAR_DEBUG_KEY]` is true.
 */
export type ModelId = 'roformer' | 'deux' | 'drums' | 'guitar';
export const MODEL_IDS: readonly ModelId[] = ['roformer', 'deux', 'drums', 'guitar'];
/** The Model menu entries (the vocal models). */
export const VOCAL_MODEL_IDS: readonly ModelId[] = ['roformer', 'deux'];
export const GUITAR_DEBUG_KEY = 'debug.guitar';
/** Menu names. */
export const MODEL_LABEL: Readonly<Record<ModelId, string>> = { roformer: 'High quality', deux: 'Best quality', drums: 'Drum split', guitar: 'Guitar split' };
/** The files of a model: weights and, for the RoFormers, the STFT metadata. */
export const modelFileNames = (id: ModelId): string[] => (id === 'drums' ? ['drums.onnx'] : [`${id}.onnx`, `${id}-meta.json`]);

/** Files of one model version, name → size in bytes. */
export type ModelFileSizes = Record<string, number>;

export interface RemoteModel {
  format: number;
  version: number;
  files: ModelFileSizes;
}

/** chrome.storage.local keys, one set per model. */
export const keyInstalled = (id: ModelId): string => `modelInstalled.${id}`;
export const keyRemote = (id: ModelId): string => `modelRemote.${id}`;
export const keyProgress = (id: ModelId): string => `modelProgress.${id}`;

/** What is on disk: the version that was downloaded completely. */
export interface InstalledModel {
  /** MODEL_FORMAT of the files; a missing or other value means they are from an older extension and must be downloaded again. */
  format?: number;
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

/** Validate a manifest fetched from the network: the models it lists correctly (others are left out); null when there is none. */
export function parseManifest(raw: unknown): Partial<Record<ModelId, RemoteModel>> | null {
  const r = raw as { format?: unknown; models?: Record<string, Partial<RemoteModel> | null> } | null;
  if (!r || !Number.isSafeInteger(r.format) || !r.models || typeof r.models !== 'object') return null;
  const out: Partial<Record<ModelId, RemoteModel>> = {};
  for (const id of MODEL_IDS) {
    const m = r.models[id];
    if (!m || !Number.isSafeInteger(m.version) || (m.version as number) < 1 || !isSizes(m.files)) continue;
    const files = m.files;
    if (modelFileNames(id).every((f) => f in files)) out[id] = { format: r.format as number, version: m.version as number, files };
  }
  return Object.keys(out).length ? out : null;
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
export function modelState(installedRec: InstalledModel | undefined, remote: RemoteRecord | undefined, progress: Progress | undefined, now: number): ModelState {
  const installed = installedRec?.format === MODEL_FORMAT ? installedRec : undefined;
  if (progress?.phase === 'downloading' && now - progress.at < STALL_MS) return { kind: 'downloading', done: progress.done, total: progress.total };
  const usable = remote && remote.format === MODEL_FORMAT ? remote : undefined;
  if (progress?.phase === 'error' && (!installed || (usable && usable.version > installed.version))) return { kind: 'error', message: progress.error ?? 'download failed' };
  if (!installed) return remote && !usable ? { kind: 'incompatible' } : { kind: 'missing', size: usable ? totalBytes(usable.files) : null };
  if (usable && usable.version > installed.version) return { kind: 'update', version: usable.version, size: totalBytes(usable.files) };
  return { kind: 'ready', version: installed.version };
}

export const mb = (bytes: number): string => `${Math.round(bytes / 2 ** 20)} MB`;
