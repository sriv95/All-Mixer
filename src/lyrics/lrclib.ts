import type { TrackInfo } from './types';
import type { FoundLyrics, LrclibRecord } from './lrclib-types';
import { cleanArtist, cleanTitle, pickBest } from './match';

export type { FoundLyrics, LrclibRecord } from './lrclib-types';

const BASE = 'https://lrclib.net/api';
const TIMEOUT_MS = 8000;

/** Plain GET (no custom headers, so no CORS preflight). 404 → null; other errors throw. */
async function getJson<T>(path: string, params: Record<string, string>, fetchFn: typeof fetch): Promise<T | null> {
  const url = `${BASE}/${path}?${new URLSearchParams(params)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`LRCLIB ${path} failed: HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function getRecord(track: TrackInfo, fetchFn: typeof fetch = fetch): Promise<LrclibRecord | null> {
  const params: Record<string, string> = {
    track_name: track.title,
    artist_name: track.artist,
    duration: String(Math.round(track.duration)),
  };
  if (track.album) params.album_name = track.album;
  return getJson<LrclibRecord>('get', params, fetchFn);
}

export async function searchRecords(params: Record<string, string>, fetchFn: typeof fetch = fetch): Promise<LrclibRecord[]> {
  return (await getJson<LrclibRecord[]>('search', params, fetchFn)) ?? [];
}

function toFound(record: LrclibRecord): FoundLyrics | null {
  const synced = record.syncedLyrics?.trim() || undefined;
  const plain = record.plainLyrics?.trim() || undefined;
  if (record.instrumental || (!synced && !plain)) return null;
  return { synced, plain, record };
}

/** /get with exact duration, then /search (+ `q` fallback) ranked by pickBest. Null when nothing plausible. */
export async function findLyrics(track: TrackInfo, fetchFn: typeof fetch = fetch): Promise<FoundLyrics | null> {
  const clean: TrackInfo = { ...track, title: cleanTitle(track.title) || track.title, artist: cleanArtist(track.artist) };

  const exact = track.duration > 0 ? await getRecord(clean, fetchFn).catch(() => null) : null;
  if (exact?.syncedLyrics) return toFound(exact);

  const searches: Record<string, string>[] = [
    { track_name: clean.title, artist_name: clean.artist },
    { q: `${clean.artist} ${clean.title}`.trim() },
  ];
  let fallback = exact ? toFound(exact) : null;
  for (const params of searches) {
    const results = await searchRecords(params, fetchFn);
    const best = pickBest(clean, results);
    if (best) {
      const found = toFound(best);
      if (found?.synced) return found;
      fallback ??= found;
    }
  }
  return fallback;
}
