/** A record as returned by https://lrclib.net/api/get and /api/search. */
export interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string | null;
  /** Seconds. */
  duration: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export interface FoundLyrics {
  synced?: string;
  plain?: string;
  record: LrclibRecord;
}
