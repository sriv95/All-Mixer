import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LyricsState } from './controller';
import { PanelSurface, YTM_MOUNT_ATTR, YtmTabSurface } from './surfaces';
import { HIDE_CAPTIONS_STYLE_ID, findLyricsControls } from '../youtube-dom';

const fixture = readFileSync('src/content/__fixtures__/ytmusic-lyrics-tab.html', 'utf8');
const track = { videoId: 'v', title: 'Song', artist: 'Band', duration: 100 };
const synced: LyricsState = {
  kind: 'ready',
  track,
  lyrics: { kind: 'synced', source: 'lrclib', offset: 0, hasWordTiming: false, lines: [{ start: 1, end: 3, text: 'hello' }] },
};
const plain: LyricsState = { kind: 'ready', track, lyrics: { kind: 'plain', source: 'lrclib', text: 'hello' } };

const tabs = () => document.querySelectorAll('tp-yt-paper-tab');
const content = () => document.getElementById('tab-renderer')!;
function select(i: number) {
  tabs().forEach((t, j) => t.setAttribute('aria-selected', String(i === j)));
}

beforeEach(() => {
  document.body.innerHTML = fixture;
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('YtmTabSurface (F1)', () => {
  it('is active only while the Lyrics tab is selected', () => {
    const s = new YtmTabSurface({ onSeek: () => {} });
    expect(s.active).toBe(false);
    select(1);
    expect(s.active).toBe(true);
  });

  it('re-enables a disabled Lyrics tab once synced lyrics exist', () => {
    const s = new YtmTabSurface({ onSeek: () => {} });
    s.render(synced);
    expect(tabs()[1].hasAttribute('disabled')).toBe(false);
    expect(tabs()[1].getAttribute('aria-disabled')).toBe('false');
  });

  it('leaves the tab alone for an auto-generated transcript', () => {
    const s = new YtmTabSurface({ onSeek: () => {} });
    const asr: LyricsState = {
      kind: 'ready',
      track,
      lyrics: { kind: 'synced', source: 'youtube-auto-captions', offset: 0, hasWordTiming: false, lines: [{ start: 1, end: 3, text: 'hello' }] },
    };
    s.render(asr);
    select(1);
    s.sync();
    expect(s.mounted).toBe(false);
    expect(tabs()[1].hasAttribute('disabled')).toBe(true);
  });

  it('takes over the tab content with synced lyrics and hands it back on tab switch', () => {
    const s = new YtmTabSurface({ onSeek: () => {} });
    s.render(synced);
    expect(s.mounted).toBe(false);
    select(1);
    s.sync();
    expect(s.mounted).toBe(true);
    expect(content().hasAttribute(YTM_MOUNT_ATTR)).toBe(true);
    expect(content().querySelector('[data-am-lyrics]')).not.toBeNull();

    select(0);
    s.sync();
    expect(s.mounted).toBe(false);
    expect(content().hasAttribute(YTM_MOUNT_ATTR)).toBe(false);
    expect(content().textContent).toContain('Native static lyrics');
  });

  it('falls back to YT Music lyrics when there are no synced lyrics', () => {
    const s = new YtmTabSurface({ onSeek: () => {} });
    select(1);
    s.render(synced);
    expect(s.mounted).toBe(true);
    for (const st of [plain, { kind: 'not-found' } as LyricsState, { kind: 'loading' } as LyricsState]) {
      s.render(st);
      expect(s.mounted).toBe(false);
      expect(content().hasAttribute(YTM_MOUNT_ATTR)).toBe(false);
    }
  });

  it('remounts when YT Music re-renders the tab content', () => {
    const s = new YtmTabSurface({ onSeek: () => {} });
    select(1);
    s.render(synced);
    content().replaceChildren();
    s.sync();
    expect(s.mounted).toBe(true);
  });

  it('injects the hide-native style once', () => {
    new YtmTabSurface({ onSeek: () => {} });
    new YtmTabSurface({ onSeek: () => {} });
    expect(document.querySelectorAll('#all-mixer-ytm-lyrics-style').length).toBe(1);
  });
});

describe('findLyricsControls', () => {
  it('finds the YT Music player bar controls', () => {
    expect(findLyricsControls('ytmusic')?.querySelector('#native-btn')).not.toBeNull();
  });
});

describe('PanelSurface hides YouTube captions', () => {
  const view = { onSeek: () => {}, onCaptionTrack: () => {}, onSource: () => {} };
  const count = () => document.querySelectorAll(`#${HIDE_CAPTIONS_STYLE_ID}`).length;
  afterEach(() => {
    document.getElementById('all-mixer-lyrics-panel')?.remove();
    document.getElementById(HIDE_CAPTIONS_STYLE_ID)?.remove();
  });

  it('adds the style once while open, removes on close and destroy', () => {
    const s = new PanelSurface('youtube', view, () => {});
    s.panel.show();
    s.panel.show();
    expect(count()).toBe(1);
    s.panel.hide();
    s.panel.hide();
    expect(count()).toBe(0);
    s.panel.show();
    s.destroy();
    expect(count()).toBe(0);
  });

  it('does nothing on music.youtube.com', () => {
    const s = new PanelSurface('ytmusic', view, () => {});
    s.panel.show();
    expect(count()).toBe(0);
    s.destroy();
  });
});
