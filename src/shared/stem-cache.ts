import { EXPORT_SAMPLE_RATE } from './export';
import { preloadSignature } from './preload';
import type { StemSet, StemStore } from './stem-store';
import { ML_PAGE_PATH, STEM_INIT } from '../worklet/protocol';

// Stem cache over a MessagePort: the content script asks, the extension-origin ml.html iframe owns the OPFS store (src/ml/ml-page.ts).
// Float32 buffers are transferred, not copied: after `put` the arrays of the set are detached (empty), so put them after their last use.

/** Cache key of one video's processed stems at the export sample rate. */
export const stemKey = (videoKey: string, durationS: number, audio: Parameters<typeof preloadSignature>[0]): string =>
  `v1|${videoKey}|${Math.round(durationS)}|${preloadSignature(audio)}|${EXPORT_SAMPLE_RATE}`;

type Request = { id: number; op: 'get'; key: string } | { id: number; op: 'put'; key: string; set: StemSet };
type Reply = { id: number; result: StemSet | boolean | null };

const buffersOf = (set: StemSet): ArrayBuffer[] => [...new Set(Object.values(set.stems).flatMap((chs) => chs.map((c) => c.buffer as ArrayBuffer)))];

/** Host side (the ml.html page): answers get/put on `port` from the store. Never throws; a failing store answers null / false. */
export function serveStemCache(port: MessagePort, open: () => Promise<StemStore>): void {
  let store: Promise<StemStore> | null = null;
  port.onmessage = async (ev: MessageEvent<Request>) => {
    const m = ev.data;
    if (typeof m?.id !== 'number' || typeof m.key !== 'string') return;
    let reply: Reply = { id: m.id, result: m.op === 'get' ? null : false };
    try {
      const s = await (store ??= open());
      reply = { id: m.id, result: m.op === 'get' ? await s.get(m.key) : m.op === 'put' ? await s.put(m.key, m.set) : reply.result };
    } catch (e) {
      console.warn('[stem-cache] host failed', e);
    }
    port.postMessage(reply, reply.result && typeof reply.result === 'object' ? buffersOf(reply.result) : []);
  };
  port.start();
}

export interface StemCache {
  /** The stems of `key`, null when missing or on any failure. */
  get(key: string): Promise<StemSet | null>;
  /** True when stored, false on any failure. Transfers the buffers of `set` (see above). */
  put(key: string, set: StemSet): Promise<boolean>;
  dispose(): void;
}

export const STEM_CACHE_TIMEOUT_MS = 30_000;

/** Default connection: a hidden bare ml.html iframe (no ML worker) that gets one end of a MessageChannel. */
function connectIframe(): { port: MessagePort; dispose(): void } {
  const url = chrome.runtime.getURL(ML_PAGE_PATH);
  const origin = /^[a-z-]+:\/\/[^/]+/.exec(url)![0];
  const { port1, port2 } = new MessageChannel();
  const frame = document.createElement('iframe');
  frame.src = url;
  frame.hidden = true;
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'display:none;position:fixed;width:0;height:0;border:0';
  // Requests posted before the page listens wait in the port.
  frame.addEventListener('load', () => frame.contentWindow?.postMessage({ type: STEM_INIT }, origin, [port2]));
  (document.body ?? document.documentElement).appendChild(frame);
  return { port: port1, dispose: () => (frame.remove(), port1.close()) };
}

/** Client side (the content script). Never throws or rejects: an error, a timeout or a missing iframe gives null / false, logged once. */
export function createStemCache(connect: () => { port: MessagePort; dispose(): void } = connectIframe, timeoutMs = STEM_CACHE_TIMEOUT_MS): StemCache {
  let conn: { port: MessagePort; dispose(): void } | null = null;
  const pending = new Map<number, (r: Reply['result']) => void>();
  let nextId = 0;
  let warned = false;
  const warn = (e: unknown) => {
    if (!warned) console.warn('[stem-cache] unavailable, continuing without it', e);
    warned = true;
  };

  const call = (req: { op: 'get'; key: string } | { op: 'put'; key: string; set: StemSet }, transfer: () => Transferable[], none: null | false): Promise<StemSet | boolean | null> =>
    new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => finish(none, new Error(`no answer in ${timeoutMs} ms`)), timeoutMs);
      const finish = (r: Reply['result'], err?: unknown) => {
        clearTimeout(timer);
        pending.delete(id);
        if (err) warn(err);
        resolve(r);
      };
      pending.set(id, (r) => finish(r ?? none));
      try {
        if (!conn) {
          conn = connect();
          conn.port.onmessage = (ev: MessageEvent<Reply>) => pending.get(ev.data?.id)?.(ev.data.result);
          conn.port.start();
        }
        conn.port.postMessage({ ...req, id }, transfer());
      } catch (e) {
        finish(none, e);
      }
    });

  return {
    get: (key) => call({ op: 'get', key }, () => [], null).then((r) => (r && typeof r === 'object' ? r : null)),
    put: (key, set) => call({ op: 'put', key, set }, () => buffersOf(set), false).then((r) => r === true),
    dispose: () => {
      conn?.dispose();
      conn = null;
    },
  };
}
