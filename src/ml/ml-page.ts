// Hidden iframe page (chrome-extension://…/ml/ml.html) embedded by the content script. The page
// itself has no WebGPU worker restrictions the YouTube page has: a Worker started here gets a real
// WebGPU adapter. The page only wires things up: ML_INIT + port from the parent → worker, and the
// worker's ready/unavailable → parent. Blocks then flow worklet ↔ worker without touching this page.
import { ML_INIT, type FromMlWorker, type ToMlWorker } from '../worklet/protocol';

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
  const msg = e.data as { type?: string } | null;
  if (msg?.type === ML_INIT) {
    const port = e.ports[0];
    if (!port || worker) return;
    target = e.origin;
    worker = new Worker(new URL('./ml-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<FromMlWorker>) => window.parent.postMessage(ev.data, target!);
    worker.onerror = (ev) => window.parent.postMessage({ type: 'unavailable', reason: `worker: ${ev.message}` } satisfies FromMlWorker, target!);
    const w = worker;
    // Debug stall hook (off by default): see README, Debug.
    void chrome.storage.local
      .get(['debug.mlStallMs', 'debug.mlStallAfterMs'])
      .catch(() => ({}) as Record<string, unknown>)
      .then((o) => {
        const stallMs = Number(o['debug.mlStallMs']) > 0 ? Number(o['debug.mlStallMs']) : 0;
        const stallAfterMs = Number(o['debug.mlStallAfterMs']) >= 0 && o['debug.mlStallAfterMs'] != null ? Number(o['debug.mlStallAfterMs']) : 5000;
        // Timing log (off by default): localStorage['all-mixer-ml-timing'] = '1' on this page (the ml.html iframe).
        const timing = localStorage.getItem('all-mixer-ml-timing') === '1' || o['debug.mlTiming'] === true;
        w.postMessage(
          { type: 'init', port, modelUrl: chrome.runtime.getURL('ml/vocals.onnx'), mdxUrl: chrome.runtime.getURL('ml/mdx.onnx'), wasmBase: chrome.runtime.getURL('ml/'), stallMs, stallAfterMs, timing },
          [port],
        );
      });
  } else if ((msg as ToMlWorker | null)?.type === 'dispose') {
    worker?.terminate();
    worker = null;
  }
});
