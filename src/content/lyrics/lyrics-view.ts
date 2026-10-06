import { findLineIndex, findWordIndex } from '../../lyrics/sync';
import type { Lyrics, LyricsSource, SyncedLyrics } from '../../lyrics/types';
import type { CaptionPicker, SourceMenu, SourcePref } from './controller';
import type { CaptionPick } from './track-info';

export type LyricsViewStatus = 'loading' | 'not-found' | 'error';

export interface LyricsViewOptions {
  onSeek: (time: number) => void;
  /** The user picked another caption track or an auto-translation in the language menu. */
  onCaptionTrack?: (pick: CaptionPick) => void;
  /** The user picked a lyrics source in the source menu. */
  onSource?: (pref: SourcePref) => void;
  /** Floating panel mode: text scales with width, the current line stays centered until the user unlocks it. */
  panel?: boolean;
}

const USER_SCROLL_PAUSE_MS = 4000;
const CURRENT_LINE_POSITION = 0.35;
const PANEL_LINE_POSITION = 0.5;

const DEFAULT_MESSAGES: Record<LyricsViewStatus, string> = {
  loading: 'Loading lyrics…',
  'not-found': 'No lyrics found for this track.',
  error: 'Could not load lyrics.',
};

const SOURCE_LABELS: Record<LyricsSource, string> = {
  lrclib: 'LRCLIB',
  'youtube-captions': 'YouTube captions',
  'youtube-auto-captions': 'YouTube auto-generated captions',
};

const FALLBACK_NOTES = {
  lrclib: 'LRCLIB: not found, using the automatic order',
  captions: 'YouTube captions: none, using the automatic order',
};

/** Arrow keys and letters pick options; they must not reach the YouTube player. */
function guardKeys(el: HTMLElement): void {
  for (const ev of ['keydown', 'keyup', 'keypress']) el.addEventListener(ev, (e) => e.stopPropagation());
}

/** Keys that scroll the focused container; pressing them counts as a user scroll. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);
// Keys the panel owns while focused: YouTube acts on Space keyup and Left/Right, so keyup/keypress are stopped too.
const GUARDED_KEYS = new Set([...SCROLL_KEYS, 'ArrowLeft', 'ArrowRight', ' ', 'Enter']);

const STYLE = `
:host { display: block; width: 100%; height: 100%; box-sizing: border-box; color: #fff; font: 16px/1.4 Roboto, Arial, sans-serif; }
.wrap { display: flex; flex-direction: column; width: 100%; height: 100%; }
.scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 35% 12px 40%; position: relative; }
.line { padding: 6px 4px; opacity: 0.55; cursor: pointer; border-radius: 4px; transition: opacity 0.2s; }
.line:focus-visible { outline: 1px solid rgba(255,255,255,0.6); }
.line.current { opacity: 1; font-weight: 700; font-size: 1.15em; }
.word.sung { color: #ffd54f; }
.plain { white-space: pre-wrap; opacity: 0.85; margin: 0; padding: 0 4px; }
.status { display: flex; align-items: safe center; justify-content: safe center; height: 100%; text-align: center; opacity: 0.7; padding: 12px; box-sizing: border-box; }
.footer { flex: none; font-size: 11px; text-align: center; padding: 4px; }
.panel { container-type: inline-size; }
.panel .scroll { padding: 0 12px; font-size: clamp(16px, 4.7cqw, 40px); }
.panel .scroll.synced { padding-block: 0; }
.panel .scroll.synced::before, .panel .scroll.synced::after { content: ''; display: block; height: 50%; }
.panel .line, .panel .plain { text-align: center; }
.lock { margin-left: 6px; font: inherit; color: #fff; background: #222; border: 1px solid rgba(255,255,255,0.3); border-radius: 4px; cursor: pointer; }
.lock[aria-pressed="true"] { background: #3a3a3a; }
.source { opacity: 0.5; }
.lang, .src { margin-left: 6px; max-width: 60%; font: inherit; color: #fff; background: #222; border: 1px solid rgba(255,255,255,0.3); border-radius: 4px; }
`;

export class LyricsView {
  readonly el: HTMLElement;
  private readonly doc: Document;
  private readonly root: ShadowRoot;
  private readonly scroller: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly onSeek: (time: number) => void;
  private readonly onCaptionTrack?: (pick: CaptionPick) => void;
  private readonly onSource?: (pref: SourcePref) => void;

  private lyrics: SyncedLyrics | null = null;
  private lineEls: HTMLElement[] = [];
  private wordEls: HTMLElement[][] = [];
  private lineIdx = -1;
  private wordIdx = -1;
  private pausedUntil = 0;
  private destroyed = false;
  private readonly panelMode: boolean;
  private locked = true;
  private resizeObserver: ResizeObserver | null = null;
  private recenterRaf = 0;
  private recenterTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: LyricsViewOptions, doc: Document = document) {
    this.doc = doc;
    this.onSeek = opts.onSeek;
    this.onCaptionTrack = opts.onCaptionTrack;
    this.onSource = opts.onSource;
    this.panelMode = opts.panel === true;
    this.el = doc.createElement('div');
    this.el.setAttribute('data-am-lyrics', '');
    this.root = this.el.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = STYLE;
    const wrap = doc.createElement('div');
    wrap.className = this.panelMode ? 'wrap panel' : 'wrap';
    this.scroller = doc.createElement('div');
    this.scroller.className = 'scroll';
    this.footer = doc.createElement('div');
    this.footer.className = 'footer';
    wrap.append(this.scroller, this.footer);
    this.root.append(style, wrap);

    this.scroller.addEventListener('click', this.onClick);
    this.scroller.addEventListener('keydown', this.onKeyDown);
    this.scroller.addEventListener('keyup', this.onKeyGuard);
    this.scroller.addEventListener('keypress', this.onKeyGuard);
    this.scroller.addEventListener('wheel', this.onUserScroll, { passive: true });
    this.scroller.addEventListener('touchmove', this.onUserScroll, { passive: true });
    this.scroller.addEventListener('pointerdown', this.onPointerDown);
    if (this.panelMode) {
      this.applyOverflow();
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(this.onResize);
        this.resizeObserver.observe(this.scroller);
        this.resizeObserver.observe(this.el);
      }
      this.doc.addEventListener('fullscreenchange', this.onFullscreenChange);
    }
  }

  /** `picker` adds a caption language menu to the footer (only with two or more options), `sources` the source menu. */
  setLyrics(lyrics: Lyrics, picker?: CaptionPicker, sources?: SourceMenu): void {
    this.reset();
    if (lyrics.kind === 'plain') {
      const p = this.doc.createElement('p');
      p.className = 'plain';
      p.textContent = lyrics.text;
      this.scroller.replaceChildren(p);
      this.updatePadding();
      this.setFooter(`Lyrics: ${SOURCE_LABELS[lyrics.source]}`, picker, sources);
      return;
    }
    this.lyrics = lyrics;
    const frag = this.doc.createDocumentFragment();
    lyrics.lines.forEach((line, i) => {
      const div = this.doc.createElement('div');
      div.className = 'line';
      div.dataset.index = String(i);
      div.tabIndex = 0;
      const words: HTMLElement[] = [];
      if (line.words && line.words.length > 0 && line.text.trim() !== '') {
        for (const w of line.words) {
          const span = this.doc.createElement('span');
          span.className = 'word';
          span.textContent = w.text;
          div.appendChild(span);
          words.push(span);
        }
      } else {
        div.textContent = line.text.trim() === '' ? '♪' : line.text;
      }
      this.wordEls.push(words);
      this.lineEls.push(div);
      frag.appendChild(div);
    });
    this.scroller.replaceChildren(frag);
    this.updatePadding();
    this.scheduleRecenter(false);
    this.setFooter(
      `Lyrics: ${SOURCE_LABELS[lyrics.source]}` + (lyrics.source === 'lrclib' && lyrics.offset !== 0 ? ' · timing aligned to captions' : ''),
      picker,
      sources,
    );
  }

  setStatus(status: LyricsViewStatus, message?: string): void {
    this.reset();
    const div = this.doc.createElement('div');
    div.className = 'status';
    div.dataset.status = status;
    div.textContent = message ?? DEFAULT_MESSAGES[status];
    this.scroller.replaceChildren(div);
    this.updatePadding();
    this.footer.replaceChildren();
  }

  private setFooter(text: string, picker?: CaptionPicker, sources?: SourceMenu): void {
    const src = this.doc.createElement('span');
    src.className = 'source';
    src.textContent = text + (sources?.fellBack ? ` · ${FALLBACK_NOTES[sources.fellBack]}` : '');
    this.footer.replaceChildren(src);
    if (this.panelMode && this.lyrics) this.footer.append(this.lockButton());
    if (sources && this.onSource) this.footer.append(this.sourceMenu(sources, this.onSource));
    const onPick = this.onCaptionTrack;
    if (!picker || picker.options.length < 2 || !onPick) return;
    const sel = this.doc.createElement('select');
    sel.className = 'lang';
    sel.title = 'Caption language';
    sel.setAttribute('aria-label', 'Caption language');
    let group: HTMLOptGroupElement | null = null;
    picker.options.forEach((o, i) => {
      const opt = this.doc.createElement('option');
      opt.value = String(i);
      opt.textContent = o.label;
      if (o.group === 'translate') {
        if (!group) {
          group = this.doc.createElement('optgroup');
          group.label = 'Auto-translate';
          sel.append(group);
        }
        group.append(opt);
      } else sel.append(opt);
    });
    sel.value = String(picker.options.findIndex((o) => o.index === picker.selected.index && o.tlang === picker.selected.tlang));
    sel.addEventListener('change', () => {
      const o = picker.options[Number(sel.value)];
      if (o) onPick({ index: o.index, ...(o.tlang ? { tlang: o.tlang } : {}) });
      // Hand focus back to the page so later keys (k, Space, arrows) reach YouTube, not the select.
      sel.blur();
    });
    guardKeys(sel);
    this.footer.append(sel);
  }

  private lockButton(): HTMLButtonElement {
    const btn = this.doc.createElement('button');
    btn.type = 'button';
    btn.className = 'lock';
    const paint = (): void => {
      btn.textContent = this.locked ? 'Centered' : 'Free scroll';
      btn.setAttribute('aria-pressed', String(this.locked));
      btn.title = this.locked
        ? 'The current line stays centered. Click to scroll freely.'
        : 'Scrolling is free. Click to center the current line again.';
    };
    paint();
    btn.addEventListener('click', () => {
      this.setLocked(!this.locked);
      paint();
    });
    guardKeys(btn);
    return btn;
  }

  private setLocked(locked: boolean): void {
    this.locked = locked;
    this.applyOverflow();
    if (locked) this.centerCurrent('auto');
  }

  /** Synced lyrics get half-height ::before/::after spacers (CSS, content-box percent) so the first and last lines reach the center without sizing from the scroller's own height. */
  private updatePadding(): void {
    if (!this.panelMode) return;
    const synced = this.lyrics !== null;
    this.scroller.classList.toggle('synced', synced);
    this.scroller.style.paddingBlock = synced ? '' : this.scroller.querySelector('.plain') ? '12px' : '';
    this.applyOverflow();
  }

  /** Only synced lyrics with the lock on are non-scrollable; plain text and status messages must stay readable. */
  private applyOverflow(): void {
    if (!this.panelMode) return;
    this.scroller.style.overflowY = this.lyrics && this.locked ? 'hidden' : 'auto';
  }

  private readonly onResize = (): void => {
    if (this.destroyed) return;
    if (this.locked) this.centerCurrent('auto');
  };

  private readonly onFullscreenChange = (): void => this.scheduleRecenter(true);

  /** Re-center once after layout (rAF) and, when `animated`, again after YouTube's theater/fullscreen transition. Skipped while the user has Free scroll. */
  private scheduleRecenter(animated: boolean): void {
    if (!this.panelMode || this.destroyed) return;
    this.cancelRecenter();
    const run = (): void => {
      if (!this.destroyed && this.locked) this.centerCurrent('auto');
    };
    this.recenterRaf = requestAnimationFrame(run);
    if (animated) this.recenterTimer = setTimeout(run, 250);
  }

  private cancelRecenter(): void {
    if (this.recenterRaf) cancelAnimationFrame(this.recenterRaf);
    if (this.recenterTimer !== null) clearTimeout(this.recenterTimer);
    this.recenterRaf = 0;
    this.recenterTimer = null;
  }

  private centerCurrent(behavior: ScrollBehavior): void {
    if (!this.lyrics) return;
    const sc = this.scroller;
    const el = this.lineEls[this.lineIdx];
    const top = el ? el.offsetTop - sc.clientHeight * PANEL_LINE_POSITION + el.offsetHeight / 2 : 0;
    sc.scrollTo({ top: Math.max(0, top), behavior });
  }

  private sourceMenu(sources: SourceMenu, onSource: (pref: SourcePref) => void): HTMLSelectElement {
    const sel = this.doc.createElement('select');
    sel.className = 'src';
    sel.title = 'Lyrics source';
    sel.setAttribute('aria-label', 'Lyrics source');
    const entries: [SourcePref, string, boolean, string][] = [
      ['auto', 'Auto', true, ''],
      ['lrclib', 'LRCLIB', sources.available.lrclib, ' (not found)'],
      ['captions', 'YouTube captions', sources.available.captions, ' (none)'],
    ];
    for (const [value, label, available, hint] of entries) {
      const opt = this.doc.createElement('option');
      opt.value = value;
      opt.textContent = available ? label : label + hint;
      opt.disabled = !available;
      opt.selected = value === sources.pref;
      sel.append(opt);
    }
    sel.addEventListener('change', () => {
      onSource(sel.value as SourcePref);
      sel.blur();
    });
    guardKeys(sel);
    return sel;
  }

  update(time: number): void {
    const lyrics = this.lyrics;
    if (!lyrics || this.destroyed) return;
    const li = findLineIndex(lyrics.lines, time);
    const wi = li >= 0 ? findWordIndex(lyrics.lines[li], time) : -1;
    const lineChanged = li !== this.lineIdx;
    if (!lineChanged && wi === this.wordIdx) return;

    if (lineChanged) {
      const prev = this.lineIdx;
      this.lineIdx = li;
      this.wordIdx = -1;
      this.applyLineClasses(prev, li);
    }
    this.applyWordClasses(li, wi);
    this.wordIdx = wi;
    if (lineChanged && li >= 0) this.autoScroll(li);
  }

  destroy(): void {
    this.destroyed = true;
    this.scroller.removeEventListener('click', this.onClick);
    this.scroller.removeEventListener('keydown', this.onKeyDown);
    this.scroller.removeEventListener('keyup', this.onKeyGuard);
    this.scroller.removeEventListener('keypress', this.onKeyGuard);
    this.scroller.removeEventListener('wheel', this.onUserScroll);
    this.scroller.removeEventListener('touchmove', this.onUserScroll);
    this.scroller.removeEventListener('pointerdown', this.onPointerDown);
    this.doc.removeEventListener('fullscreenchange', this.onFullscreenChange);
    this.cancelRecenter();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.el.remove();
  }

  private reset(): void {
    this.lyrics = null;
    this.lineEls = [];
    this.wordEls = [];
    this.lineIdx = -1;
    this.wordIdx = -1;
    this.pausedUntil = 0;
    this.scroller.scrollTop = 0;
  }

  /** Move current/past classes from the old line index to the new one, touching only changed lines. */
  private applyLineClasses(prev: number, next: number): void {
    const n = this.lineEls.length;
    if (prev >= 0 && prev < n) this.lineEls[prev].classList.remove('current');
    if (next > prev) {
      // Moving forward: lines (prev .. next-1] become past.
      for (let i = Math.max(prev, 0); i < next; i++) this.lineEls[i].classList.add('past');
    } else {
      // Seeking backwards: lines from next on are no longer past.
      for (let i = Math.max(next, 0); i < Math.min(prev + 1, n); i++) this.lineEls[i].classList.remove('past');
    }
    if (next >= 0) {
      this.lineEls[next].classList.remove('past');
      this.lineEls[next].classList.add('current');
    }
    // Words of the old line: clear sung state (it is past or about to be replayed).
    if (prev >= 0 && prev < n) this.setSung(prev, next > prev ? this.wordEls[prev].length - 1 : -1);
  }

  private applyWordClasses(line: number, wordIdx: number): void {
    if (line < 0) return;
    this.setSung(line, wordIdx);
  }

  private setSung(line: number, upTo: number): void {
    const words = this.wordEls[line];
    for (let i = 0; i < words.length; i++) words[i].classList.toggle('sung', i <= upTo);
  }

  private autoScroll(index: number): void {
    if (this.panelMode) {
      if (this.locked) this.centerCurrent('smooth');
      return;
    }
    if (Date.now() < this.pausedUntil) return;
    const el = this.lineEls[index];
    const sc = this.scroller;
    const top = el.offsetTop - sc.clientHeight * CURRENT_LINE_POSITION + el.offsetHeight / 2;
    sc.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  private readonly onUserScroll = (): void => {
    if (this.panelMode) return;
    this.pausedUntil = Date.now() + USER_SCROLL_PAUSE_MS;
  };

  /** A press on the scroller itself (not a line) is a scrollbar drag. */
  private readonly onPointerDown = (e: Event): void => {
    if (e.target === this.scroller) this.onUserScroll();
  };

  private lineFromEvent(e: Event): number {
    const line = (e.target as Element | null)?.closest?.('.line');
    if (!line) return -1;
    return Number((line as HTMLElement).dataset.index);
  }

  private readonly onClick = (e: Event): void => {
    this.seekTo(this.lineFromEvent(e));
  };

  private readonly onKeyGuard = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || !GUARDED_KEYS.has(e.key)) return;
    e.stopPropagation();
    if ((e.key === ' ' || e.key === 'Enter') && this.lineFromEvent(e) >= 0) e.preventDefault();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Keys we handle must not also reach YouTube's page shortcuts (Space = pause, arrows = seek).
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.stopPropagation();
      return;
    }
    if (SCROLL_KEYS.has(e.key)) {
      e.stopPropagation();
      this.onUserScroll();
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const i = this.lineFromEvent(e);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.seekTo(i);
  };

  private seekTo(i: number): void {
    const line = this.lyrics?.lines[i];
    if (line) this.onSeek(line.start);
  }
}
