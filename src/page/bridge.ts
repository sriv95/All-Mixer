/**
 * Main-world script (manifest `world: "MAIN"`, document_start). Answers
 * content-script requests for the player response and caption timed text.
 * Also remembers timed text the player itself downloads (when the user turns
 * captions on), because direct timedtext requests can come back empty when
 * YouTube requires a proof-of-origin token.
 */
import { BRIDGE_TAG, type BridgeEventMsg, type BridgeRequestMsg, type BridgeResponseMsg, type CaptionTrack, type PlayerInfo } from '../shared/bridge';

interface PlayerApi extends HTMLElement {
  getPlayerResponse?: () => PlayerResponse | null | undefined;
  getVideoData?: () => { video_id?: string; title?: string; author?: string } | undefined;
  getDuration?: () => number;
}

interface PlayerResponse {
  videoDetails?: { videoId?: string; title?: string; author?: string; lengthSeconds?: string; musicVideoType?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: { captionTracks?: RawTrack[]; audioTracks?: { defaultCaptionTrackIndex?: number }[] };
  };
}

interface RawTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  name?: { simpleText?: string; runs?: { text: string }[] };
}

const captured = new Map<string, string>(); // `${videoId}|${lang}|${asr}` → json3
const MAX_CAPTURED = 20;
/** Extra query params (pot, c, cver …) from the player's own timedtext request, per video. */
const playerParams = new Map<string, [string, string][]>();
/** Params that select the track; everything else on a player request is copied to ours. */
const TRACK_PARAMS = new Set(['v', 'lang', 'kind', 'name', 'tlang', 'fmt']);

function timedTextUrl(url: string): URL | null {
  try {
    const u = new URL(url, location.href);
    return u.pathname.endsWith('/api/timedtext') ? u : null;
  } catch {
    return null;
  }
}

function keyOf(videoId: string | null, lang: string | null, asr: boolean): string {
  return `${videoId}|${lang}|${asr}`;
}

function remember(key: string, body: string): void {
  if (!body) return;
  captured.delete(key);
  captured.set(key, body);
  if (captured.size > MAX_CAPTURED) captured.delete(captured.keys().next().value!);
}

/** The player fetched captions (user has CC on): keep the body and its token, and tell the content script. */
export function onPlayerTimedText(u: URL, body: string): void {
  const videoId = u.searchParams.get('v');
  if (!videoId) return;
  let notify = false;
  if (u.searchParams.has('pot')) {
    const known = playerParams.get(videoId);
    const next = [...u.searchParams].filter(([k]) => !TRACK_PARAMS.has(k));
    // A token we did not have yet lets the content script fetch the tracks itself, whatever format the player asked for.
    notify = !known || JSON.stringify(known) !== JSON.stringify(next);
    playerParams.set(videoId, next);
    if (playerParams.size > MAX_CAPTURED) playerParams.delete(playerParams.keys().next().value!);
  }
  if (body && u.searchParams.get('fmt') === 'json3' && !u.searchParams.get('tlang')) {
    remember(keyOf(videoId, u.searchParams.get('lang'), u.searchParams.get('kind') === 'asr'), body);
    notify = true;
  }
  if (!notify) return;
  const evt: BridgeEventMsg = { [BRIDGE_TAG]: 'evt', kind: 'captions', videoId };
  window.postMessage(evt, location.origin);
}

// Passive taps: never change requests or responses.
const origFetch = window.fetch;
window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
  const p = origFetch.call(this, input, init);
  const u = timedTextUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (u) {
    p.then((res) => res.clone().text()).then((t) => onPlayerTimedText(u, t), () => {});
  }
  return p;
} as typeof fetch;

const origOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
  const u = timedTextUrl(String(args[1]));
  if (u) {
    this.addEventListener('load', () => {
      const r: unknown = this.response;
      const body =
        typeof r === 'string' ? r : r instanceof ArrayBuffer ? new TextDecoder().decode(r) : r && typeof r === 'object' ? JSON.stringify(r) : '';
      onPlayerTimedText(u, body);
    });
  }
  return (origOpen as (...a: unknown[]) => void).apply(this, args);
} as typeof XMLHttpRequest.prototype.open;

function player(): PlayerApi | null {
  return document.getElementById('movie_player') as PlayerApi | null;
}

function trackName(t: RawTrack): string | undefined {
  return t.name?.simpleText ?? t.name?.runs?.map((r) => r.text).join('');
}

function playerInfo(wantId: string): PlayerInfo | null {
  const p = player();
  const resp = p?.getPlayerResponse?.();
  const d = resp?.videoDetails;
  // Empty wantId = whatever is loaded. Otherwise reject stale responses during SPA navigation.
  if (!d?.videoId || (wantId && d.videoId !== wantId)) return null;
  const list = resp?.captions?.playerCaptionsTracklistRenderer;
  const raw = list?.captionTracks ?? [];
  const def = list?.audioTracks?.[0]?.defaultCaptionTrackIndex;
  const tracks: CaptionTrack[] = raw
    .filter((t): t is RawTrack & { baseUrl: string } => typeof t.baseUrl === 'string')
    .map((t) => ({ baseUrl: t.baseUrl, languageCode: t.languageCode ?? '', kind: t.kind, name: trackName(t) }));
  const duration = Number(d.lengthSeconds) || p?.getDuration?.() || 0;
  return {
    videoId: d.videoId,
    title: d.title ?? '',
    author: d.author ?? '',
    lengthSeconds: duration,
    musicVideoType: d.musicVideoType,
    captionTracks: tracks,
    defaultCaptionLang: def !== undefined ? raw[def]?.languageCode : undefined,
  };
}

async function timedText(videoId: string, track: CaptionTrack): Promise<string | null> {
  const key = keyOf(videoId, track.languageCode, track.kind === 'asr');
  const hit = captured.get(key);
  if (hit) return hit;
  // Without the player's token YouTube usually answers with an empty body.
  try {
    const u = new URL(track.baseUrl, location.href);
    for (const [k, v] of playerParams.get(videoId) ?? []) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
    u.searchParams.set('fmt', 'json3');
    const res = await origFetch(u.href, { credentials: 'include' });
    const body = res.ok ? await res.text() : '';
    if (body) remember(key, body);
    return body || null;
  } catch {
    return null;
  }
}

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as BridgeRequestMsg | null;
  if (e.source !== window || !msg || msg[BRIDGE_TAG] !== 'req') return;
  const reply = (data: unknown) => {
    const out: BridgeResponseMsg = { [BRIDGE_TAG]: 'res', id: msg.id, data };
    window.postMessage(out, location.origin);
  };
  const req = msg.req;
  if (req.kind === 'player-info') reply(playerInfo(req.videoId));
  else if (req.kind === 'timedtext') void timedText(req.videoId, req.track).then(reply);
});
