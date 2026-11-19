import { Backoff } from './backoff';
import { stripMarkup } from './markup';
import { usablePlain } from './match';

const BASE = 'https://music.youtube.com/youtubei/v1';
const TIMEOUT_MS = 8000;
const CLIENT_VERSION = '1.20251103.01.00';

export const ytmBackoff = new Backoff();

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- walked defensively with ?. below

/** Lyrics browseId from a /next response (the tab whose page type is TRACK_LYRICS), if any. */
export function lyricsBrowseId(next: Json): string | null {
  const tabs: Json[] = next?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs ?? [];
  for (const t of tabs) {
    if (t?.tabRenderer?.unselectable) continue;
    const e = t?.tabRenderer?.endpoint?.browseEndpoint;
    if (e?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_TRACK_LYRICS') return e.browseId ?? null;
  }
  return null;
}

/** Plain text from a /browse lyrics response; a video without lyrics has no description shelf. */
export function lyricsText(browse: Json): string | undefined {
  const shelf = browse?.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer;
  const text: unknown = shelf?.description?.runs?.[0]?.text;
  return typeof text === 'string' ? usablePlain(stripMarkup(text)) : undefined;
}

async function post(path: string, body: object, fetchFn: typeof fetch, backoff: Backoff): Promise<Json> {
  backoff.check();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // No cookies: the user's login is never sent. No gl (an empty gl gives HTTP 400).
    const res = await fetchFn(`${BASE}/${path}`, {
      method: 'POST',
      credentials: 'omit',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: CLIENT_VERSION, hl: 'en' } }, ...body }),
    });
    if (res.status === 429) backoff.trip(res.headers.get('Retry-After'));
    if (!res.ok) throw new Error(`YTM ${path} failed: HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Plain lyrics of a video from YouTube Music (two innertube calls, the first ~1.8 MB). Null when it has none.
 * Throws RateLimited on 429 or during the cooldown.
 * shortcut: YTM timed lyrics not returned by innertube as of 2026-11; add ANDROID_MUSIC timedLyricsData parse if cueRange appears
 */
export async function findYtmLyrics(videoId: string, fetchFn: typeof fetch = fetch, backoff = ytmBackoff): Promise<string | null> {
  // playlistId is required, else the lyrics tab is not offered.
  const next = await post('next', { videoId, playlistId: `RDAMVM${videoId}` }, fetchFn, backoff);
  const browseId = lyricsBrowseId(next);
  if (!browseId) return null;
  return lyricsText(await post('browse', { browseId }, fetchFn, backoff)) ?? null;
}
