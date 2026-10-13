import type { CaptionTrack, PlayerInfo } from '../../shared/bridge';
import { cleanArtist, cleanTitle, splitYouTubeTitle } from '../../lyrics/match';
import type { TrackInfo } from '../../lyrics/types';
import type { Site } from '../youtube-dom';

/** Title / artist for the LRCLIB query. */
export function trackFromPlayer(site: Site, info: PlayerInfo, fallbackDuration = 0): TrackInfo {
  const duration = info.lengthSeconds > 0 ? info.lengthSeconds : fallbackDuration;
  const base = { videoId: info.videoId, duration };
  // YT Music art tracks / official videos and YouTube "Artist - Topic" uploads already carry clean metadata.
  const clean =
    (site === 'ytmusic' && info.musicVideoType !== 'MUSIC_VIDEO_TYPE_UGC') || /\s-\sTopic$/i.test(info.author);
  if (clean) return { ...base, title: cleanTitle(info.title) || info.title, artist: cleanArtist(info.author) };
  const { artist, title, alternates } = splitYouTubeTitle(info.title, info.author);
  return { ...base, title, artist, ...(alternates.length ? { alternates } : {}) };
}

export interface CaptionChoice {
  /** Auto-generated track: word timing + offset. */
  asr?: CaptionTrack;
  /** Human-made track in the spoken language: offset + fallback lyrics. */
  manual?: CaptionTrack;
}

/** Pick caption tracks. The ASR track's language tells us the language of the song; else the player's default. */
export function chooseCaptionTracks(tracks: readonly CaptionTrack[], defaultLang?: string): CaptionChoice {
  const asr = tracks.find((t) => t.kind === 'asr');
  const manuals = tracks.filter((t) => t.kind !== 'asr');
  const lang = (code: string) => code.split('-')[0];
  const want = asr?.languageCode ?? defaultLang;
  const manual = want
    ? (manuals.find((t) => t.languageCode === want) ?? manuals.find((t) => lang(t.languageCode) === lang(want)))
    : manuals.length === 1
      ? manuals[0]
      : undefined;
  return { asr, manual };
}

export interface CaptionOption {
  /** Index into `PlayerInfo.captionTracks`. */
  index: number;
  label: string;
}

/** A chosen caption track. */
export interface CaptionPick {
  index: number;
}

/** "English - en" -> "English"; "English - Lyrics" -> "English (Lyrics)"; drops parts repeated from the first part or equal to the language code. */
function cleanTrackName(name: string, languageCode?: string): string {
  const [first, ...rest] = name.split(' - ').map((p) => p.trim()).filter(Boolean);
  if (!first) return name;
  const code = languageCode?.toLowerCase();
  const extra = rest.filter((p) => p.toLowerCase() !== code && !first.toLowerCase().includes(p.toLowerCase()));
  return extra.length ? `${first} (${extra.join(', ')})` : first;
}

function appendInParens(label: string, code: string): string {
  return code ? `${label} (${code})` : label;
}

/** Menu entries for the caption language picker: every track, auto-generated ones labelled. */
export function captionOptions(tracks: readonly CaptionTrack[]): CaptionOption[] {
  const labels = tracks.map((t, index) => {
    const name = cleanTrackName(t.name || t.languageCode || `Track ${index + 1}`, t.languageCode);
    return t.kind === 'asr' && !/auto/i.test(name) ? `${name} (auto-generated)` : name;
  });
  const coded = tracks.map((t, index) => {
    const dup = labels.some((l, i) => i !== index && l === labels[index]);
    return dup ? appendInParens(labels[index], t.languageCode) : labels[index];
  });
  // Still identical (same name and code): number the 2nd and later ones.
  const seen = new Map<string, number>();
  return coded.map((base, index) => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { index, label: n > 1 ? `${base} #${n}` : base };
  });
}
