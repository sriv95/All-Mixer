import { findTimeElements, type Site } from './youtube-dom';

/** A bigger gap between currentTime and the presented time is a seek in flight, not the picture delay. */
const MAX_SHIFT_S = 10;

const pad = (n: number) => String(n).padStart(2, '0');

export function formatTime(sec: number): string {
  const s = Math.floor(Math.max(0, sec));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/**
 * Makes the player's time readout and seek bar show the presented time (what
 * the user sees and hears) instead of video.currentTime, which leads it by
 * the picture delay in Separate mode.
 *
 * YouTube keeps writing the raw values, so a MutationObserver shifts each one
 * right after it is written (before paint). YouTube's raw value is kept, so
 * the shift is recomputed from it (never applied twice) while YouTube writes
 * nothing, e.g. when the video has ended but the delayed tail still plays.
 *
 * shortcut: with chapters, the bar stays at the old chapter's end for the
 * first delay seconds of a new chapter; fix by moving the fill between chapters.
 */
export class TimeDisplay {
  /** Per element: the value YouTube wrote, and what we turned it into. */
  private readonly memo = new WeakMap<Element, { raw: number; out: string }>();
  private readonly observer = new MutationObserver(() => this.update());
  private raf = 0;

  constructor(
    private readonly site: Site,
    private readonly video: HTMLVideoElement,
    private readonly presentedTime: () => number | null,
  ) {
    const loop = () => {
      this.update();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  update(): void {
    const p = this.presentedTime();
    const dur = this.video.duration;
    const shift = this.video.currentTime - (p ?? NaN);
    if (p === null || !(dur > 0) || !(shift >= -0.05 && shift <= MAX_SHIFT_S)) return;
    const frac = Math.max(0, shift) / dur;
    const { text, fills, knob, bar } = findTimeElements(this.site);
    const barW = bar?.clientWidth || 0;
    const watch = (el: HTMLElement, opts: MutationObserverInit) => this.observer.observe(el, opts);

    if (text) {
      watch(text, { childList: true, characterData: true, subtree: true });
      const now = text.textContent ?? '';
      const next = now.replace(/^(\s*)[\d:]+/, (_, lead: string) => lead + formatTime(Math.min(p, dur)));
      if (next !== now) text.textContent = next;
    }
    for (const el of fills) {
      watch(el, { attributes: true, attributeFilter: ['style'] });
      this.shift(el, 'transform', /^scaleX\(([\d.e-]+)\)$/, (x) => {
        // Chapters: this fill spans only its chapter, so the same seconds are a bigger fraction of it.
        const w = el.offsetWidth;
        return `scaleX(${Math.max(0, x - (this.site === 'youtube' && w > 0 && barW > 0 ? (frac * barW) / w : frac))})`;
      });
    }
    if (knob) {
      watch(knob, { attributes: true, attributeFilter: ['style'] });
      if (this.site === 'youtube') {
        this.shift(knob, 'transform', /^translateX\(([\d.e-]+)px\)$/, (x) => `translateX(${Math.max(0, x - frac * barW)}px)`);
      } else {
        this.shift(knob, 'left', /^([\d.e-]+)%$/, (x) => `${Math.max(0, x - frac * 100)}%`);
      }
    }
    this.observer.takeRecords(); // our own writes
  }

  /** Rewrite `prop` from YouTube's raw value, which is parsed again only when YouTube wrote a new one. */
  private shift(el: HTMLElement, prop: 'transform' | 'left', re: RegExp, next: (n: number) => string): void {
    const now = el.style[prop];
    const memo = this.memo.get(el);
    let raw = memo?.raw;
    if (memo === undefined || now !== memo.out) {
      const m = re.exec(now);
      if (!m) return;
      raw = parseFloat(m[1]);
    }
    const out = next(raw!);
    if (out !== now) el.style[prop] = out;
    this.memo.set(el, { raw: raw!, out: el.style[prop] });
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
  }
}
