import type { FetchLyrics } from '../../shared/messages';
import type { FoundLyrics } from '../../lyrics/lrclib-types';
import { findLyricsControls, getVideoId, onCaptionsButtonOn, onNavigate, type Site } from '../youtube-dom';
import { getPlayerInfo, getTimedText, onCaptionsAvailable } from './bridge-client';
import { LyricsController } from './controller';
import { PanelSurface, YtmTabSurface } from './surfaces';

const BUTTON_ATTR = 'data-allmixer-lyrics-btn';

export interface LyricsFeature {
  setVideo(video: HTMLVideoElement): void;
  togglePanel(): void;
}

/**
 * F1 + F2 wiring. `audioDelay` returns the seconds by which picture and sound
 * trail `video.currentTime` (D1 delay), so the highlight follows what the user hears.
 */
export function initLyrics(site: Site, audioDelay: () => number): LyricsFeature {
  const controller = new LyricsController(site, {
    getPlayerInfo,
    getTimedText,
    onCaptionsAvailable,
    fetchLyrics: (track) => chrome.runtime.sendMessage({ type: 'fetch-lyrics', track } satisfies FetchLyrics) as Promise<FoundLyrics | null>,
    audioDelay,
  });
  const seek = (t: number) => controller.seek(t);

  const panel = new PanelSurface(site, seek, () => {
    syncButton();
    controller.refresh();
  });
  controller.addSurface(panel);

  let tab: YtmTabSurface | null = null;
  if (site === 'ytmusic') {
    const surface = new YtmTabSurface(seek);
    tab = surface;
    controller.addSurface(surface);
    // Tab clicks flip aria-selected; YT Music also re-renders the tab content.
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        surface.sync();
        controller.refresh();
      });
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected'] });
  }

  // CC turned on: the event from the page bridge can be missed, so re-align a few times on our own.
  if (site === 'youtube') onCaptionsButtonOn(() => controller.realignWithRetries());

  // Which video is this? The URL on watch pages; the player itself elsewhere (miniplayer, YT Music player bar).
  let checkSeq = 0;
  const checkVideo = async () => {
    const seq = ++checkSeq;
    let id = getVideoId(location.href);
    if (!id && video?.currentSrc) {
      const info = await getPlayerInfo('', new AbortController().signal, 1500);
      id = info?.videoId ?? null;
    }
    if (seq === checkSeq) controller.setVideoId(id);
  };

  let video: HTMLVideoElement | null = null;
  onNavigate(() => {
    void checkVideo();
    ensureButton();
  });

  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute(BUTTON_ATTR, '');
  button.title = 'Lyrics (All Mixer!)';
  button.setAttribute('aria-label', 'Lyrics');
  button.textContent = '♪';
  if (site === 'youtube') {
    button.className = 'ytp-button';
    button.style.cssText = 'font-size:20px;line-height:1;text-align:center;color:#fff;vertical-align:top;';
  } else {
    button.style.cssText = 'background:none;border:0;color:inherit;font-size:20px;cursor:pointer;padding:0 8px;';
  }
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.panel.toggle();
  });
  const syncButton = () => {
    button.style.opacity = panel.active ? '1' : '0.7';
    button.setAttribute('aria-pressed', String(panel.active));
  };
  // Player controls are re-created now and then; re-insert cheaply.
  const ensureButton = () => {
    const controls = findLyricsControls(site);
    if (controls && button.parentNode !== controls) controls.prepend(button);
  };
  setInterval(ensureButton, 2000);
  ensureButton();
  syncButton();
  void checkVideo();

  return {
    setVideo(v) {
      video = v;
      controller.setVideo(v);
      // New track without SPA navigation (autoplay, YT Music queue).
      v.addEventListener('loadedmetadata', () => void checkVideo());
      tab?.sync();
      void checkVideo();
    },
    togglePanel: () => panel.panel.toggle(),
  };
}
