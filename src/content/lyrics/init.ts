import type { FetchLyrics, PinLyrics, SearchLyrics, UnpinLyrics } from '../../shared/messages';
import type { FoundLyrics, LrclibRecord } from '../../lyrics/lrclib-types';
import { toFound } from '../../lyrics/lrclib';
import { CC_BUTTON_SELECTOR, clickCaptionsButton, findLyricsControls, getCaptionsButtonState, findPlayer, getVideoId, onCaptionsButtonOn, onNavigate, setYtCaptionsHidden, type Site } from '../youtube-dom';
import { linesToLrc, lyricsToText } from '../../lyrics/export';
import { getPlayerInfo, getTimedText, onCaptionsAvailable } from './bridge-client';
import { LyricsController, type LyricsState } from './controller';
import { YtSettingsMenu, YtmSettingsPopover, buildMenuButtons, buildMenuRows, timingLabel, type LyricsMenu } from './settings-menu';
import { openFindDialog, openOwnDialog } from './lyrics-dialog';
import { showToast, timingKeyDelta } from './timing-keys';
import { PanelSurface, YtmTabSurface } from './surfaces';
import { CaptionBoot } from './caption-boot';
import { KaraokeSurface } from './karaoke-overlay';
import { DEFAULT_LYRICS_PREFS, MAX_LYRICS_OFFSET_MS, loadLyricsPrefs, saveLyricsPrefs, watchLyricsPrefs, type LyricsPrefs } from '../../shared/lyrics-prefs';

const BUTTON_ATTR = 'data-allmixer-lyrics-btn';

export interface LyricsFeature {
  setVideo(video: HTMLVideoElement): void;
  togglePanel(): void;
  /** The Default / Separate mode was toggled: run the CC boot again (CC on to load the captions, back off if it was off). */
  modeChanged(): void;
}

/**
 * F1 + F2 wiring. `presentedTime` returns the media time of the delayed picture on screen
 * (D1 delay), or null without an overlay, so the highlight follows what the user sees and hears.
 */
export function initLyrics(site: Site, presentedTime: () => number | null, presentedBusy: () => boolean = () => false): LyricsFeature {
  // YT Music shows lyrics in its Lyrics tab only: no karaoke text (the song tab has no video) and no lyrics window.
  const tabOnly = site === 'ytmusic';
  // CC at the start of each video (www): see CaptionBoot. Set up below with the caption hiding it drives.
  const boot: CaptionBoot = new CaptionBoot({
    state: () => getCaptionsButtonState(),
    toggle: () => clickCaptionsButton(),
    onInitial: (wasOn) => {
      if (wasOn) forceCaptions();
    },
  });
  const controller = new LyricsController(site, {
    getPlayerInfo,
    getTimedText,
    onCaptionsAvailable: (cb) =>
      onCaptionsAvailable((id) => {
        boot.captionsLoaded(id);
        cb(id);
      }),
    fetchLyrics: (track) => chrome.runtime.sendMessage({ type: 'fetch-lyrics', track } satisfies FetchLyrics) as Promise<FoundLyrics | null>,
    presentedTime,
    presentedBusy,
    offsetMs: (id) => (id ? (prefs.lyricsOffsets[id] ?? 0) : 0),
  });
  const view = {
    onSeek: (t: number) => controller.seek(t),
  };

  // Display prefs are global (chrome.storage.local); defaults until the first load answers.
  let prefs: LyricsPrefs = DEFAULT_LYRICS_PREFS;
  const storage = typeof chrome !== 'undefined' ? chrome.storage?.local : undefined;

  const wantWindow = () => !tabOnly && prefs.lyricsVisible && prefs.lyricsDisplayMode === 'window';

  const panel = new PanelSurface(
    site,
    view,
    (open) => {
      // The window is open <=> lyrics visible in `window` mode: its own close (X) hides the lyrics.
      if (!open && wantWindow()) setPrefs({ lyricsVisible: false });
      // A saved "open" state from an earlier session must not show the window when it is not wanted.
      if (open && !wantWindow()) panel.panel.hide();
      syncButton();
      syncCaptions();
      controller.refresh();
    },
    wantWindow,
  );
  controller.addSurface(panel);

  const karaoke = new KaraokeSurface({
    site,
    getPrefs: () => prefs,
    onPosition: (karaokePosition) => {
      prefs = { ...prefs, karaokePosition };
      if (storage) void saveLyricsPrefs(storage, { karaokePosition });
    },
    setPrefs: (patch) => setPrefs(patch),
  });
  if (!tabOnly) controller.addSurface(karaoke);

  // YouTube's own captions don't sync with our lyrics: hide them while karaoke text or the window shows (www only),
  // from the start of each video. The user can show them again by pressing the CC button (`captionsForced`).
  let captionsForced = false;
  let lastVideoId: string | null = null;
  let bootedFor: string | null = null;
  const syncCaptions = () => {
    if (site !== 'youtube') return;
    const wanted = karaoke.active || panel.active;
    setYtCaptionsHidden(wanted && !captionsForced);
    // Lyrics are wanted for this video: read the CC state (once) and load the captions.
    if (wanted && lastVideoId && bootedFor !== lastVideoId) {
      bootedFor = lastVideoId;
      boot.start(lastVideoId);
    }
  };
  /** Mode toggle: same as a new video. CC goes on to re-load the captions and back off if it was off before. */
  const rebootCaptions = () => {
    if (boot.restoringOff) return; // a boot is already running: its CC press is ours, do not read it as the user's
    bootedFor = null;
    syncCaptions();
  };
  const forceCaptions = () => {
    if (captionsForced) return;
    captionsForced = true;
    syncCaptions();
  };
  const applyPrefs = (next: LyricsPrefs) => {
    prefs = next;
    controller.applyStored(next.lyricsSource, next.captionLang);
    if (wantWindow() && !panel.panel.isOpen) panel.panel.show();
    if (!wantWindow() && panel.panel.isOpen) panel.panel.hide();
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
  /** ♪: show / hide the lyrics (the display mode stays as chosen in the settings). */
  const toggleVisible = () => setPrefs({ lyricsVisible: !prefs.lyricsVisible });

  // Lyrics settings: one model, drawn in YouTube's gear menu (www) or our own popover (YT Music).
  let lastState: LyricsState = { kind: 'idle' };
  const ytMenu = site === 'youtube' ? new YtSettingsMenu() : null;
  const popover = site === 'ytmusic' ? new YtmSettingsPopover() : null;
  const menus: LyricsMenu[] = [ytMenu, popover].filter((m): m is YtSettingsMenu | YtmSettingsPopover => m !== null);
  const actions = {
    selectSource: (p: Parameters<LyricsController['selectSource']>[0]) => {
      controller.selectSource(p);
      setPrefs({ lyricsSource: p });
    },
    selectCaptionTrack: (p: Parameters<LyricsController['selectCaptionTrack']>[0]) => {
      controller.selectCaptionTrack(p);
      setPrefs({ captionLang: controller.captionLang });
    },
    setPrefs,
    copyLyrics: () => {
      const lyrics = lastState.kind === 'ready' ? lastState.lyrics : null;
      if (!lyrics) return;
      void navigator.clipboard?.writeText(lyricsToText(lyrics)).catch(() => {});
      return 'Copied';
    },
    saveLrc: () => {
      if (lastState.kind !== 'ready' || lastState.lyrics.kind !== 'synced') return;
      const { track, lyrics } = lastState;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([linesToLrc(lyrics.lines, track)], { type: 'text/plain;charset=utf-8' }));
      a.download = `${`${track.artist} - ${track.title}`.replace(/[\\/:*?"<>|]+/g, '_')}.lrc`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return 'Saved';
    },
    findLyrics: () => {
      const track = lastState.kind === 'ready' || lastState.kind === 'not-found' ? lastState.track : undefined;
      openFindDialog({
        track,
        search: (q) => chrome.runtime.sendMessage({ type: 'search-lyrics', q } satisfies SearchLyrics) as Promise<LrclibRecord[]>,
        choose: (record) => void useLyrics(toFound(record)),
        reset: () => void useLyrics(null),
      });
    },
    myLyrics: () => {
      const track = lastState.kind === 'ready' || lastState.kind === 'not-found' ? lastState.track : undefined;
      openOwnDialog({ track, choose: (found) => void useLyrics(found), reset: () => void useLyrics(null) });
    },
    setOffset: (ms: number) => {
      if (!lastVideoId) return;
      // Delete first so a changed entry moves to the end (newest) of the stored map.
      const offsets = { ...prefs.lyricsOffsets };
      delete offsets[lastVideoId];
      if (ms) offsets[lastVideoId] = ms;
      setPrefs({ lyricsOffsets: offsets });
    },
  };
  /** Make `found` (or, with null, the automatic match) this video's lyrics, kept from now on. */
  const useLyrics = async (found: FoundLyrics | null) => {
    const videoId = lastVideoId;
    if (!videoId) return;
    const msg: PinLyrics | UnpinLyrics = found ? { type: 'pin-lyrics', videoId, found } : { type: 'unpin-lyrics', videoId };
    await chrome.runtime.sendMessage(msg);
    controller.reload();
    // A picked LRCLIB text would stay hidden behind captions otherwise.
    if (found) setPrefs({ lyricsSource: 'lrclib' });
  };
  const syncMenu = () => {
    const ready = lastState.kind === 'ready' ? lastState : null;
    const timing = ready?.lyrics.kind === 'synced' && lastVideoId ? { offsetMs: prefs.lyricsOffsets[lastVideoId] ?? 0 } : undefined;
    const input = { sources: ready?.sources, captions: ready?.captions, prefs, site, timing, lyrics: ready ? { synced: ready.lyrics.kind === 'synced' } : undefined, canEdit: !!lastVideoId && (lastState.kind === 'ready' || lastState.kind === 'not-found') };
    const rows = buildMenuRows(input, actions);
    const buttons = buildMenuButtons(input, actions);
    for (const m of menus) m.setRows(rows, buttons);
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

  // [ and ] nudge the timing of the shown synced lyrics (capture phase, so YouTube's own handler does not also see them).
  document.addEventListener(
    'keydown',
    (e) => {
      const delta = prefs.lyricsTimingKeys ? timingKeyDelta(e) : 0;
      const id = lastVideoId;
      if (!delta || !id || lastState.kind !== 'ready' || lastState.lyrics.kind !== 'synced') return;
      if (!(karaoke.active || panel.active || tab?.active)) return;
      e.preventDefault();
      e.stopPropagation();
      const ms = Math.max(-MAX_LYRICS_OFFSET_MS, Math.min(MAX_LYRICS_OFFSET_MS, (prefs.lyricsOffsets[id] ?? 0) + delta));
      actions.setOffset(ms);
      showToast(`Lyrics timing ${timingLabel(ms)}`);
    },
    true,
  );

  // CC turned on: the event from the page bridge can be missed, so re-align a few times on our own.
  if (site === 'youtube') {
    onCaptionsButtonOn(() => {
      // Our own start-of-video press does not count as the user taking over.
      if (!boot.isOwnChange()) forceCaptions();
      controller.realignWithRetries();
    });
    // Any press on CC (also turning it off) means the user wants control over YouTube's captions now.
    document.addEventListener('click', (e) => {
      if (!e.isTrusted || !(e.target as Element | null)?.closest?.(CC_BUTTON_SELECTOR)) return;
      boot.userToggled();
      forceCaptions();
    }, true);
  }

  // Which video is this? The URL on watch pages; the player itself elsewhere (miniplayer, YT Music player bar).
  let checkSeq = 0;
  const checkVideo = async () => {
    const seq = ++checkSeq;
    let id = getVideoId(location.href);
    if (!id && video?.currentSrc) {
      const info = await getPlayerInfo('', new AbortController().signal, 1500);
      id = info?.videoId ?? null;
    }
    if (seq !== checkSeq) return;
    if (id !== lastVideoId) {
      lastVideoId = id;
      captionsForced = false;
      boot.cancel();
    }
    // Also when the id is unchanged: on a fresh load the player may only exist now (the first call found no player, so no boot).
    syncCaptions();
    controller.setVideoId(id);
  };

  let video: HTMLVideoElement | null = null;
  onNavigate(() => {
    void checkVideo();
    ensureButton();
  });

  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute(BUTTON_ATTR, '');
  button.title = 'Show / hide lyrics (All Mixer!)';
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
    toggleVisible();
  });
  const syncButton = () => {
    button.style.opacity = prefs.lyricsVisible ? '1' : '0.5';
    button.setAttribute('aria-pressed', String(prefs.lyricsVisible));
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
    togglePanel: toggleVisible,
    modeChanged: rebootCaptions,
  };
}
