import { describe, expect, it, vi } from 'vitest';
import { Backoff, RateLimited } from './backoff';
import { findYtmLyrics, lyricsBrowseId, lyricsText } from './ytm';

const tab = (pageType: string, browseId: string) => ({
  tabRenderer: { endpoint: { browseEndpoint: { browseId, browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType } } } } },
});
const NEXT = {
  contents: { singleColumnMusicWatchNextResultsRenderer: { tabbedRenderer: { watchNextTabbedResultsRenderer: { tabs: [
    tab('MUSIC_PAGE_TYPE_QUEUE', 'FEmusic_queue'),
    tab('MUSIC_PAGE_TYPE_TRACK_LYRICS', 'MPLYt_abc'),
  ] } } } },
};
const TEXT = 'We are no strangers\nYou know the rules\nAnd so do I\nA full commitment';
const BROWSE = { contents: { sectionListRenderer: { contents: [{ musicDescriptionShelfRenderer: { description: { runs: [{ text: TEXT }] }, footer: { runs: [{ text: 'Source: Musixmatch' }] } } }] } } };
const NOT_AVAILABLE = { contents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ messageRenderer: { text: { runs: [{ text: 'Lyrics not available' }] } } }] } }] } } };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const asFetch = (f: unknown) => f as typeof fetch;

describe('YTM parsing', () => {
  it('finds the lyrics browse id and the plain text', () => {
    expect(lyricsBrowseId(NEXT)).toBe('MPLYt_abc');
    expect(lyricsBrowseId({})).toBeNull();
    const t = tab('MUSIC_PAGE_TYPE_TRACK_LYRICS', 'MPLYt_x');
    (t.tabRenderer as Record<string, unknown>).unselectable = true;
    expect(lyricsBrowseId({ contents: { singleColumnMusicWatchNextResultsRenderer: { tabbedRenderer: { watchNextTabbedResultsRenderer: { tabs: [t] } } } } })).toBeNull();
    expect(lyricsText(BROWSE)).toBe(TEXT);
  });
  it('treats "Lyrics not available" as a miss', () => {
    expect(lyricsText(NOT_AVAILABLE)).toBeUndefined();
  });
});

describe('findYtmLyrics', () => {
  it('posts next (WEB_REMIX, mix playlist, no cookies) then browse', async () => {
    const f = vi.fn().mockResolvedValueOnce(json(NEXT)).mockResolvedValueOnce(json(BROWSE));
    expect(await findYtmLyrics('vid', asFetch(f), new Backoff())).toBe(TEXT);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://music.youtube.com/youtubei/v1/next');
    expect(init.credentials).toBe('omit');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ videoId: 'vid', playlistId: 'RDAMVMvid', context: { client: { clientName: 'WEB_REMIX' } } });
    expect(body.context.client).not.toHaveProperty('gl');
    expect(JSON.parse((f.mock.calls[1] as [string, RequestInit])[1].body as string).browseId).toBe('MPLYt_abc');
  });

  it('returns null without a lyrics tab or with an unavailable shelf', async () => {
    const none = vi.fn().mockResolvedValue(json({}));
    expect(await findYtmLyrics('v', asFetch(none), new Backoff())).toBeNull();
    expect(none).toHaveBeenCalledTimes(1);
    const na = vi.fn().mockResolvedValueOnce(json(NEXT)).mockResolvedValueOnce(json(NOT_AVAILABLE));
    expect(await findYtmLyrics('v', asFetch(na), new Backoff())).toBeNull();
  });

  it.each([429])('HTTP %i throws RateLimited and blocks calls until the cooldown ends (Retry-After honoured)', async (status) => {
    let now = 1000;
    const backoff = new Backoff(() => now);
    const f = vi.fn().mockResolvedValueOnce(json({}, status, { 'Retry-After': '30' })).mockResolvedValue(json({}));
    await expect(findYtmLyrics('v', asFetch(f), backoff)).rejects.toBeInstanceOf(RateLimited);
    expect(f).toHaveBeenCalledTimes(1);
    now += 29_000;
    await expect(findYtmLyrics('v', asFetch(f), backoff)).rejects.toBeInstanceOf(RateLimited);
    expect(f).toHaveBeenCalledTimes(1);
    now += 2_000;
    expect(await findYtmLyrics('v', asFetch(f), backoff)).toBeNull();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('HTTP 403 fails that request only, with no cooldown', async () => {
    const backoff = new Backoff(() => 0);
    const f = vi.fn().mockResolvedValueOnce(json({}, 403)).mockResolvedValue(json({}));
    const err = await findYtmLyrics('v', asFetch(f), backoff).catch((e) => e);
    expect(err).not.toBeInstanceOf(RateLimited);
    expect(await findYtmLyrics('v', asFetch(f), backoff)).toBeNull();
  });

  it('cools down 5 minutes without Retry-After', async () => {
    let now = 0;
    const backoff = new Backoff(() => now);
    const f = vi.fn().mockResolvedValue(json({}, 429));
    await expect(findYtmLyrics('v', asFetch(f), backoff)).rejects.toBeInstanceOf(RateLimited);
    now = 299_000;
    expect(() => backoff.check()).toThrow(RateLimited);
    now = 301_000;
    expect(() => backoff.check()).not.toThrow();
  });
});
