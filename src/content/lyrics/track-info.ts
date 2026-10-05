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
  /** Auto-translate target language (the track at `index` is machine-translated into it). */
  tlang?: string;
  label: string;
  group: 'track' | 'translate';
}

/** A chosen caption track, optionally auto-translated. */
export interface CaptionPick {
  index: number;
  tlang?: string;
}

/**
 * Menu entries for the caption language picker: every track (auto-generated ones labelled), then auto-translations
 * of `sourceTrack` when YouTube offers them for it.
 */
export function captionOptions(
  tracks: readonly CaptionTrack[],
  translationLanguages: readonly { languageCode: string; name: string }[] = [],
  sourceTrack?: CaptionTrack,
): CaptionOption[] {
  const options: CaptionOption[] = tracks.map((t, index) => {
    const name = t.name || t.languageCode || `Track ${index + 1}`;
    return { index, label: t.kind === 'asr' && !/auto/i.test(name) ? `${name} (auto-generated)` : name, group: 'track' };
  });
  const index = sourceTrack ? tracks.indexOf(sourceTrack) : -1;
  if (index < 0 || !sourceTrack?.isTranslatable) return options;
  for (const l of translationLanguages) {
    if (l.languageCode === sourceTrack.languageCode) continue;
    options.push({ index, tlang: l.languageCode, label: `${l.name} (auto-translated)`, group: 'translate' });
  }
  return options;
}
