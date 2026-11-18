import type { TrackInfo } from '../lyrics/types';
import type { FoundLyrics } from '../lyrics/lrclib-types';

const PREFIX = 'lyrics:';
const MAX_ENTRIES = 300;
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

interface Entry<T> {
  at: number;
  /** null = negative result. */
  found: T | null;
  /** The user chose these lyrics for the video: never evicted, never expires. */
  pinned?: boolean;
}

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;

/** Lyrics per videoId in chrome.storage.local (LRCLIB results; YTM plain text under its own prefix); negative results expire after a day. */
export class LyricsCache<T = FoundLyrics> {
  private readonly inflight = new Map<string, Promise<T | null>>();

  constructor(
    private readonly area: Area,
    private readonly now: () => number = Date.now,
    private readonly prefix = PREFIX,
  ) {}

  async lookup(videoId: string): Promise<{ hit: boolean; found: T | null }> {
    const key = this.prefix + videoId;
    const e = (await this.area.get(key))[key] as Entry<T> | undefined;
    if (!e) return { hit: false, found: null };
    if (!e.found && this.now() - e.at > NEGATIVE_TTL_MS) return { hit: false, found: null };
    return { hit: true, found: e.found };
  }

  /** Keep `found` for this video whatever the automatic lookup says. */
  async pin(videoId: string, found: T): Promise<void> {
    await this.area.set({ [this.prefix + videoId]: { at: this.now(), found, pinned: true } satisfies Entry<T> });
  }

  /** Forget this video's entry (a pin, or a cached result), so the next lookup is automatic again. */
  async unpin(videoId: string): Promise<void> {
    await this.area.remove([this.prefix + videoId]);
  }

  async store(videoId: string, found: T | null): Promise<void> {
    await this.area.set({ [this.prefix + videoId]: { at: this.now(), found } satisfies Entry<T> });
    const all = (await this.area.get(null)) as Record<string, unknown>;
    const keys = Object.keys(all).filter((k) => k.startsWith(this.prefix) && !(all[k] as Entry<T>).pinned);
    if (keys.length <= MAX_ENTRIES) return;
    keys.sort((a, b) => (all[a] as Entry<T>).at - (all[b] as Entry<T>).at);
    await this.area.remove(keys.slice(0, keys.length - MAX_ENTRIES));
  }

  /** Cached lookup, falling back to `load`. Network errors are not cached. */
  getOrFetch(track: TrackInfo, load: (t: TrackInfo) => Promise<T | null>): Promise<T | null> {
    const id = track.videoId;
    let p = this.inflight.get(id);
    if (!p) {
      p = this.fetchAndStore(track, load).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }

  private async fetchAndStore(track: TrackInfo, load: (t: TrackInfo) => Promise<T | null>): Promise<T | null> {
    const cached = await this.lookup(track.videoId);
    if (cached.hit) return cached.found;
    const found = await load(track);
    await this.store(track.videoId, found);
    return found;
  }
}
