import { opfsFiles, pruneModel, type ModelFiles } from '../shared/model-files';
import {
  CHUNK, MODEL_BASE_URL, MODEL_FORMAT, MODEL_IDS,
  chunkCount, chunkLength, chunkName, fileUrl, keyInstalled, keyProgress, keyRemote, manifestUrl, parseManifest, totalBytes,
  type InstalledModel, type ModelId, type Progress, type RemoteModel, type RemoteRecord,
} from '../shared/model-store';

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;

/**
 * Looks for newer RoFormer models and downloads one into OPFS, 8 MiB per request with a Range header.
 * Progress, the installed version and the last manifest entry of each model are kept in chrome.storage.local (the
 * popup and the content scripts watch it). Installed = every chunk of every file is on disk; only then is the
 * model's installed key written.
 */
export class ModelManager {
  private readonly running = new Map<ModelId, Promise<void>>();

  constructor(
    private readonly area: Area,
    private readonly files: ModelFiles = opfsFiles(),
    private readonly fetchFn: typeof fetch = (i, o) => fetch(i, o),
    private readonly now: () => number = Date.now,
  ) {}

  /** QA: chrome.storage.local['debug.modelBaseUrl'] points the download at another server. */
  private async base(): Promise<string> {
    const o = await this.area.get('debug.modelBaseUrl');
    return typeof o['debug.modelBaseUrl'] === 'string' ? (o['debug.modelBaseUrl'] as string) : MODEL_BASE_URL;
  }

  /** Fetch the manifest and remember each model's entry. null: offline, or not a valid manifest (the old records stay). */
  async check(): Promise<Partial<Record<ModelId, RemoteRecord>> | null> {
    const remote = await this.fetchManifest().catch(() => null);
    if (!remote) return null;
    const recs: Partial<Record<ModelId, RemoteRecord>> = {};
    for (const id of MODEL_IDS) {
      const m = remote[id];
      if (m) recs[id] = { ...m, checkedAt: this.now() };
    }
    await this.area.set(Object.fromEntries(Object.entries(recs).map(([id, rec]) => [keyRemote(id as ModelId), rec])));
    return recs;
  }

  private async fetchManifest(): Promise<Partial<Record<ModelId, RemoteModel>> | null> {
    const res = await this.fetchFn(manifestUrl(await this.base()), { cache: 'no-store' });
    return res.ok ? parseManifest(await res.json()) : null;
  }

  /** Download the newest version of model `id` (resumes a partial download). Calls for the same model while one runs share it. */
  install(id: ModelId): Promise<void> {
    let p = this.running.get(id);
    if (!p) {
      p = this.run(id).finally(() => this.running.delete(id));
      this.running.set(id, p);
    }
    return p;
  }

  /** Forget model `id` and delete its chunks. A running download of it is not stopped (the UI offers this only for an installed model). */
  async uninstall(id: ModelId): Promise<void> {
    await this.area.remove(keyInstalled(id));
    await this.area.remove(keyProgress(id));
    await pruneModel(this.files, id, { version: 0, files: {} });
  }

  private async run(id: ModelId): Promise<void> {
    let version = 0, total = 0;
    try {
      const manifest = await this.fetchManifest();
      if (!manifest) throw new Error('could not read the model list (offline?)');
      const remote = manifest[id];
      if (!remote) throw new Error('this model is not published yet');
      if (remote.format !== MODEL_FORMAT) throw new Error('this model needs a newer version of the extension');
      version = remote.version;
      total = totalBytes(remote.files);
      const base = await this.base();
      let done = 0, lastWrite = 0;
      const progress = async (force = false) => {
        const t = this.now();
        if (!force && t - lastWrite < 500) return;
        lastWrite = t;
        await this.area.set({ [keyProgress(id)]: { phase: 'downloading', version, done, total, at: t } satisfies Progress });
      };
      await progress(true);
      for (const [file, size] of Object.entries(remote.files).sort(([, a], [, b]) => a - b)) {
        for (let i = 0; i < chunkCount(size); i++) {
          const len = chunkLength(size, i), name = chunkName(version, file, i);
          if ((await this.files.size(name)) !== len) {
            const from = i * CHUNK;
            const res = await this.fetchFn(fileUrl(base, version, file), { headers: { Range: `bytes=${from}-${from + len - 1}` } });
            if (res.status !== 206) throw new Error(`${file}: HTTP ${res.status}`);
            const data = new Uint8Array(await res.arrayBuffer());
            if (data.length !== len) throw new Error(`${file}: got ${data.length} bytes, expected ${len}`);
            await this.files.put(name, data);
          }
          done += len;
          await progress();
        }
      }
      const installed: InstalledModel = { format: remote.format, version, files: remote.files };
      await this.area.set({ [keyInstalled(id)]: installed, [keyRemote(id)]: { ...remote, checkedAt: this.now() } satisfies RemoteRecord });
      await this.area.remove(keyProgress(id));
      await pruneModel(this.files, id, installed);
    } catch (e) {
      await this.area.set({ [keyProgress(id)]: { phase: 'error', version, done: 0, total, at: this.now(), error: e instanceof Error ? e.message : String(e) } satisfies Progress });
    }
  }
}
