import type { TrackInfo } from '../lyrics/types';
import type { FoundLyrics } from '../lyrics/lrclib-types';

const PREFIX = 'lyrics:';
const MAX_ENTRIES = 300;
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

interface Entry {
  at: number;
  /** null = negative result. */
  found: FoundLyrics | null;
}

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;

/** LRCLIB results per videoId in chrome.storage.local; negative results expire after a day. */
export class LyricsCache {
  private readonly inflight = new Map<string, Promise<FoundLyrics | null>>();

  constructor(
    private readonly area: Area,
    private readonly now: () => number = Date.now,
  ) {}

  async lookup(videoId: string): Promise<{ hit: boolean; found: FoundLyrics | null }> {
    const key = PREFIX + videoId;
    const e = (await this.area.get(key))[key] as Entry | undefined;
    if (!e) return { hit: false, found: null };
    if (!e.found && this.now() - e.at > NEGATIVE_TTL_MS) return { hit: false, found: null };
    return { hit: true, found: e.found };
  }

  async store(videoId: string, found: FoundLyrics | null): Promise<void> {
    await this.area.set({ [PREFIX + videoId]: { at: this.now(), found } satisfies Entry });
    const all = (await this.area.get(null)) as Record<string, unknown>;
    const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
    if (keys.length <= MAX_ENTRIES) return;
    keys.sort((a, b) => (all[a] as Entry).at - (all[b] as Entry).at);
    await this.area.remove(keys.slice(0, keys.length - MAX_ENTRIES));
  }

  /** Cached lookup, falling back to `load`. Network errors are not cached. */
  getOrFetch(track: TrackInfo, load: (t: TrackInfo) => Promise<FoundLyrics | null>): Promise<FoundLyrics | null> {
    const id = track.videoId;
    let p = this.inflight.get(id);
    if (!p) {
      p = this.fetchAndStore(track, load).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }

  private async fetchAndStore(track: TrackInfo, load: (t: TrackInfo) => Promise<FoundLyrics | null>): Promise<FoundLyrics | null> {
    const cached = await this.lookup(track.videoId);
    if (cached.hit) return cached.found;
    const found = await load(track);
    await this.store(track.videoId, found);
    return found;
  }
}
