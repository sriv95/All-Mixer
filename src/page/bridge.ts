/**
 * Main-world script (manifest `world: "MAIN"`, document_start). Answers
 * content-script requests for the player response and caption timed text.
 * Also remembers timed text the player itself downloads (when the user turns
 * captions on), because direct timedtext requests can come back empty when
 * YouTube requires a proof-of-origin token.
 */
import { BRIDGE_TAG, type BridgeRequestMsg, type BridgeResponseMsg, type CaptionTrack, type PlayerInfo } from '../shared/bridge';

interface PlayerApi extends HTMLElement {
  getPlayerResponse?: () => PlayerResponse | null | undefined;
  getVideoData?: () => { video_id?: string; title?: string; author?: string } | undefined;
  getDuration?: () => number;
}

interface PlayerResponse {
  videoDetails?: { videoId?: string; title?: string; author?: string; lengthSeconds?: string; musicVideoType?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: RawTrack[] } };
}

interface RawTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  name?: { simpleText?: string; runs?: { text: string }[] };
}

const captured = new Map<string, string>(); // `${videoId}|${lang}|${asr}` → json3
const MAX_CAPTURED = 20;

function captureKey(url: string): string | null {
  try {
    const u = new URL(url, location.href);
    if (!u.pathname.endsWith('/api/timedtext') || u.searchParams.get('fmt') !== 'json3') return null;
    if (u.searchParams.get('tlang')) return null; // machine translation
    return `${u.searchParams.get('v')}|${u.searchParams.get('lang')}|${u.searchParams.get('kind') === 'asr'}`;
  } catch {
    return null;
  }
}

function remember(key: string, body: string): void {
  if (!body) return;
  captured.delete(key);
  captured.set(key, body);
  if (captured.size > MAX_CAPTURED) captured.delete(captured.keys().next().value!);
}

// Passive taps: never change requests or responses.
const origFetch = window.fetch;
window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
  const p = origFetch.call(this, input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const key = captureKey(url);
  if (key) {
    p.then((res) => res.clone().text()).then((t) => remember(key, t), () => {});
  }
  return p;
} as typeof fetch;

const origOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
  const key = captureKey(String(args[1]));
  if (key) {
    this.addEventListener('load', () => {
      if (this.responseType === '' || this.responseType === 'text') remember(key, this.responseText);
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
  if (!d?.videoId || d.videoId !== wantId) return null; // stale response during SPA navigation
  const tracks: CaptionTrack[] = (resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [])
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
  };
}

async function timedText(videoId: string, track: CaptionTrack): Promise<string | null> {
  const key = `${videoId}|${track.languageCode}|${track.kind === 'asr'}`;
  const hit = captured.get(key);
  if (hit) return hit;
  try {
    const u = new URL(track.baseUrl, location.href);
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
