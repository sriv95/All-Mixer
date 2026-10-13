import type { TrackInfo } from './types';
import type { LrclibRecord } from './lrclib-types';

const NOISE_WORDS =
  'official|music|video|lyrics?|lyric|audio|visuali[sz]er|hd|hq|4k|8k|remaster(?:ed)?|live|mv|m\\/v|explicit|clean|full|version|album|single|performance|sub(?:title)?s?|with lyrics|video oficial|clip officiel';
// A bracketed group counts as noise when it contains any noise word.
const NOISE_BRACKET = new RegExp(`[(\\[][^()\\[\\]]*\\b(?:${NOISE_WORDS})\\b[^()\\[\\]]*[)\\]]`, 'gi');
const FEAT_BRACKET = /[([]\s*(?:feat\.?|ft\.?|featuring|with)\s[^()\]]*[)\]]/gi;
const FEAT_TAIL = /\s+(?:feat\.?|ft\.?|featuring)\s.*$/i;
const PIPE_NOISE = new RegExp(`\\s*[|/]\\s*(?:[^|/]*\\b(?:${NOISE_WORDS})\\b[^|/]*)$`, 'i');
const DASH_NOISE = new RegExp(
  `\\s+[-–—]\\s+(?:(?:official|lyrics?|lyric video|audio|video|music video|visuali[sz]er|remaster(?:ed)?(?: \\d{4})?|\\d{4} remaster(?:ed)?)\\b.*)$`,
  'i',
);

export function cleanTitle(s: string): string {
  let t = s;
  for (let i = 0; i < 3; i++) {
    t = t.replace(NOISE_BRACKET, ' ').replace(FEAT_BRACKET, ' ');
  }
  t = t.replace(PIPE_NOISE, '').replace(DASH_NOISE, '').replace(FEAT_TAIL, '');
  return t.replace(/\s+/g, ' ').replace(/[\s\-–—|]+$/, '').replace(/^[\s\-–—|]+/, '').trim();
}

export function cleanArtist(s: string): string {
  return s
    .replace(/\s*[-–—]\s*topic$/i, '')
    .replace(/\s*vevo$/i, '')
    .replace(/\s+official(?:\s+(?:channel|artist))?$/i, '')
    .replace(/^official\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SEPARATORS = [' - ', ' – ', ' — ', ' | '];

export interface TitleReading {
  artist: string;
  title: string;
}

function hasNoiseBracket(s: string): boolean {
  return s.replace(NOISE_BRACKET, '') !== s;
}

/** Artist side of a split: channel-style cleanup plus noise brackets such as "(Lyrics)". */
function cleanArtistSide(s: string): string {
  return cleanArtist(s.replace(NOISE_BRACKET, ' ').replace(/\s+/g, ' ').trim());
}

/**
 * Split "A - B" into a primary reading and one alternate (the other order).
 * Fan uploads are often "Title (Lyrics) - Artist", so the order is swapped when
 * the left side carries a noise bracket and the right does not, or when the
 * channel name matches the right side only.
 */
export function splitYouTubeTitle(
  videoTitle: string,
  channel: string,
): TitleReading & { alternates: TitleReading[] } {
  for (const sep of SEPARATORS) {
    const i = videoTitle.indexOf(sep);
    if (i > 0) {
      const left = videoTitle.slice(0, i).trim();
      const right = videoTitle.slice(i + sep.length).trim();
      const normal: TitleReading = { artist: cleanArtistSide(left), title: cleanTitle(right) };
      const swapped: TitleReading = { artist: cleanArtistSide(right), title: cleanTitle(left) };
      if (!normal.artist || !normal.title) continue;
      const ch = normalize(cleanArtist(channel));
      const matches = (side: string) => {
        const n = normalize(cleanArtistSide(side));
        return ch.length >= 3 && !!n && (n === ch || n.includes(ch) || ch.includes(n));
      };
      const swap =
        !!swapped.artist &&
        !!swapped.title &&
        ((hasNoiseBracket(left) && !hasNoiseBracket(right)) || (matches(right) && !matches(left)));
      return swap ? { ...swapped, alternates: [normal] } : { ...normal, alternates: swapped.artist && swapped.title ? [swapped] : [] };
    }
  }
  return { artist: cleanArtist(channel), title: cleanTitle(videoTitle), alternates: [] };
}

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(normalize(s).split(' ').filter(Boolean));
}

/** Dice coefficient on word sets, 1 for equal after normalization. */
function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  let common = 0;
  for (const w of ta) if (tb.has(w)) common++;
  return (2 * common) / (ta.size + tb.size);
}

/** Like similarity, but also accepts one side containing the other (e.g. "A, B" vs "A"). */
function artistSimilarity(a: string, b: string): number {
  const s = similarity(a, b);
  const na = normalize(a);
  const nb = normalize(b);
  if (na && nb && (na.includes(nb) || nb.includes(na))) return Math.max(s, 0.8);
  return s;
}

const MIN_LYRIC_LINES = 4;

/**
 * LRCLIB is crowd-sourced; some records are placeholders or vandalised
 * (e.g. "[00:00.00]probe" as the exact match for a famous song). Accept lyrics
 * only when they have a few real lines. Returns the trimmed text or undefined.
 */
export function usableSynced(s: string | null | undefined): string | undefined {
  const t = s?.trim();
  if (!t) return undefined;
  const lines = t.split(/\r?\n/).filter((l) => /^(?:\[\d+:\d+(?:[.:]\d+)?\])+\s*\S/.test(l.trim()));
  return lines.length >= MIN_LYRIC_LINES ? t : undefined;
}

export function usablePlain(s: string | null | undefined): string | undefined {
  const t = s?.trim();
  if (!t) return undefined;
  return t.split(/\r?\n/).filter((l) => l.trim()).length >= MIN_LYRIC_LINES ? t : undefined;
}

const MIN_TITLE = 0.6;
const MIN_ARTIST = 0.3;
const MIN_SCORE = 40;

/** 0 = implausible, higher is better. Max about 110. */
export function scoreCandidate(track: TrackInfo, c: LrclibRecord): number {
  if (c.instrumental) return 0;
  const synced = usableSynced(c.syncedLyrics);
  if (!synced && !usablePlain(c.plainLyrics)) return 0;
  const title = similarity(cleanTitle(track.title), cleanTitle(c.trackName));
  if (title < MIN_TITLE) return 0;
  const artist = artistSimilarity(cleanArtist(track.artist), cleanArtist(c.artistName));
  if (artist < MIN_ARTIST) return 0;

  let score = title * 35 + artist * 25;
  const diff = Math.abs(track.duration - c.duration);
  if (!(track.duration > 0)) score += 5; // duration not known yet: rely on title/artist
  else if (diff <= 3) score += 30 - diff * 2;
  else if (diff <= 15) score += 18 - (diff - 3) * 0.5;
  else if (diff <= 60) score += 10 - (diff - 15) / 9; // music videos with intros/outros
  else return 0;
  if (synced) score += 20;
  if (track.album && c.albumName && similarity(track.album, c.albumName) > 0.8) score += 3;
  return score;
}

export function pickBest(track: TrackInfo, candidates: LrclibRecord[]): LrclibRecord | null {
  let best: LrclibRecord | null = null;
  let bestScore = MIN_SCORE;
  for (const c of candidates) {
    const s = scoreCandidate(track, c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}
