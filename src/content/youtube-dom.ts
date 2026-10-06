/**
 * All YouTube / YouTube Music DOM knowledge lives here (risk R3).
 * If YouTube changes its markup, this is the only file that should need edits.
 * Every selector and event name is covered by youtube-dom.test.ts.
 */

export type Site = 'youtube' | 'ytmusic';

export const SELECTORS = {
  youtube: {
    /** Main watch / miniplayer / theater / fullscreen player all reuse this element. */
    mainVideo: ['#movie_player video.html5-main-video', 'video.html5-main-video'],
  },
  ytmusic: {
    mainVideo: ['ytmusic-player #movie_player video', '#movie_player video', 'video.html5-main-video'],
  },
} as const satisfies Record<Site, { mainVideo: readonly string[] }>;

/** Custom events YouTube's SPA router fires on `document` after navigation. */
export const NAVIGATION_EVENTS = ['yt-navigate-finish', 'yt-page-data-updated'] as const;

export function detectSite(hostname: string): Site | null {
  if (hostname === 'music.youtube.com') return 'ytmusic';
  if (hostname === 'www.youtube.com' || hostname === 'youtube.com' || hostname === 'm.youtube.com') {
    return 'youtube';
  }
  return null;
}

export function findMainVideo(site: Site, root: ParentNode = document): HTMLVideoElement | null {
  for (const selector of SELECTORS[site].mainVideo) {
    const el = root.querySelector(selector);
    if (el instanceof HTMLVideoElement) return el;
  }
  return null;
}

/** Video id from a youtube.com / music.youtube.com URL (watch, shorts, live, embed). */
export function getVideoId(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const v = url.searchParams.get('v');
  if (v) return v;
  const m = url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{6,})/);
  return m ? m[1] : null;
}

/** Call `cb` after every SPA navigation. Returns an unsubscribe function. */
export function onNavigate(cb: () => void, target: Document = document): () => void {
  const win = target.defaultView;
  for (const name of NAVIGATION_EVENTS) target.addEventListener(name, cb);
  win?.addEventListener('popstate', cb);
  return () => {
    for (const name of NAVIGATION_EVENTS) target.removeEventListener(name, cb);
    win?.removeEventListener('popstate', cb);
  };
}

/**
 * Call `cb` with the main <video> whenever it first appears or is replaced.
 * YouTube normally keeps one element across SPA navigation, theater mode and
 * fullscreen, but we re-check on DOM mutations and navigation to be safe.
 */
export function watchMainVideo(
  site: Site,
  cb: (video: HTMLVideoElement) => void,
  doc: Document = document,
): () => void {
  let current: HTMLVideoElement | null = null;
  let scheduled = false;

  const check = () => {
    scheduled = false;
    const found = findMainVideo(site, doc);
    if (found && found !== current) {
      current = found;
      cb(found);
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(check);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  const offNav = onNavigate(schedule, doc);
  check();

  return () => {
    observer.disconnect();
    offNav();
  };
}

/** Lyrics hooks (F1 / F2). */
export const LYRICS_SELECTORS = {
  /** Player control bars that get the lyrics toggle button. */
  controls: {
    youtube: '#movie_player .ytp-right-controls',
    ytmusic: 'ytmusic-player-bar .right-controls-buttons',
  } satisfies Record<Site, string>,
  ytmusic: {
    /** Up next / Lyrics / Related. Labels are localised, so we go by position. */
    tabs: 'ytmusic-player-page tp-yt-paper-tab',
    lyricsTabIndex: 1,
    /** Container that shows the selected tab's content. */
    tabContent: 'ytmusic-player-page #tab-renderer',
  },
} as const;

export function findYtmLyricsTab(doc: ParentNode = document): HTMLElement | null {
  const tabs = doc.querySelectorAll<HTMLElement>(LYRICS_SELECTORS.ytmusic.tabs);
  return tabs[LYRICS_SELECTORS.ytmusic.lyricsTabIndex] ?? null;
}

export function findYtmTabContent(doc: ParentNode = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(LYRICS_SELECTORS.ytmusic.tabContent);
}

export function isTabSelected(tab: Element): boolean {
  return tab.getAttribute('aria-selected') === 'true' || tab.classList.contains('iron-selected');
}

/** YT Music greys out the Lyrics tab when it has no lyrics of its own. Re-enable it when we do. */
export function enableTab(tab: HTMLElement): void {
  tab.removeAttribute('disabled');
  tab.setAttribute('aria-disabled', 'false');
  (tab as HTMLElement & { disabled?: boolean }).disabled = false;
}

export function findLyricsControls(site: Site, doc: ParentNode = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(LYRICS_SELECTORS.controls[site]);
}

/** The player's CC button (youtube.com only; YT Music has none in the same place). */
export const CC_BUTTON_SELECTOR = '.ytp-subtitles-button';

/**
 * Call `cb` when the CC button's aria-pressed goes from not-true to true.
 * One observer for the page's lifetime: it matches the button by selector, so it survives
 * the player re-creating its controls and SPA navigation. Returns a disconnect function.
 */
export function onCaptionsButtonOn(cb: () => void, root: Document = document): () => void {
  const pressed = (el: Element) => el.getAttribute('aria-pressed') === 'true';
  const was = new WeakMap<Element, boolean>();
  const seed = root.querySelector(CC_BUTTON_SELECTOR);
  if (seed) was.set(seed, pressed(seed));
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target as Element;
      if (r.attributeName !== 'aria-pressed' || !el.matches?.(CC_BUTTON_SELECTOR)) continue;
      const now = pressed(el);
      if (now && was.get(el) !== true) cb();
      was.set(el, now);
    }
  });
  obs.observe(root.documentElement, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  return () => obs.disconnect();
}

export const HIDE_CAPTIONS_STYLE_ID = 'all-mixer-hide-yt-captions';

/**
 * Pure display toggle for YouTube's own caption overlay (it does not sync with our lyrics).
 * Leaves the CC button and caption state alone. Idempotent: at most one style element.
 */
export function setYtCaptionsHidden(hidden: boolean, doc: Document = document): void {
  const existing = doc.getElementById(HIDE_CAPTIONS_STYLE_ID);
  if (!hidden) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const style = doc.createElement('style');
  style.id = HIDE_CAPTIONS_STYLE_ID;
  style.textContent = '.ytp-caption-window-container, .caption-window { display: none !important; }';
  (doc.head ?? doc.documentElement).append(style);
}

/** Karaoke text hooks: the player element the video lives in, and (www only) the control bar over its bottom edge. */
export const PLAYER_SELECTORS = {
  player: { youtube: '#movie_player', ytmusic: 'ytmusic-player #movie_player, #movie_player' } satisfies Record<Site, string>,
  /** On YT Music the player bar is outside the player, so there is no inset. */
  controlBar: { youtube: '.ytp-chrome-bottom', ytmusic: null } satisfies Record<Site, string | null>,
} as const;

export function findPlayer(site: Site, doc: ParentNode = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(PLAYER_SELECTORS.player[site]);
}

/** Classes the player carries while it plays an ad. */
export const AD_PLAYER_SELECTOR = '.ad-showing, .ad-interrupting';

export function isAdShowing(player: Element): boolean {
  return player.matches(AD_PLAYER_SELECTOR);
}

export function findControlBar(site: Site, player: ParentNode): HTMLElement | null {
  const selector = PLAYER_SELECTORS.controlBar[site];
  return selector ? player.querySelector<HTMLElement>(selector) : null;
}

/** www player settings menu (gear): we add our own rows to its main panel and open our own submenu panels. */
export const SETTINGS_SELECTORS = {
  button: '.ytp-settings-button',
  popup: '.ytp-popup.ytp-settings-menu',
  panel: '.ytp-panel',
  panelMenu: '.ytp-panel-menu',
  menuItem: '.ytp-menuitem',
  menuItemLabel: '.ytp-menuitem-label',
  menuItemContent: '.ytp-menuitem-content',
  panelHeader: '.ytp-panel-header',
  backButton: '.ytp-panel-back-button',
} as const;

export function findSettingsButton(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(SETTINGS_SELECTORS.button);
}

export function findSettingsPopup(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(SETTINGS_SELECTORS.popup);
}

/** The main panel's item list: the first panel without a back-button header and not one of ours (`ownAttr`). */
export function findSettingsMainMenu(popup: ParentNode, ownAttr: string): HTMLElement | null {
  for (const panel of popup.querySelectorAll<HTMLElement>(SETTINGS_SELECTORS.panel)) {
    if (panel.hasAttribute(ownAttr) || panel.querySelector(SETTINGS_SELECTORS.panelHeader)) continue;
    const menu = panel.querySelector<HTMLElement>(SETTINGS_SELECTORS.panelMenu);
    if (menu) return menu;
  }
  return null;
}
