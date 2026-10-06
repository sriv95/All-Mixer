import type { FetchLyrics } from '../../shared/messages';
import type { FoundLyrics } from '../../lyrics/lrclib-types';
import { findLyricsControls, findPlayer, getVideoId, onCaptionsButtonOn, onNavigate, setYtCaptionsHidden, type Site } from '../youtube-dom';
import { getPlayerInfo, getTimedText, onCaptionsAvailable } from './bridge-client';
import { LyricsController, type LyricsState } from './controller';
import { YtSettingsMenu, YtmSettingsPopover, buildMenuRows, type LyricsMenu } from './settings-menu';
import { PanelSurface, YtmTabSurface } from './surfaces';
import { KaraokeSurface } from './karaoke-overlay';
import { DEFAULT_LYRICS_PREFS, loadLyricsPrefs, saveLyricsPrefs, watchLyricsPrefs, type LyricsPrefs } from '../../shared/lyrics-prefs';

const BUTTON_ATTR = 'data-allmixer-lyrics-btn';

export interface LyricsFeature {
  setVideo(video: HTMLVideoElement): void;
  togglePanel(): void;
}

/**
 * F1 + F2 wiring. `presentedTime` returns the media time of the delayed picture on screen
 * (D1 delay), or null without an overlay, so the highlight follows what the user sees and hears.
 */
export function initLyrics(site: Site, presentedTime: () => number | null, presentedBusy: () => boolean = () => false): LyricsFeature {
  const controller = new LyricsController(site, {
    getPlayerInfo,
    getTimedText,
    onCaptionsAvailable,
    fetchLyrics: (track) => chrome.runtime.sendMessage({ type: 'fetch-lyrics', track } satisfies FetchLyrics) as Promise<FoundLyrics | null>,
    presentedTime,
    presentedBusy,
  });
  const view = {
    onSeek: (t: number) => controller.seek(t),
  };

  // Display prefs are global (chrome.storage.local); defaults until the first load answers.
  let prefs: LyricsPrefs = DEFAULT_LYRICS_PREFS;
  const storage = typeof chrome !== 'undefined' ? chrome.storage?.local : undefined;

  const panel = new PanelSurface(
    site,
    view,
    (open) => {
      // Panel open <=> mode `window`: the window's own close (X) goes back to karaoke text.
      if (!open && prefs.lyricsDisplayMode === 'window') setPrefs({ lyricsDisplayMode: 'karaoke' });
      // A saved "open" state from an earlier session must not show the window in karaoke mode.
      if (open && prefs.lyricsDisplayMode === 'karaoke') panel.panel.hide();
      syncButton();
      syncCaptions();
      controller.refresh();
    },
    () => prefs.lyricsDisplayMode === 'window',
  );
  controller.addSurface(panel);

  const karaoke = new KaraokeSurface({
    site,
    getPrefs: () => prefs,
    onPosition: (karaokePosition) => {
      prefs = { ...prefs, karaokePosition };
      if (storage) void saveLyricsPrefs(storage, { karaokePosition });
    },
  });
  controller.addSurface(karaoke);

  // YouTube's own captions don't sync with our lyrics: hide them while karaoke text or the window shows (www only).
  const syncCaptions = () => {
    if (site === 'youtube') setYtCaptionsHidden(karaoke.active || panel.active);
  };
  const applyPrefs = (next: LyricsPrefs) => {
    const leftWindow = prefs.lyricsDisplayMode === 'window' && next.lyricsDisplayMode === 'karaoke';
    prefs = next;
    if (leftWindow && panel.panel.isOpen) panel.panel.hide();
    if (next.lyricsDisplayMode === 'window' && !panel.panel.isOpen) panel.panel.show();
    karaoke.refreshPrefs();
    syncButton();
    syncCaptions();
    syncMenu();
    controller.refresh();
  };
  if (storage) {
    void loadLyricsPrefs(storage).then(applyPrefs);
    watchLyricsPrefs(chrome.storage.onChanged, applyPrefs);
  }
  /** Menu / button changes: apply now and store (other tabs follow through the storage watcher). */
  const setPrefs = (patch: Partial<LyricsPrefs>) => {
    applyPrefs({ ...prefs, ...patch });
    if (storage) void saveLyricsPrefs(storage, patch);
  };
  /** ♪: karaoke text <-> floating window. */
  const toggleMode = () => setPrefs({ lyricsDisplayMode: prefs.lyricsDisplayMode === 'karaoke' ? 'window' : 'karaoke' });

  // Lyrics settings: one model, drawn in YouTube's gear menu (www) or our own popover (YT Music).
  let lastState: LyricsState = { kind: 'idle' };
  const ytMenu = site === 'youtube' ? new YtSettingsMenu() : null;
  const popover = site === 'ytmusic' ? new YtmSettingsPopover() : null;
  const menus: LyricsMenu[] = [ytMenu, popover].filter((m): m is YtSettingsMenu | YtmSettingsPopover => m !== null);
  const actions = {
    selectSource: (p: Parameters<LyricsController['selectSource']>[0]) => controller.selectSource(p),
    selectCaptionTrack: (p: Parameters<LyricsController['selectCaptionTrack']>[0]) => controller.selectCaptionTrack(p),
    setPrefs,
  };
  const syncMenu = () => {
    const ready = lastState.kind === 'ready' ? lastState : null;
    const rows = buildMenuRows({ sources: ready?.sources, captions: ready?.captions, prefs }, actions);
    for (const m of menus) m.setRows(rows);
  };
  controller.addSurface({
    active: false,
    render: (state) => {
      lastState = state;
      syncMenu();
    },
    update: () => {},
  });
  syncMenu();

  let tab: YtmTabSurface | null = null;
  if (site === 'ytmusic') {
    const surface = new YtmTabSurface(view);
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
    toggleMode();
  });
  const syncButton = () => {
    const on = panel.active || karaoke.active;
    button.style.opacity = on ? '1' : '0.7';
    button.setAttribute('aria-pressed', String(panel.active));
  };
  // Player controls are re-created now and then; re-insert cheaply.
  const ensureButton = () => {
    const controls = findLyricsControls(site);
    if (controls && button.parentNode !== controls) controls.prepend(button);
    if (controls && popover && popover.button.parentNode !== controls) button.after(popover.button);
    const player = ytMenu && findPlayer(site);
    if (player) ytMenu.observe(player);
  };
  setInterval(ensureButton, 2000);
  ensureButton();
  syncButton();
  void checkVideo();

  return {
    setVideo(v) {
      video = v;
      controller.setVideo(v);
      karaoke.sync();
      // New track without SPA navigation (autoplay, YT Music queue).
      v.addEventListener('loadedmetadata', () => void checkVideo());
      tab?.sync();
      void checkVideo();
    },
    togglePanel: toggleMode,
  };
}
