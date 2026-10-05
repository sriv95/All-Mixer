import type { LyricsState, LyricsSurface } from './controller';
import { FloatingPanel } from './floating-panel';
import { LyricsView, type LyricsViewOptions } from './lyrics-view';
import { enableTab, findYtmLyricsTab, findYtmTabContent, isTabSelected, type Site } from '../youtube-dom';

function show(view: LyricsView, state: LyricsState): void {
  switch (state.kind) {
    case 'idle':
      view.setStatus('not-found', 'Play a song to see its lyrics.');
      break;
    case 'loading':
      view.setStatus('loading');
      break;
    case 'ready':
      view.setLyrics(state.lyrics, state.captions);
      break;
    case 'not-found': {
      const t = state.track;
      view.setStatus('not-found', t ? `No lyrics found for “${t.title}”${t.artist ? ` by ${t.artist}` : ''}.` : undefined);
      break;
    }
    case 'error':
      view.setStatus('error');
      break;
  }
}

/** F2: lyrics in a floating panel (both sites, works in theater mode and fullscreen). */
export class PanelSurface implements LyricsSurface {
  readonly panel: FloatingPanel;
  private readonly view: LyricsView;

  constructor(site: Site, view: LyricsViewOptions, onOpenChange: (open: boolean) => void) {
    // Per site: on YT Music the Lyrics tab is the main view, so the panel starts closed there.
    this.panel = new FloatingPanel({ id: 'all-mixer-lyrics-panel', title: 'Lyrics', storageKey: `lyricsPanel:${site}` });
    this.view = new LyricsView(view);
    this.panel.body.append(this.view.el);
    this.panel.onOpenChange(onOpenChange);
  }

  get active(): boolean {
    return this.panel.isOpen;
  }

  render(state: LyricsState): void {
    show(this.view, state);
  }

  update(time: number): void {
    this.view.update(time);
  }
}

export const YTM_MOUNT_ATTR = 'data-allmixer-lyrics';
const YTM_STYLE_ID = 'all-mixer-ytm-lyrics-style';
const YTM_STYLE = `
[${YTM_MOUNT_ATTR}] > :not([data-am-lyrics]) { display: none !important; }
[${YTM_MOUNT_ATTR}] > [data-am-lyrics] { display: block; height: 100%; min-height: 360px; }
`;

/**
 * F1: synced lyrics inside YT Music's own Lyrics tab. Only takes over when we
 * have synced lyrics; otherwise YT Music's lyrics stay as they are (fallback).
 * An auto-generated transcript is worse than YT Music's own lyrics, so it stays in the floating panel.
 */
export class YtmTabSurface implements LyricsSurface {
  private readonly view: LyricsView;
  private state: LyricsState = { kind: 'idle' };

  constructor(
    view: LyricsViewOptions,
    private readonly doc: Document = document,
  ) {
    this.view = new LyricsView(view, doc);
    if (!doc.getElementById(YTM_STYLE_ID)) {
      const style = doc.createElement('style');
      style.id = YTM_STYLE_ID;
      style.textContent = YTM_STYLE;
      (doc.head ?? doc.documentElement).append(style);
    }
  }

  /** Load lyrics for every track: a disabled Lyrics tab can only be enabled once we know we have some. */
  readonly prefetch = true;

  get active(): boolean {
    const tab = findYtmLyricsTab(this.doc);
    return !!tab && isTabSelected(tab);
  }

  get mounted(): boolean {
    return this.view.el.isConnected;
  }

  render(state: LyricsState): void {
    this.state = state;
    if (state.kind === 'ready') this.view.setLyrics(state.lyrics, state.captions);
    this.sync();
  }

  update(time: number): void {
    if (this.mounted) this.view.update(time);
  }

  /** Mount or unmount to match the tab selection and the lyrics state. Call on tab / DOM changes. */
  sync(): void {
    const s = this.state;
    const synced = s.kind === 'ready' && s.lyrics.kind === 'synced' && s.lyrics.source !== 'youtube-auto-captions';
    const tab = findYtmLyricsTab(this.doc);
    const content = findYtmTabContent(this.doc);
    if (synced && tab) enableTab(tab);

    if (synced && tab && content && isTabSelected(tab)) {
      if (this.view.el.parentNode !== content) {
        content.append(this.view.el);
        // Reset the highlight so the next update scrolls to the current line.
        this.view.setLyrics(s.lyrics, s.captions);
      }
      content.setAttribute(YTM_MOUNT_ATTR, '');
    } else {
      this.view.el.remove();
      for (const el of this.doc.querySelectorAll(`[${YTM_MOUNT_ATTR}]`)) el.removeAttribute(YTM_MOUNT_ATTR);
    }
  }
}
