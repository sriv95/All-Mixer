import { findTimeElements, isSeekDragging, type Site, type TimeElements } from './youtube-dom';

/** A bigger gap between currentTime and the presented time is a seek in flight, not the picture delay. */
const MAX_SHIFT_S = 10;

/** On an ended video, a presented time this close to the end counts as the end. */
const END_SNAP_S = 0.5;

const SCALE_RE = /^scaleX\(([\d.e-]+)\)$/;

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
 */
export class TimeDisplay {
  /** Per element: the value YouTube wrote, and what we turned it into. */
  private readonly memo = new WeakMap<Element, { raw: number; out: string }>();
  private readonly observer = new MutationObserver(() => this.update());
  private raf = 0;
  /** The player's elements, found once: the seek bar is looked up again only when YouTube re-creates one of them. */
  private els: TimeElements | null = null;

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
    const dur = this.video.duration;
    let p = this.presentedTime();
    // The last frame sits a few ms short of the end: the readout would stop on 0:18 of 0:19 with the bar full.
    if (p !== null && this.video.ended && dur - p < END_SNAP_S) p = dur;
    const shift = this.video.currentTime - (p ?? NaN);
    if (p === null || !(dur > 0) || !(shift >= -0.05 && shift <= MAX_SHIFT_S)) return;
    // While the user drags the bar it shows the dragged position, which is where they point, not what plays.
    if (isSeekDragging(this.site)) return;
    const { text, fills, knob, bar } = this.elements();
    const frac = Math.max(0, shift) / dur;

    if (text) {
      const now = text.textContent ?? '';
      const next = now.replace(/^(\s*)[\d:]+/, (_, lead: string) => lead + formatTime(Math.min(p, dur)));
      if (next !== now) text.textContent = next;
    }
    this.shiftFills(fills, frac);
    if (knob) {
      if (this.site === 'youtube') {
        const barW = bar?.clientWidth || 0;
        this.put(knob, 'transform', /^translateX\(([\d.e-]+)px\)$/, (x) => `translateX(${Math.max(0, x - frac * barW)}px)`);
      } else {
        this.put(knob, 'left', /^([\d.e-]+)%$/, (x) => `${Math.max(0, x - frac * 100)}%`);
      }
    }
    if (bar) {
      this.setAria(bar, Math.min(p, dur));
    }
    this.observer.takeRecords(); // our own writes
  }

  /** The cached elements while all are still in the page, else a fresh lookup (watched again; gone nodes drop out by themselves). */
  private elements(): TimeElements {
    const e = this.els;
    if (e?.text?.isConnected && e.knob?.isConnected && e.bar?.isConnected && e.fills.length && e.fills.every((f) => f.isConnected)) return e;
    const found = findTimeElements(this.site);
    const watch = (el: HTMLElement | null, opts: MutationObserverInit) => el && this.observer.observe(el, opts);
    watch(found.text, { childList: true, characterData: true, subtree: true });
    watch(found.knob, { attributes: true, attributeFilter: ['style'] });
    watch(found.bar, { attributes: true, attributeFilter: ['aria-valuenow', 'aria-valuetext'] });
    for (const f of found.fills) watch(f, { attributes: true, attributeFilter: ['style'] });
    return (this.els = found);
  }

  /**
   * The fills are the played part of the bar: one, or one per chapter (each spans its chapter). The played share of the
   * whole bar moves back by `frac` and is spread over the chapters again, so the boundary between two chapters works.
   */
  private shiftFills(fills: HTMLElement[], frac: number): void {
    const parts: { el: HTMLElement; raw: number; w: number }[] = [];
    for (const el of fills) {
      const raw = this.raw(el, 'transform', SCALE_RE);
      if (raw !== null) parts.push({ el, raw, w: this.site === 'youtube' ? el.offsetWidth || 1 : 1 });
    }
    const total = parts.reduce((a, q) => a + q.w, 0);
    let left = Math.max(0, parts.reduce((a, q) => a + q.raw * q.w, 0) / total - frac); // played share still to place
    for (const q of parts) {
      const share = q.w / total;
      const x = Math.min(1, left / share);
      left = Math.max(0, left - share);
      this.write(q.el, 'transform', q.raw, `scaleX(${x})`);
    }
  }

  /** Screen readers: the bar's value is the presented time too (the long text only where it is in English). */
  private setAria(bar: HTMLElement, p: number): void {
    const s = Math.floor(p);
    if (bar.getAttribute('aria-valuenow') !== String(s)) bar.setAttribute('aria-valuenow', String(s));
    const now = bar.getAttribute('aria-valuetext') ?? '';
    const next = now.replace(/^(?:\d+ Hours? )?(?:\d+ Minutes? )?\d+ Seconds?(?= of )/, () => {
      const h = Math.floor(s / 3600);
      return `${h ? `${h} Hours ` : ''}${Math.floor(s / 60) % 60} Minutes ${s % 60} Seconds`;
    });
    if (next !== now) bar.setAttribute('aria-valuetext', next);
  }

  /** YouTube's value of `prop` on `el`: our memo while YouTube wrote nothing new, else parsed from the element. */
  private raw(el: HTMLElement, prop: 'transform' | 'left', re: RegExp): number | null {
    const memo = this.memo.get(el);
    const now = el.style[prop];
    if (memo !== undefined && now === memo.out) return memo.raw;
    const m = re.exec(now);
    return m ? parseFloat(m[1]) : null;
  }

  private write(el: HTMLElement, prop: 'transform' | 'left', raw: number, out: string): void {
    if (el.style[prop] !== out) el.style[prop] = out;
    this.memo.set(el, { raw, out: el.style[prop] });
  }

  /** Rewrite `prop` from YouTube's raw value. */
  private put(el: HTMLElement, prop: 'transform' | 'left', re: RegExp, next: (n: number) => string): void {
    const raw = this.raw(el, prop, re);
    if (raw !== null) this.write(el, prop, raw, next(raw));
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
  }
}
