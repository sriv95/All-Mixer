import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_TAG } from '../shared/bridge';
import { onPlayerTimedText } from './bridge';

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
