// Hidden iframe page (chrome-extension://…/ml/ml.html) embedded by the content script. The page
// itself has no WebGPU worker restrictions the YouTube page has: a Worker started here gets a real
// WebGPU adapter. The page only wires things up: ML_INIT + port from the parent → worker, and the
// worker's ready/unavailable → parent. Blocks then flow worklet ↔ worker without touching this page.
import { ML_INIT, GPU_PREFERENCES, ML_MODELS, type GpuPreference, type FromMlWorker, type MlModel, type MlWorkerInit, type ToMlWorker } from '../worklet/protocol';

import { keyInstalled, type InstalledModel } from '../shared/model-store';
import { rememberSpeed, type SpeedCache } from './plan-cache';

const SPEEDS_KEY = 'mlSpeeds';

const ALLOWED = ['https://www.youtube.com', 'https://music.youtube.com'];
const parentOrigin = (): string | null => {
  const o = location.ancestorOrigins?.[0];
  if (o) return ALLOWED.includes(o) ? o : null;
  return null;
};

let worker: Worker | null = null;
let target: string | null = null;

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window.parent || !ALLOWED.includes(e.origin)) return;
  const origin = parentOrigin();
  if (origin !== null && origin !== e.origin) return;
  const msg = e.data as { type?: string; model?: unknown; delayMs?: unknown; drums?: unknown; gpu?: unknown } | null;
  if (msg?.type === ML_INIT) {
    const port = e.ports[0];
    if (!port || worker) return;
    const model: MlModel = ML_MODELS.includes(msg.model as MlModel) ? (msg.model as MlModel) : 'mdx';
    const delayMs = typeof msg.delayMs === 'number' && msg.delayMs > 0 ? msg.delayMs : null;
    const drums = msg.drums === true;
    const gpu: GpuPreference = GPU_PREFERENCES.includes(msg.gpu as GpuPreference) ? (msg.gpu as GpuPreference) : 'auto';
    target = e.origin;
    worker = new Worker(new URL('./ml-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<FromMlWorker>) => {
      const m = ev.data;
      // Remember the GPU speed of a RoFormer plan that passed (the worker has no chrome.storage).
      if (m.type === 'ready' && m.speed) {
        const { key, baseMs } = m.speed;
        void chrome.storage.local
          .get(SPEEDS_KEY)
          .then((o) => chrome.storage.local.set({ [SPEEDS_KEY]: rememberSpeed(o[SPEEDS_KEY] as SpeedCache | undefined, key, baseMs) }))
          .catch(() => {});
      }
      window.parent.postMessage(m, target!);
    };
    worker.onerror = (ev) => window.parent.postMessage({ type: 'unavailable', reason: `worker: ${ev.message}` } satisfies FromMlWorker, target!);
    const w = worker;
    // Debug stall hook (off by default): see README, Debug.
    void chrome.storage.local
      .get([SPEEDS_KEY, 'debug.mlStallMs', 'debug.mlStallAfterMs', 'debug.mlTiming', ...(model === 'mdx' ? [] : [keyInstalled(model)]), ...(drums ? [keyInstalled('drums')] : [])])
      .catch(() => ({}) as Record<string, unknown>)
      .then((o) => {
        const stallMs = Number(o['debug.mlStallMs']) > 0 ? Number(o['debug.mlStallMs']) : 0;
        const stallAfterMs = Number(o['debug.mlStallAfterMs']) >= 0 && o['debug.mlStallAfterMs'] != null ? Number(o['debug.mlStallAfterMs']) : 5000;
        // Timing log (off by default): localStorage['all-mixer-ml-timing'] = '1' on this page (the ml.html iframe).
        const timing = localStorage.getItem('all-mixer-ml-timing') === '1' || o['debug.mlTiming'] === true;
        w.postMessage(
          {
            type: 'init',
            speeds: o[SPEEDS_KEY] as SpeedCache | undefined,
            appVersion: chrome.runtime.getManifest().version,
            model,
            delayMs,
            port,
            modelUrl: chrome.runtime.getURL('ml/vocals.onnx'),
            mdxUrl: chrome.runtime.getURL('ml/mdx.onnx'),
            installed: model === 'mdx' ? undefined : (o[keyInstalled(model)] as InstalledModel | undefined),
            drums,
            gpu,
            drumsInstalled: drums ? (o[keyInstalled('drums')] as InstalledModel | undefined) : undefined,
            wasmBase: chrome.runtime.getURL('ml/'),
            stallMs,
            stallAfterMs,
            timing,
          } satisfies MlWorkerInit,
          [port],
        );
      });
  } else if ((msg as ToMlWorker | null)?.type === 'dispose') {
    worker?.terminate();
    worker = null;
  }
});
