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
