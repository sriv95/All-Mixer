import { describe, expect, it } from 'vitest';
import type { CaptionTrack, PlayerInfo } from '../../shared/bridge';
import { chooseCaptionTracks, trackFromPlayer } from './track-info';

const info = (p: Partial<PlayerInfo>): PlayerInfo => ({
  videoId: 'abc',
  title: '',
  author: '',
  lengthSeconds: 200,
  captionTracks: [],
  ...p,
});

describe('trackFromPlayer', () => {
  it('uses YT Music metadata as is for art tracks', () => {
    expect(trackFromPlayer('ytmusic', info({ title: 'Bohemian Rhapsody', author: 'Queen', musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' }))).toEqual({
      videoId: 'abc',
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
      duration: 200,
    });
  });

  it('splits YouTube "Artist - Title (Official Video)" titles', () => {
    const t = trackFromPlayer('youtube', info({ title: 'Queen – Bohemian Rhapsody (Official Video Remastered)', author: 'Queen Official' }));
    expect(t).toMatchObject({ title: 'Bohemian Rhapsody', artist: 'Queen' });
  });

  it('handles Topic channels and UGC on YT Music', () => {
    expect(trackFromPlayer('youtube', info({ title: 'Yellow', author: 'Coldplay - Topic' }))).toMatchObject({ title: 'Yellow', artist: 'Coldplay' });
    expect(trackFromPlayer('ytmusic', info({ title: 'Adele - Hello (Live)', author: 'some fan', musicVideoType: 'MUSIC_VIDEO_TYPE_UGC' }))).toMatchObject({ artist: 'Adele' });
  });

  it('falls back to the video duration', () => {
    expect(trackFromPlayer('youtube', info({ lengthSeconds: 0 }), 181.5).duration).toBe(181.5);
  });
});

describe('chooseCaptionTracks', () => {
  const t = (languageCode: string, kind?: string): CaptionTrack => ({ baseUrl: `u-${languageCode}-${kind}`, languageCode, kind });

  it('picks ASR plus the manual track in the same language', () => {
    expect(chooseCaptionTracks([t('de'), t('en-GB'), t('en', 'asr')])).toEqual({ asr: t('en', 'asr'), manual: t('en-GB') });
  });

  it('uses a single manual track when there is no ASR track', () => {
    expect(chooseCaptionTracks([t('ko')])).toEqual({ asr: undefined, manual: t('ko') });
    expect(chooseCaptionTracks([t('ko'), t('en')])).toEqual({ asr: undefined, manual: undefined });
    expect(chooseCaptionTracks([])).toEqual({ asr: undefined, manual: undefined });
  });

  it("uses the player's default caption language when there is no ASR track", () => {
    expect(chooseCaptionTracks([t('ar'), t('en'), t('fr')], 'en')).toEqual({ asr: undefined, manual: t('en') });
    expect(chooseCaptionTracks([t('ar'), t('en-US')], 'en')).toEqual({ asr: undefined, manual: t('en-US') });
  });
});
