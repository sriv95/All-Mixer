import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_TAG } from '../shared/bridge';
import { onPlayerTimedText, playerInfo, timedText } from './bridge';

// bridge.ts keeps window.fetch as it was at import time, so install the mock first.
const fetchMock = vi.hoisted(() => {
  const m = vi.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = m;
  return m;
});

const base = 'https://www.youtube.com/api/timedtext?v=vid1&caps=asr&key=yt8&lang=en';
const events = () => {
  const spy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  return { spy, count: () => spy.mock.calls.filter((c) => (c[0] as Record<string, unknown>)[BRIDGE_TAG] === 'evt').length };
};

describe('onPlayerTimedText', () => {
  it('posts the captions event for the json3 request the player makes when CC is turned on', () => {
    const { spy, count } = events();
    onPlayerTimedText(new URL(`${base}&potc=1&pot=T1&fmt=json3&c=WEB`), '{"events":[]}');
    expect(count()).toBe(1);
    expect(spy.mock.calls[0]![0]).toEqual({ [BRIDGE_TAG]: 'evt', kind: 'captions', videoId: 'vid1' });
    spy.mockRestore();
  });

  it('also posts when the player asks for another format but brings a new token (our own json3 fetch can use it)', () => {
    const { spy, count } = events();
    onPlayerTimedText(new URL(`${base}&kind=asr&pot=T2&c=WEB`), '<xml/>');
    expect(count()).toBe(1);
    onPlayerTimedText(new URL(`${base}&kind=asr&pot=T2&c=WEB`), '<xml/>'); // same token: nothing new
    expect(count()).toBe(1);
    spy.mockRestore();
  });

  it('stays quiet for requests without token or usable body, and for translated tracks', () => {
    const { spy, count } = events();
    onPlayerTimedText(new URL(`${base}&fmt=json3`), '');
    onPlayerTimedText(new URL(`${base}&fmt=json3&tlang=de`), '{"events":[]}');
    onPlayerTimedText(new URL('https://www.youtube.com/api/timedtext?fmt=json3'), '{}');
    expect(count()).toBe(0);
    spy.mockRestore();
  });
});

describe('auto-translate', () => {
  const setPlayer = (resp: unknown) => {
    const el = document.createElement('div');
    el.id = 'movie_player';
    (el as unknown as Record<string, unknown>).getPlayerResponse = () => resp;
    document.body.appendChild(el);
    return () => el.remove();
  };

  it('reads translationLanguages and isTranslatable from the player response', () => {
    const off = setPlayer({
      videoDetails: { videoId: 'vid1', lengthSeconds: '10' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=vid1&lang=en', languageCode: 'en', isTranslatable: true }],
          translationLanguages: [
            { languageCode: 'de', languageName: { simpleText: 'German' } },
            { languageCode: 'fr', languageName: { runs: [{ text: 'Fr' }, { text: 'ench' }] } },
          ],
        },
      },
    });
    const info = playerInfo('vid1')!;
    expect(info.captionTracks[0]!.isTranslatable).toBe(true);
    expect(info.translationLanguages).toEqual([
      { languageCode: 'de', name: 'German' },
      { languageCode: 'fr', name: 'French' },
    ]);
    off();
  });

  it('adds tlang to the fetch URL and caches with and without tlang separately', async () => {
    const urls: string[] = [];
    fetchMock.mockImplementation(async (u: unknown) => {
      urls.push(String(u));
      return new Response(urls.length === 1 ? 'plain' : 'translated');
    });
    const track = { baseUrl: 'https://www.youtube.com/api/timedtext?v=vidT&lang=en', languageCode: 'en' };
    expect(await timedText('vidT', track)).toBe('plain');
    expect(await timedText('vidT', track, 'de')).toBe('translated');
    expect(await timedText('vidT', track)).toBe('plain');
    expect(await timedText('vidT', track, 'de')).toBe('translated');
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0]!).searchParams.has('tlang')).toBe(false);
    expect(new URL(urls[1]!).searchParams.get('tlang')).toBe('de');
  });

  it('caches a player tlang response under its own key without a captions event', async () => {
    const { spy, count } = events();
    onPlayerTimedText(new URL(`${base.replace('vid1', 'vidC')}&fmt=json3&tlang=de`), '{"events":[1]}');
    expect(count()).toBe(0);
    const track = { baseUrl: 'https://www.youtube.com/api/timedtext?v=vidC&lang=en', languageCode: 'en' };
    expect(await timedText('vidC', track, 'de')).toBe('{"events":[1]}');
    spy.mockRestore();
  });
});
