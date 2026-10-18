import { opfsFiles, pruneModels, type ModelFiles } from '../shared/model-files';
import {
  CHUNK, KEY_INSTALLED, KEY_PROGRESS, KEY_REMOTE, MODEL_BASE_URL, MODEL_FORMAT,
  chunkCount, chunkLength, chunkName, fileUrl, manifestUrl, parseManifest, totalBytes,
  type InstalledModel, type Progress, type RemoteModel, type RemoteRecord,
} from '../shared/model-store';

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;

/**
 * Looks for a newer "Best quality" model and downloads it into OPFS, 8 MiB per request with a Range header.
 * Progress, the installed version and the last manifest are kept in chrome.storage.local (the popup and the
 * content scripts watch it). Installed = every chunk of every file is on disk; only then is KEY_INSTALLED written.
 */
export class ModelManager {
  private running: Promise<void> | null = null;

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

  /** Fetch the manifest and remember it. null: offline, or not a valid manifest (the old record stays). */
  async check(): Promise<RemoteRecord | null> {
    const remote = await this.fetchManifest().catch(() => null);
    if (!remote) return null;
    const rec: RemoteRecord = { ...remote, checkedAt: this.now() };
    await this.area.set({ [KEY_REMOTE]: rec });
    return rec;
  }

  private async fetchManifest(): Promise<RemoteModel | null> {
    const res = await this.fetchFn(manifestUrl(await this.base()), { cache: 'no-store' });
    return res.ok ? parseManifest(await res.json()) : null;
  }

  /** Download the newest model (resumes a partial download). Calls while one runs share it. */
  install(): Promise<void> {
    return (this.running ??= this.run().finally(() => (this.running = null)));
  }

  private async run(): Promise<void> {
    let version = 0, total = 0;
    try {
      const remote = await this.fetchManifest();
      if (!remote) throw new Error('could not read the model list (offline?)');
      if (remote.format !== MODEL_FORMAT) throw new Error('this model needs a newer version of the extension');
      version = remote.version;
      total = totalBytes(remote.files);
      const base = await this.base();
      let done = 0, lastWrite = 0;
      const progress = async (force = false) => {
        const t = this.now();
        if (!force && t - lastWrite < 500) return;
        lastWrite = t;
        await this.area.set({ [KEY_PROGRESS]: { phase: 'downloading', version, done, total, at: t } satisfies Progress });
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
      const installed: InstalledModel = { version, files: remote.files };
      await this.area.set({ [KEY_INSTALLED]: installed, [KEY_REMOTE]: { ...remote, checkedAt: this.now() } satisfies RemoteRecord });
      await this.area.remove(KEY_PROGRESS);
      await pruneModels(this.files, installed);
    } catch (e) {
      await this.area.set({ [KEY_PROGRESS]: { phase: 'error', version, done: 0, total, at: this.now(), error: e instanceof Error ? e.message : String(e) } satisfies Progress });
    }
  }
}
