import { findLineIndex, findWordIndex } from '../../lyrics/sync';
import type { Lyrics, SyncedLyrics } from '../../lyrics/types';

export type LyricsViewStatus = 'loading' | 'not-found' | 'error';

export interface LyricsViewOptions {
  onSeek: (time: number) => void;
}

const USER_SCROLL_PAUSE_MS = 4000;
const CURRENT_LINE_POSITION = 0.35;

const DEFAULT_MESSAGES: Record<LyricsViewStatus, string> = {
  loading: 'Loading lyrics…',
  'not-found': 'No lyrics found for this track.',
  error: 'Could not load lyrics.',
};

const STYLE = `
:host { display: block; width: 100%; height: 100%; box-sizing: border-box; color: #fff; font: 16px/1.4 Roboto, Arial, sans-serif; }
.wrap { display: flex; flex-direction: column; width: 100%; height: 100%; }
.scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 35% 12px 40%; position: relative; }
.line { padding: 6px 4px; opacity: 0.55; cursor: pointer; border-radius: 4px; transition: opacity 0.2s; }
.line:focus-visible { outline: 1px solid rgba(255,255,255,0.6); }
.line.current { opacity: 1; font-weight: 700; font-size: 1.15em; }
.word.sung { color: #ffd54f; }
.plain { white-space: pre-wrap; opacity: 0.85; margin: 0; padding: 0 4px; }
.status { display: flex; align-items: center; justify-content: center; height: 100%; text-align: center; opacity: 0.7; padding: 12px; box-sizing: border-box; }
.footer { flex: none; font-size: 11px; opacity: 0.5; text-align: center; padding: 4px; }
`;

export class LyricsView {
  readonly el: HTMLElement;
  private readonly doc: Document;
  private readonly root: ShadowRoot;
  private readonly scroller: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly onSeek: (time: number) => void;

  private lyrics: SyncedLyrics | null = null;
  private lineEls: HTMLElement[] = [];
  private wordEls: HTMLElement[][] = [];
  private lineIdx = -1;
  private wordIdx = -1;
  private pausedUntil = 0;
  private destroyed = false;

  constructor(opts: LyricsViewOptions, doc: Document = document) {
    this.doc = doc;
    this.onSeek = opts.onSeek;
    this.el = doc.createElement('div');
    this.el.setAttribute('data-am-lyrics', '');
    this.root = this.el.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = STYLE;
    const wrap = doc.createElement('div');
    wrap.className = 'wrap';
    this.scroller = doc.createElement('div');
    this.scroller.className = 'scroll';
    this.footer = doc.createElement('div');
    this.footer.className = 'footer';
    wrap.append(this.scroller, this.footer);
    this.root.append(style, wrap);

    this.scroller.addEventListener('click', this.onClick);
    this.scroller.addEventListener('keydown', this.onKeyDown);
    this.scroller.addEventListener('wheel', this.onUserScroll, { passive: true });
    this.scroller.addEventListener('touchmove', this.onUserScroll, { passive: true });
    this.scroller.addEventListener('pointerdown', this.onPointerDown);
  }

  setLyrics(lyrics: Lyrics): void {
    this.reset();
    if (lyrics.kind === 'plain') {
      const p = this.doc.createElement('p');
      p.className = 'plain';
      p.textContent = lyrics.text;
      this.scroller.replaceChildren(p);
      this.footer.textContent = 'Lyrics: LRCLIB';
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
    this.footer.textContent =
      lyrics.offset !== 0 ? 'Lyrics: LRCLIB · timing aligned to captions' : 'Lyrics: LRCLIB';
  }

  setStatus(status: LyricsViewStatus, message?: string): void {
    this.reset();
    const div = this.doc.createElement('div');
    div.className = 'status';
    div.dataset.status = status;
    div.textContent = message ?? DEFAULT_MESSAGES[status];
    this.scroller.replaceChildren(div);
    this.footer.textContent = '';
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
    this.scroller.removeEventListener('wheel', this.onUserScroll);
    this.scroller.removeEventListener('touchmove', this.onUserScroll);
    this.scroller.removeEventListener('pointerdown', this.onPointerDown);
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
    if (this.doc.defaultView && Date.now() < this.pausedUntil) return;
    const el = this.lineEls[index];
    const sc = this.scroller;
    const top = el.offsetTop - sc.clientHeight * CURRENT_LINE_POSITION + el.offsetHeight / 2;
    sc.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  private readonly onUserScroll = (): void => {
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

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const i = this.lineFromEvent(e);
    if (i < 0) return;
    e.preventDefault();
    this.seekTo(i);
  };

  private seekTo(i: number): void {
    const line = this.lyrics?.lines[i];
    if (line) this.onSeek(line.start);
  }
}
