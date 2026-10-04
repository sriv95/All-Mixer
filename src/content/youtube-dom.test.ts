import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAVIGATION_EVENTS, detectSite, findMainVideo, getVideoId, onNavigate, watchMainVideo } from './youtube-dom';

const fixture = (name: string) => readFileSync(`src/content/__fixtures__/${name}.html`, 'utf8');

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('detectSite', () => {
  it('knows both sites', () => {
    expect(detectSite('www.youtube.com')).toBe('youtube');
    expect(detectSite('music.youtube.com')).toBe('ytmusic');
    expect(detectSite('example.com')).toBeNull();
    expect(detectSite('youtube.com.evil.test')).toBeNull();
  });
});

describe('getVideoId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'dQw4w9WgXcQ'],
    ['https://music.youtube.com/watch?v=abcdefghijk&list=RD', 'abcdefghijk'],
    ['https://www.youtube.com/shorts/abcdefghijk', 'abcdefghijk'],
    ['https://www.youtube.com/live/abcdefghijk?si=x', 'abcdefghijk'],
    ['https://www.youtube.com/', null],
    ['not a url', null],
  ])('%s → %s', (href, id) => {
    expect(getVideoId(href)).toBe(id);
  });
});

describe('findMainVideo', () => {
  it('finds the YouTube main player, not preview videos', () => {
    document.body.innerHTML = `
      <ytd-video-preview><video class="preview"></video></ytd-video-preview>
      <div id="movie_player"><div class="html5-video-container"><video class="video-stream html5-main-video"></video></div></div>`;
    expect(findMainVideo('youtube')?.classList.contains('html5-main-video')).toBe(true);
  });

  it('finds the YT Music player', () => {
    document.body.innerHTML = `<ytmusic-player><div id="movie_player"><video class="video-stream html5-main-video"></video></div></ytmusic-player>`;
    expect(findMainVideo('ytmusic')).toBeInstanceOf(HTMLVideoElement);
  });

  it('returns null when there is no player', () => {
    document.body.innerHTML = '<video></video>';
    expect(findMainVideo('youtube')).toBeNull();
  });
});

describe('onNavigate', () => {
  it('fires for each YouTube navigation event and unsubscribes', () => {
    const cb = vi.fn();
    const off = onNavigate(cb);
    for (const name of NAVIGATION_EVENTS) document.dispatchEvent(new Event(name));
    expect(cb).toHaveBeenCalledTimes(NAVIGATION_EVENTS.length);
    off();
    document.dispatchEvent(new Event(NAVIGATION_EVENTS[0]));
    expect(cb).toHaveBeenCalledTimes(NAVIGATION_EVENTS.length);
  });
});

describe('watchMainVideo', () => {
  it('reports the video when it appears and again only when it is replaced', async () => {
    const cb = vi.fn();
    const off = watchMainVideo('youtube', cb);
    expect(cb).not.toHaveBeenCalled();

    document.body.innerHTML = '<div id="movie_player"><video class="html5-main-video"></video></div>';
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    const first = cb.mock.calls[0][0];

    // Unrelated DOM churn + SPA navigation with the same element: no new call.
    document.body.append(document.createElement('div'));
    document.dispatchEvent(new Event('yt-navigate-finish'));
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);

    // Player rebuilt with a new element.
    document.querySelector('#movie_player')!.innerHTML = '<video class="html5-main-video"></video>';
    await flush();
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0]).not.toBe(first);
    off();
  });
});

describe('findMainVideo fixtures', () => {
  it.each([
    ['youtube', 'watch'],
    ['youtube', 'theater'],
    ['youtube', 'fullscreen'],
    ['youtube', 'miniplayer'],
    ['youtube', 'shorts'],
    ['ytmusic', 'ytmusic'],
    ['ytmusic', 'ytmusic-audio-only'],
  ] as const)('%s / %s: returns the player video, ignores previews', (site, name) => {
    document.body.innerHTML = fixture(name);
    const video = findMainVideo(site);
    expect(video).not.toBeNull();
    expect(video?.id).toBe('main');
    expect(video?.closest('#movie_player')).not.toBeNull();
  });

  it('theater and fullscreen fixtures carry the expected state attributes', () => {
    document.body.innerHTML = fixture('theater');
    expect(document.querySelector('ytd-watch-flexy[theater]')).not.toBeNull();
    document.body.innerHTML = fixture('fullscreen');
    expect(document.querySelector('ytd-watch-flexy[fullscreen]')).not.toBeNull();
  });
});

describe('watchMainVideo navigation', () => {
  it('fires on popstate / yt-page-data-updated only if the element changed; off() stops it', async () => {
    document.body.innerHTML = fixture('watch');
    const cb = vi.fn();
    const off = watchMainVideo('youtube', cb);
    expect(cb).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('popstate'));
    document.dispatchEvent(new Event('yt-page-data-updated'));
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);

    document.querySelector('#movie_player video')!.replaceWith(Object.assign(document.createElement('video'), { className: 'html5-main-video', id: 'main' }));
    window.dispatchEvent(new Event('popstate'));
    await flush();
    expect(cb).toHaveBeenCalledTimes(2);

    off();
    document.querySelector('#movie_player video')!.replaceWith(Object.assign(document.createElement('video'), { className: 'html5-main-video' }));
    window.dispatchEvent(new Event('popstate'));
    document.dispatchEvent(new Event('yt-page-data-updated'));
    await flush();
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
