import type { ModelFiles } from '../shared/model-files';
import { MODEL_IDS, keyInstalled, keyProgress, keyRemote, modelFileNames, type ModelId } from '../shared/model-store';

type Area = { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(key: string): Promise<void> };

/** Model id that High quality used before Kim Vocal 2 ('kim2') took the slot. */
const OLD_HQ = 'roformer' as ModelId;
const SPEEDS_KEY = 'mlSpeeds'; // src/ml/ml-page.ts

/**
 * Run at install / update / browser start; safe to repeat.
 * 1. Delete the OPFS chunks of every file that no model in MODEL_IDS owns (a model that was dropped).
 * 2. Forget the dropped High quality model's records and remembered speeds.
 * 3. If it was installed, download Kim Vocal 2 in its place; the old record stays until that worked, so a failed
 *    download (offline) is tried again at the next start.
 * Stored selections of the old id are remapped in normalizeSettings (src/shared/settings.ts).
 */
export async function migrateModels(area: Area, files: ModelFiles, install: (id: ModelId) => Promise<void>): Promise<void> {
  const known = new Set(MODEL_IDS.flatMap(modelFileNames));
  for (const n of await files.list()) {
    const file = /^v\d+-(.+)\.\d{4}$/.exec(n)?.[1];
    if (file && !known.has(file)) await files.remove(n);
  }
  const speeds = (await area.get(SPEEDS_KEY))[SPEEDS_KEY] as Record<string, unknown> | undefined;
  if (speeds) {
    const keep = Object.entries(speeds).filter(([k]) => !k.startsWith(`${OLD_HQ}|`));
    if (keep.length < Object.keys(speeds).length) await area.set({ [SPEEDS_KEY]: Object.fromEntries(keep) });
  }
  await area.remove(keyRemote(OLD_HQ));
  await area.remove(keyProgress(OLD_HQ));
  if (!(keyInstalled(OLD_HQ) in (await area.get(keyInstalled(OLD_HQ))))) return;
  await install('kim2');
  if (keyInstalled('kim2') in (await area.get(keyInstalled('kim2')))) await area.remove(keyInstalled(OLD_HQ));
}
