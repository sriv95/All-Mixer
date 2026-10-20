import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HIDE_CAPTIONS_STYLE_ID, findSettingsButton, findSettingsMainMenu, findSettingsPopup, findControlBar, findPlayer, setYtCaptionsHidden, NAVIGATION_EVENTS, onCaptionsButtonOn, detectSite, findMainVideo, getVideoId, onNavigate, watchMainVideo, touchesYtmPlayerPage } from './youtube-dom';

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

describe('findMainVideo generic', () => {
  it('picks the biggest video', () => {
    document.body.innerHTML = '<video id="small"></video><video id="big"></video>';
    const rect = (w: number) => () => ({ width: w, height: w }) as DOMRect;
    document.querySelector('#small')!.getBoundingClientRect = rect(10);
    document.querySelector('#big')!.getBoundingClientRect = rect(100);
    expect(findMainVideo('generic')?.id).toBe('big');
  });
  it('prefers what is playing', () => {
    document.body.innerHTML = '<video id="v"></video><audio id="a"></audio>';
    const a = document.querySelector<HTMLAudioElement>('#a')!;
    Object.defineProperty(a, 'paused', { value: false });
    expect(findMainVideo('generic')?.id).toBe('a');
  });
  it('takes an <audio>, and prefers a video', () => {
    document.body.innerHTML = '<audio id="a"></audio>';
    expect(findMainVideo('generic')?.id).toBe('a');
    document.body.innerHTML += '<video id="v"></video>';
    expect(findMainVideo('generic')?.id).toBe('v');
  });
  it('is null without media', () => {
    expect(findMainVideo('generic')).toBeNull();
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

describe('watchMainVideo mutations', () => {
  it('scans the page only when the added nodes hold media', async () => {
    const cb = vi.fn();
    const scan = vi.spyOn(document, 'querySelectorAll');
    const off = watchMainVideo('generic', cb);
    scan.mockClear();

    document.body.append(document.createElement('div'));
    await flush();
    expect(scan).not.toHaveBeenCalled();

    document.body.insertAdjacentHTML('beforeend', '<section><video></video></section>');
    await flush();
    expect(scan).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledTimes(1);
    scan.mockRestore();
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

  it.each(['youtube', 'ytmusic'] as const)('%s: prefers the player even when a preview comes first in DOM order', (site) => {
    document.body.innerHTML =
      '<ytd-video-preview><video class="video-stream html5-main-video" id="preview"></video></ytd-video-preview>' +
      (site === 'ytmusic' ? `<ytmusic-player>${fixture('watch')}</ytmusic-player>` : fixture('watch'));
    expect(findMainVideo(site)?.id).toBe('main');
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

describe('onCaptionsButtonOn', () => {
  it('fires once when aria-pressed goes false -> true, also for a re-created button', async () => {
    document.body.innerHTML = '<div id="movie_player"><button class="ytp-subtitles-button" aria-pressed="false"></button></div>';
    const cb = vi.fn();
    const stop = onCaptionsButtonOn(cb);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const btn = () => document.querySelector('.ytp-subtitles-button')!;
    btn().setAttribute('aria-pressed', 'true');
    await tick();
    expect(cb).toHaveBeenCalledTimes(1);
    btn().setAttribute('aria-pressed', 'true');
    await tick();
    expect(cb).toHaveBeenCalledTimes(1);
    btn().setAttribute('aria-pressed', 'false');
    await tick();
    btn().setAttribute('aria-pressed', 'true');
    await tick();
    expect(cb).toHaveBeenCalledTimes(2);
    document.body.innerHTML = '<button class="other" aria-pressed="false"></button>';
    document.querySelector('.other')!.setAttribute('aria-pressed', 'true');
    await tick();
    expect(cb).toHaveBeenCalledTimes(2);
    stop();
    document.body.innerHTML = '';
  });
});

describe('setYtCaptionsHidden', () => {
  afterEach(() => setYtCaptionsHidden(false));
  const count = () => document.querySelectorAll(`#${HIDE_CAPTIONS_STYLE_ID}`).length;

  it('adds one style, idempotently, and removes it', () => {
    setYtCaptionsHidden(true);
    setYtCaptionsHidden(true);
    expect(count()).toBe(1);
    expect(document.getElementById(HIDE_CAPTIONS_STYLE_ID)!.textContent).toContain('.ytp-caption-window-container');
    setYtCaptionsHidden(false);
    setYtCaptionsHidden(false);
    expect(count()).toBe(0);
  });
});

describe('player hooks (karaoke)', () => {
  it('finds the player on both sites', () => {
    document.body.innerHTML = '<div id="movie_player"><div class="ytp-chrome-bottom"></div></div>';
    const player = document.getElementById('movie_player');
    expect(findPlayer('youtube')).toBe(player);
    expect(findPlayer('ytmusic')).toBe(player);
    expect(findPlayer('youtube', document.createElement('div'))).toBeNull();
  });

  it('finds the control bar on www only', () => {
    document.body.innerHTML = '<div id="movie_player"><div class="ytp-chrome-bottom"></div></div>';
    const player = document.getElementById('movie_player')!;
    expect(findControlBar('youtube', player)).toBe(player.firstElementChild);
    expect(findControlBar('ytmusic', player)).toBeNull();
  });
});

describe('settings menu hooks', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  const build = () => {
    document.body.innerHTML = `
      <button class="ytp-button ytp-settings-button"></button>
      <div class="ytp-popup ytp-settings-menu">
        <div class="ytp-panel" id="sub"><div class="ytp-panel-header"><button class="ytp-panel-back-button"></button></div><div class="ytp-panel-menu" id="subm"></div></div>
        <div class="ytp-panel" id="ours" data-own><div class="ytp-panel-menu" id="ourm"></div></div>
        <div class="ytp-panel" id="main"><div class="ytp-panel-menu" id="mainm"><div class="ytp-menuitem"><div class="ytp-menuitem-label"></div><div class="ytp-menuitem-content"></div></div></div></div>
      </div>`;
  };

  it('finds the gear button and the popup', () => {
    build();
    expect(findSettingsButton()).toBe(document.querySelector('.ytp-settings-button'));
    expect(findSettingsPopup()).toBe(document.querySelector('.ytp-settings-menu'));
  });

  it('finds the main panel menu, skipping header panels and our own', () => {
    build();
    expect(findSettingsMainMenu(findSettingsPopup()!, 'data-own')?.id).toBe('mainm');
  });

  it('returns null without a popup or main panel', () => {
    expect(findSettingsPopup()).toBeNull();
    expect(findSettingsButton()).toBeNull();
    expect(findSettingsMainMenu(document.createElement('div'), 'data-own')).toBeNull();
  });
});

describe('touchesYtmPlayerPage', () => {
  const records = (mutate: () => void) => {
    const obs = new MutationObserver(() => {});
    obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    mutate();
    const r = obs.takeRecords();
    obs.disconnect();
    return r;
  };

  it('ignores churn outside the player page and notices changes inside or of it', () => {
    document.body.innerHTML = '<ytmusic-player-bar></ytmusic-player-bar><div id="shelf"></div><ytmusic-player-page><div id="tab-renderer"></div></ytmusic-player-page>';
    const add = (parent: string) => () => document.querySelector(parent)!.append(document.createElement('span'));
    expect(touchesYtmPlayerPage(records(add('ytmusic-player-bar')))).toBe(false);
    expect(touchesYtmPlayerPage(records(add('#shelf')))).toBe(false);
    expect(touchesYtmPlayerPage(records(add('#tab-renderer')))).toBe(true);
    expect(touchesYtmPlayerPage(records(() => document.querySelector('#tab-renderer')!.setAttribute('aria-selected', 'true')))).toBe(true);
    expect(touchesYtmPlayerPage(records(() => document.querySelector('ytmusic-player-page')!.remove()))).toBe(true);
    const wrap = document.createElement('div');
    wrap.innerHTML = '<ytmusic-player-page></ytmusic-player-page>';
    expect(touchesYtmPlayerPage(records(() => document.body.append(wrap)))).toBe(true);
  });
});
