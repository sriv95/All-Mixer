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
  const { artist, title } = splitYouTubeTitle(info.title, info.author);
  return { ...base, title, artist };
}

export interface CaptionChoice {
  /** Auto-generated track: word timing + offset. */
  asr?: CaptionTrack;
  /** Human-made track in the spoken language: offset + fallback lyrics. */
  manual?: CaptionTrack;
}

/** Pick caption tracks. The ASR track's language tells us the language of the song. */
export function chooseCaptionTracks(tracks: readonly CaptionTrack[]): CaptionChoice {
  const asr = tracks.find((t) => t.kind === 'asr');
  const manuals = tracks.filter((t) => t.kind !== 'asr');
  const lang = (t: CaptionTrack) => t.languageCode.split('-')[0];
  const manual = asr ? manuals.find((t) => lang(t) === lang(asr)) : manuals.length === 1 ? manuals[0] : undefined;
  return { asr, manual };
}
