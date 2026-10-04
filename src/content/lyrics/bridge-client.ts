import { BRIDGE_TAG, type BridgeRequest, type BridgeResponseMsg, type CaptionTrack, type PlayerInfo } from '../../shared/bridge';

let nextId = 1;
const pending = new Map<number, (data: unknown) => void>();

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as BridgeResponseMsg | null;
  if (e.source !== window || !msg || msg[BRIDGE_TAG] !== 'res') return;
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

/** Player response for `videoId`, polling until YouTube has loaded it (SPA navigation). Null on timeout or abort. */
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
