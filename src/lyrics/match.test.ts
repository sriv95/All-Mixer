import { describe, expect, it } from 'vitest';
import { cleanArtist, cleanTitle, normalize, pickBest, scoreCandidate, splitYouTubeTitle } from './match';
import type { LrclibRecord } from './lrclib-types';
import type { TrackInfo } from './types';

describe('cleanTitle', () => {
  it.each([
    ['Yellow (Official Video)', 'Yellow'],
    ['Bohemian Rhapsody [Official Music Video]', 'Bohemian Rhapsody'],
    ['Shape of You (Lyrics)', 'Shape of You'],
    ['Blinding Lights (Lyric Video)', 'Blinding Lights'],
    ['Hello (Audio)', 'Hello'],
    ['Fix You (Visualizer)', 'Fix You'],
    ['Numb (HD)', 'Numb'],
    ['Heroes (4K Remaster)', 'Heroes'],
    ['Wonderwall | Official Video', 'Wonderwall'],
    ['Uptown Funk (feat. Bruno Mars)', 'Uptown Funk'],
    ['Stay ft. Justin Bieber', 'Stay'],
    ['Song Name (OFFICIAL VIDEO) - ', 'Song Name'],
    ['Wish You Were Here - 2011 Remaster', 'Wish You Were Here'],
    ['Song (Acoustic)', 'Song (Acoustic)'],
    ['Yellow', 'Yellow'],
  ])('%s → %s', (input, out) => expect(cleanTitle(input)).toBe(out));
});

describe('cleanArtist', () => {
  it.each([
    ['Coldplay - Topic', 'Coldplay'],
    ['TaylorSwiftVEVO', 'TaylorSwift'],
    ['Adele Official', 'Adele'],
    ['Queen', 'Queen'],
  ])('%s → %s', (input, out) => expect(cleanArtist(input)).toBe(out));
});

describe('splitYouTubeTitle', () => {
  it.each([
    ['Coldplay - Yellow (Official Video)', 'Coldplay Official', { artist: 'Coldplay', title: 'Yellow' }],
    ['Queen – Bohemian Rhapsody (Official Video Remastered)', 'Queen Official', { artist: 'Queen', title: 'Bohemian Rhapsody' }],
    ['Daft Punk — Get Lucky [Lyrics]', 'x', { artist: 'Daft Punk', title: 'Get Lucky' }],
    ['Adele | Hello | Official Video', 'Adele', { artist: 'Adele', title: 'Hello' }],
    ['Mark Ronson - Uptown Funk ft. Bruno Mars', 'MarkRonsonVEVO', { artist: 'Mark Ronson', title: 'Uptown Funk' }],
    ['Yellow (Official Video)', 'Coldplay - Topic', { artist: 'Coldplay', title: 'Yellow' }],
  ])('%s', (title, channel, out) => expect(splitYouTubeTitle(title, channel)).toEqual(out));
});

describe('normalize', () => {
  it('strips accents and punctuation', () => expect(normalize('Beyoncé — Halo!')).toBe('beyonce halo'));
});

const track: TrackInfo = { videoId: 'v', title: 'Yellow', artist: 'Coldplay', duration: 269 };
const rec = (o: Partial<LrclibRecord>): LrclibRecord => ({
  id: 1,
  trackName: 'Yellow',
  artistName: 'Coldplay',
  duration: 269,
  syncedLyrics: '[00:01.00] a\n[00:02.00] b\n[00:03.00] c\n[00:04.00] d',
  plainLyrics: 'a\nb\nc\nd',
  ...o,
});

describe('scoring', () => {
  it('prefers synced lyrics', () => {
    const plain = rec({ id: 1, syncedLyrics: null });
    const synced = rec({ id: 2 });
    expect(pickBest(track, [plain, synced])?.id).toBe(2);
  });
  it('prefers closer duration', () => {
    expect(pickBest(track, [rec({ id: 1, duration: 290 }), rec({ id: 2, duration: 270 })])?.id).toBe(2);
  });
  it('allows a long music video with lower score', () => {
    const far = rec({ duration: 269 - 40 });
    expect(scoreCandidate(track, far)).toBeGreaterThan(40);
    expect(scoreCandidate(track, far)).toBeLessThan(scoreCandidate(track, rec({})));
  });
  it('rejects wildly different duration, titles, artists, instrumentals, empty', () => {
    expect(pickBest(track, [rec({ duration: 600 })])).toBeNull();
    expect(pickBest(track, [rec({ trackName: 'Green' })])).toBeNull();
    expect(pickBest(track, [rec({ artistName: 'Metallica' })])).toBeNull();
    expect(pickBest(track, [rec({ instrumental: true })])).toBeNull();
    expect(pickBest(track, [rec({ syncedLyrics: null, plainLyrics: null })])).toBeNull();
    expect(pickBest(track, [])).toBeNull();
  });
  it('matches through accents, noise and extra artists', () => {
    const t: TrackInfo = { ...track, title: 'Halo (Official Video)', artist: 'Beyoncé' };
    expect(pickBest(t, [rec({ trackName: 'Halo', artistName: 'Beyonce, Someone', duration: 261 })])).not.toBeNull();
  });
});

describe('unknown duration', () => {
  it('still matches on title/artist when duration is 0 or NaN', () => {
    for (const duration of [0, NaN]) {
      expect(pickBest({ ...track, duration }, [rec({})])).not.toBeNull();
    }
  });
});

describe('usableSynced / usablePlain', () => {
  it('rejects placeholders and accepts real lyrics', async () => {
    const { usableSynced, usablePlain } = await import('./match');
    expect(usableSynced('[00:00.00]probe')).toBeUndefined();
    expect(usableSynced('[00:01.00]\n[00:02.00]\n[00:03.00]\n[00:04.00]')).toBeUndefined();
    expect(usableSynced(' [00:01.00]a\n[00:02.00]b\n[00:03.00][00:09.00]c\n[00:04.00]d ')).toBe('[00:01.00]a\n[00:02.00]b\n[00:03.00][00:09.00]c\n[00:04.00]d');
    expect(usablePlain('probe')).toBeUndefined();
    expect(usablePlain('a\nb\n\nc\nd')).toBe('a\nb\n\nc\nd');
  });
});
