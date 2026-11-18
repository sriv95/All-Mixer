import type { FoundLyrics, LrclibRecord } from './lrclib-types';
import { toFound } from './lrclib';
import { cleanArtist, cleanTitle, pickBest } from './match';
import type { TrackInfo } from './types';
import { Backoff } from './backoff';

// https://lrcmux.dev/llms.txt: free, no key, 60 requests/min. Its /compat/lrclib route returns LRCLIB-shaped records.
const BASE = 'https://api.lrcmux.dev/compat/lrclib/api';
const TIMEOUT_MS = 8000;
const COOLDOWN_MS = 60 * 1000;

export const lrcmuxBackoff = new Backoff(Date.now, COOLDOWN_MS);

/**
 * Lyrics of a track from lrcmux, checked against the requested title/artist/duration with the LRCLIB scoring.
 * Null on a miss (404) or a wrong song. Throws RateLimited on 429/403 or during the cooldown.
 */
export async function findLrcmuxLyrics(track: TrackInfo, fetchFn: typeof fetch = fetch, backoff = lrcmuxBackoff): Promise<FoundLyrics | null> {
  backoff.check();
  const clean: TrackInfo = { ...track, title: cleanTitle(track.title) || track.title, artist: cleanArtist(track.artist) };
  const params: Record<string, string> = { track_name: clean.title, artist_name: clean.artist, duration: String(Math.round(track.duration)) };
  if (track.album) params.album_name = track.album;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // Plain GET without custom headers (no CORS preflight, and browsers do not allow a User-Agent).
    const res = await fetchFn(`${BASE}/get?${new URLSearchParams(params)}`, { signal: ctrl.signal, credentials: 'omit' });
    if (res.status === 429 || res.status === 403) backoff.trip(res.headers.get('Retry-After'));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`lrcmux get failed: HTTP ${res.status}`);
    const best = pickBest(clean, [(await res.json()) as LrclibRecord]);
    return best ? toFound(best) : null;
  } finally {
    clearTimeout(timer);
  }
}
