import { chunkCount, chunkName, modelFileNames, type ModelFileSizes, type ModelId } from './model-store';

/** Byte storage for the downloaded model: OPFS in the extension, a Map in tests. */
export interface ModelFiles {
  /** Size in bytes, -1 when the file does not exist. */
  size(name: string): Promise<number>;
  put(name: string, data: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  list(): Promise<string[]>;
  /** The named files, in order, as one Blob. */
  blob(names: string[]): Promise<Blob>;
}

/** OPFS directory `models/` of the extension origin (shared by the service worker, popup and the ML worker). */
export function opfsFiles(): ModelFiles {
  const dir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('models', { create: true });
  return {
    async size(name) {
      try {
        return (await (await (await dir()).getFileHandle(name)).getFile()).size;
      } catch {
        return -1;
      }
    },
    async put(name, data) {
      const w = await (await (await dir()).getFileHandle(name, { create: true })).createWritable();
      await w.write(data as BufferSource);
      await w.close();
    },
    async remove(name) {
      await (await dir()).removeEntry(name).catch(() => {});
    },
    async list() {
      const names: string[] = [];
      for await (const k of (await dir()).keys()) names.push(k);
      return names;
    },
    async blob(names) {
      const d = await dir();
      return new Blob(await Promise.all(names.map(async (n) => (await d.getFileHandle(n)).getFile())));
    },
  };
}

/** One downloaded file (all its chunks) as a Blob. */
export const readModelFile = (files: ModelFiles, version: number, file: string, size: number): Promise<Blob> =>
  files.blob(Array.from({ length: chunkCount(size) }, (_, i) => chunkName(version, file, i)));

/** Delete the chunks of model `id` that do not belong to `keep` (the other model's chunks stay). */
export async function pruneModel(files: ModelFiles, id: ModelId, keep: { version: number; files: ModelFileSizes }): Promise<void> {
  const wanted = new Set(Object.keys(keep.files).flatMap((f) => Array.from({ length: chunkCount(keep.files[f]) }, (_, i) => chunkName(keep.version, f, i))));
  const own = modelFileNames(id);
  for (const n of await files.list()) {
    const file = /^v\d+-(.+)\.\d{4}$/.exec(n)?.[1];
    if (file && own.includes(file) && !wanted.has(n)) await files.remove(n);
  }
}
