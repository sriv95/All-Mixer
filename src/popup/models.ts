import { useEffect, useReducer, useState } from 'react';
import { MODEL_IDS, MODEL_LABEL, VOCAL_MODEL_IDS, keyInstalled, keyProgress, keyRemote, mb, modelState, type InstalledModel, type ModelId, type ModelState, type Progress, type RemoteRecord } from '../shared/model-store';

// The RoFormer models are separate downloads (background/model-manager.ts); their state lives in chrome.storage.local.
interface ModelRecords {
  installed?: InstalledModel;
  remote?: RemoteRecord;
  progress?: Progress;
}
type AllRecords = Record<ModelId, ModelRecords>;

/** The Model menu entries; the drum and guitar split models have their own rows in the Split instrumental section. */
export const isModelId = (m: string): m is ModelId => (VOCAL_MODEL_IDS as readonly string[]).includes(m);

export interface ModelLine {
  id: ModelId;
  text: string;
  button?: string;
  /** 0 to 100 while a download runs. */
  progress?: number;
}

function modelLine(id: ModelId, s: ModelState): Omit<ModelLine, 'id'> {
  const label = MODEL_LABEL[id];
  switch (s.kind) {
    case 'missing':
      return { text: `${label} is a one-time download${s.size ? ` (${mb(s.size)})` : ''}.`, button: 'Download' };
    case 'downloading':
      return { text: `Downloading… ${Math.floor((100 * s.done) / s.total)}% (${mb(s.done)} of ${mb(s.total)})`, progress: (100 * s.done) / s.total };
    case 'error':
      return { text: `Download failed: ${s.message}`, button: 'Try again' };
    case 'update':
      return { text: `Update available: ${label} model v${s.version} (${mb(s.size)}).`, button: 'Update' };
    case 'incompatible':
      return { text: `The ${label} model needs a newer version of All Mixer!.` };
    case 'ready':
      return { text: `${label} model v${s.version} installed.` };
  }
}

/** The state of the downloadable models, kept live from chrome.storage.local. */
/** `split`: which split stages are on. */
export function useModels(selected: string, split: { drums: boolean; guitar: boolean }, enabled: boolean): { model?: ModelLine; drums?: ModelLine; guitar?: ModelLine } {
  const [records, setRecords] = useState<AllRecords>({ roformer: {}, deux: {}, drums: {}, guitar: {} });
  const [, tick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void chrome.storage.local.get(MODEL_IDS.flatMap((id) => [keyInstalled(id), keyRemote(id), keyProgress(id)])).then((o) => {
      if (!live) return;
      setRecords(Object.fromEntries(MODEL_IDS.map((id) => [id, { installed: o[keyInstalled(id)] as InstalledModel | undefined, remote: o[keyRemote(id)] as RemoteRecord | undefined, progress: o[keyProgress(id)] as Progress | undefined }])) as AllRecords);
    });
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      setRecords((prev) => {
        const next = { ...prev };
        for (const id of MODEL_IDS) {
          const r = { ...prev[id] };
          if (keyInstalled(id) in changes) r.installed = changes[keyInstalled(id)].newValue as InstalledModel | undefined;
          if (keyRemote(id) in changes) r.remote = changes[keyRemote(id)].newValue as RemoteRecord | undefined;
          if (keyProgress(id) in changes) r.progress = changes[keyProgress(id)].newValue as Progress | undefined;
          next[id] = r;
        }
        return next;
      });
    };
    chrome.storage.onChanged.addListener(onChanged);
    void chrome.runtime.sendMessage({ type: 'model-check' }); // a newer model shows up through the storage change
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener?.(onChanged);
    };
  }, [enabled]);

  const now = Date.now();
  const states = Object.fromEntries(MODEL_IDS.map((id) => [id, modelState(records[id].installed, records[id].remote, records[id].progress, now)])) as Record<ModelId, ModelState>;
  const downloading = MODEL_IDS.some((m) => states[m].kind === 'downloading');
  // A download whose worker was stopped goes stale after STALL_MS: look again then.
  useEffect(() => {
    if (!downloading) return;
    const t = setTimeout(tick, 5000);
    return () => clearTimeout(t);
  });

  const out: { model?: ModelLine; drums?: ModelLine; guitar?: ModelLine } = {};
  // Shown for the selected downloadable model, and for any model with an update on offer or a download running.
  const id = isModelId(selected) ? selected : VOCAL_MODEL_IDS.find((m) => states[m].kind === 'update' || states[m].kind === 'downloading');
  if (id) out.model = { id, ...modelLine(id, states[id]) };
  // A split model: shown while the split is on with it, or when an update is on offer or a download is running.
  for (const sid of ['drums', 'guitar'] as const) {
    const s = states[sid];
    if (split[sid] || s.kind === 'update' || s.kind === 'downloading') out[sid] = { id: sid, ...modelLine(sid, s) };
  }
  return out;
}

export const installModel = (id: ModelId): void => void chrome.runtime.sendMessage({ type: 'model-install', id });
