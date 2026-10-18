import type { FoundLyrics } from './lrclib-types';
import { toFound } from './lrclib';
import { usableSynced } from './match';
import type { TrackInfo } from './types';

/** Lyrics the user typed or loaded: synced when enough lines carry `[mm:ss.xx]` timestamps, else plain text. Null when too short. */
export function customFound(text: string, track?: Pick<TrackInfo, 'title' | 'artist' | 'duration'>): FoundLyrics | null {
  const body = text.trim();
  const record = { id: 0, trackName: track?.title ?? '', artistName: track?.artist ?? '', duration: track?.duration ?? 0 };
  return toFound(usableSynced(body) ? { ...record, syncedLyrics: body } : { ...record, plainLyrics: body });
}
