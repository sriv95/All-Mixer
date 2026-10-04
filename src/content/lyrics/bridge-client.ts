import { BRIDGE_TAG, type BridgeEventMsg, type BridgeRequest, type BridgeResponseMsg, type CaptionTrack, type PlayerInfo } from '../../shared/bridge';

let nextId = 1;
const pending = new Map<number, (data: unknown) => void>();
const captionListeners = new Set<(videoId: string) => void>();

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as BridgeResponseMsg | BridgeEventMsg | null;
  if (e.source !== window || !msg) return;
  if (msg[BRIDGE_TAG] === 'evt') {
    if (msg.kind === 'captions') for (const cb of captionListeners) cb(msg.videoId);
    return;
  }
  if (msg[BRIDGE_TAG] !== 'res') return;
  const resolve = pending.get(msg.id);
  if (resolve) {
    pending.delete(msg.id);
    resolve(msg.data);
  }
});

function ask(req: BridgeRequest, timeoutMs: number): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, timeoutMs);
    pending.set(id, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
    window.postMessage({ [BRIDGE_TAG]: 'req', id, req }, location.origin);
  });
}

/** Player response for `videoId` ('' = whatever is loaded), polling until YouTube has loaded it (SPA navigation). Null on timeout or abort. */
export async function getPlayerInfo(videoId: string, signal: AbortSignal, waitMs = 8000): Promise<PlayerInfo | null> {
  const until = Date.now() + waitMs;
  while (!signal.aborted && Date.now() < until) {
    const info = (await ask({ kind: 'player-info', videoId }, 1000)) as PlayerInfo | null;
    if (info) return info;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

export async function getTimedText(videoId: string, track: CaptionTrack): Promise<string | null> {
  const data = await ask({ kind: 'timedtext', videoId, track }, 10000);
  return typeof data === 'string' ? data : null;
}

/** Called when the player loads captions by itself (the user has CC on). */
export function onCaptionsAvailable(cb: (videoId: string) => void): () => void {
  captionListeners.add(cb);
  return () => captionListeners.delete(cb);
}
