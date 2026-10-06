import type { LyricLine } from '../../lyrics/types';
import { selectKaraokeLines, type KaraokeSlot } from '../../lyrics/karaoke-lines';
import type { LyricsPrefs } from '../../shared/lyrics-prefs';
import { findControlBar, findKaraokeHost, findPlayer, KARAOKE_MOUNT, isAdShowing, type Site } from '../youtube-dom';
import type { LyricsState, LyricsSurface } from './controller';

export interface Size {
  w: number;
  h: number;
}
export interface Pos {
  x: number;
  y: number;
}

/** Base font size: about 4% of the player height, kept in a readable range. */
export function karaokeFontPx(playerHeight: number, sizePercent: number): number {
  const base = Math.min(48, Math.max(12, playerHeight * 0.04));
  return Math.round(base * (sizePercent / 100) * 10) / 10;
}

/**
 * Keeps the whole text block inside the player and above the control bar.
 * `pos` and the result are fractions (0..1) of the player; x / y are the block's center.
 * `bottomInset` is the height in px covered by the control bar.
 */
export function clampKaraokePosition(pos: Pos, block: Size, player: Size, bottomInset: number): Pos {
  if (player.w <= 0 || player.h <= 0) return pos;
  const fit = (center: number, size: number, min: number, max: number) =>
    max - min < size ? (min + max) / 2 : Math.min(max - size / 2, Math.max(min + size / 2, center));
  const cx = fit(pos.x * player.w, block.w, 0, player.w);
  const cy = fit(pos.y * player.h, block.h, 0, player.h - Math.max(0, bottomInset));
  return { x: cx / player.w, y: cy / player.h };
}

const ROOT_ID = 'all-mixer-karaoke';
const STYLE = `
#${ROOT_ID} { position:absolute; inset:0; z-index:10; pointer-events:none; overflow:hidden; }
#${ROOT_ID} .am-k-block { position:absolute; transform:translate(-50%,-50%); width:max-content; max-width:90%; text-align:center; color:#fff;
  font-family:"YouTube Noto",Roboto,Arial,sans-serif; font-weight:500; line-height:1.3; cursor:grab; user-select:none; touch-action:none;
  pointer-events:auto; text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,0 0 6px rgba(0,0,0,.8); }
#${ROOT_ID}.am-ad .am-k-block { display:none !important; }
#${ROOT_ID} .am-k-block.dragging { cursor:grabbing; }
#${ROOT_ID} .am-k-line { display:block; }
#${ROOT_ID} .am-k-line.upcoming { opacity:.6; }
#${ROOT_ID} .am-k-word.sung { color:#ffd54f; }
`;

export interface KaraokeOptions {
  site: Site;
  getPrefs(): LyricsPrefs;
  /** Called once when a drag ends, with the clamped position. */
  onPosition(pos: Pos): void;
}

/** Karaoke text on the video: one block inside the player, driven by the controller's clock. */
export class KaraokeSurface implements LyricsSurface {
  private readonly root: HTMLElement;
  private readonly block: HTMLElement;
  private player: HTMLElement | null = null;
  private resizeObs: ResizeObserver | null = null;
  private lines: LyricLine[] | null = null;
  private key: string | null = null;
  private lastTime = 0;
  private sungEls: HTMLElement[][] = [];
  private sungCount = -1;
  private pos: Pos;
  private dragging: { pointerId: number; dx: number; dy: number } | null = null;

  constructor(
    private readonly opts: KaraokeOptions,
    private readonly doc: Document = document,
  ) {
    this.pos = opts.getPrefs().karaokePosition;
    this.root = doc.createElement('div');
    this.root.id = ROOT_ID;
    const style = doc.createElement('style');
    style.textContent = STYLE;
    this.block = doc.createElement('div');
    this.block.className = 'am-k-block';
    this.block.style.display = 'none';
    this.root.append(style, this.block);
    for (const ev of ['click', 'dblclick', 'mousedown', 'keydown', 'keyup'] as const) {
      this.block.addEventListener(ev, (e) => e.stopPropagation());
    }
    this.block.addEventListener('pointerdown', this.onDown);
    this.block.addEventListener('pointermove', this.onMove);
    this.block.addEventListener('pointerup', this.onUp);
    this.block.addEventListener('pointercancel', this.onUp);
    doc.addEventListener('fullscreenchange', this.layout);
  }

  get active(): boolean {
    return this.opts.getPrefs().lyricsDisplayMode === 'karaoke' && !!findPlayer(this.opts.site, this.doc);
  }

  render(state: LyricsState): void {
    const lyrics = state.kind === 'ready' && state.lyrics.kind === 'synced' ? state.lyrics : null;
    this.lines = lyrics ? lyrics.lines : null;
    this.key = null;
    this.update(this.lastTime);
  }

  update(time: number): void {
    this.lastTime = time;
    if (!this.sync()) return;
    const prefs = this.opts.getPrefs();
    const slots = this.lines ? selectKaraokeLines(this.lines, time, prefs.karaokeLines).slots : [];
    const key = slots.map((s) => `${s.index}|${s.state}|${s.text}`).join('\n');
    if (key !== this.key) {
      this.key = key;
      this.build(slots);
      this.layout();
    }
    this.markSung(time);
  }

  /** Mounts into the current player (it may have been re-created) or unmounts when inactive. Returns whether it is mounted. */
  sync(): boolean {
    const player = this.active ? findPlayer(this.opts.site, this.doc) : null;
    if (!player) {
      this.root.remove();
      this.observe(null);
      return false;
    }
    const host = findKaraokeHost(this.opts.site, player);
    if (this.root.parentNode !== host) {
      this.root.style.zIndex = String(KARAOKE_MOUNT[this.opts.site].zIndex);
      host.append(this.root);
      this.layout();
    }
    this.observe(player);
    this.root.classList.toggle('am-ad', isAdShowing(player));
    return true;
  }

  /** Prefs changed (font size, line count, position, mode). */
  refreshPrefs(): void {
    this.pos = this.opts.getPrefs().karaokePosition;
    this.key = null;
    this.update(this.lastTime);
    this.layout();
  }

  destroy(): void {
    this.observe(null);
    this.root.remove();
    this.doc.removeEventListener('fullscreenchange', this.layout);
  }

  private observe(player: HTMLElement | null): void {
    if (player === this.player) return;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.player = player;
    if (player && typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.layout());
      this.resizeObs.observe(player);
    }
  }

  private build(slots: KaraokeSlot[]): void {
    this.block.replaceChildren();
    this.sungEls = [];
    this.sungCount = -1;
    slots.forEach((slot, i) => {
      const el = this.doc.createElement('span');
      el.className = `am-k-line ${slot.state}`;
      const words = slot.state === 'current' ? this.lines?.[slot.index]?.words : undefined;
      const els: HTMLElement[] = [];
      if (words && words.length > 0) {
        for (const w of words) {
          const span = this.doc.createElement('span');
          span.className = 'am-k-word';
          span.textContent = w.text;
          el.append(span);
          els.push(span);
        }
      } else {
        el.textContent = slot.text;
      }
      this.sungEls[i] = els;
      this.block.append(el);
    });
    this.block.style.display = slots.length > 0 ? '' : 'none';
  }

  private markSung(time: number): void {
    const slot = this.key ? this.key.split('\n')[0] : undefined;
    const idx = slot ? Number(slot.split('|')[0]) : -1;
    const words = this.lines?.[idx]?.words;
    const els = this.sungEls[0];
    if (!words || !els || els.length !== words.length) return;
    let n = 0;
    while (n < words.length && words[n].start <= time) n++;
    if (n === this.sungCount) return;
    this.sungCount = n;
    els.forEach((el, i) => el.classList.toggle('sung', i < n));
  }

  private playerSize(): Size {
    const r = this.player?.getBoundingClientRect();
    return { w: r?.width ?? 0, h: r?.height ?? 0 };
  }

  private bottomInset(): number {
    if (!this.player) return 0;
    const bar = findControlBar(this.opts.site, this.player);
    if (!bar) return 0;
    const b = bar.getBoundingClientRect();
    if (b.height <= 0) return 0;
    return Math.max(0, this.player.getBoundingClientRect().bottom - b.top);
  }

  /** Font size and position from the current player size. Arrow: also used as an event listener. */
  private readonly layout = (): void => {
    if (!this.player) return;
    const player = this.playerSize();
    if (player.w <= 0 || player.h <= 0) return;
    this.fitRoot();
    this.block.style.fontSize = `${karaokeFontPx(player.h, this.opts.getPrefs().karaokeFontSize)}px`;
    this.place(this.pos);
  };

  /** When mounted outside the player, cover exactly the player rect. */
  private fitRoot(): void {
    const s = this.root.style;
    if (!this.player || this.root.parentNode === this.player) {
      s.left = s.top = s.width = s.height = '';
      return;
    }
    const p = this.player.getBoundingClientRect();
    s.inset = 'auto';
    s.left = '0px';
    s.top = '0px';
    s.width = `${p.width}px`;
    s.height = `${p.height}px`;
    const r = this.root.getBoundingClientRect();
    s.left = `${p.left - r.left}px`;
    s.top = `${p.top - r.top}px`;
  }

  /** Clamps and applies a position; returns the clamped fractions. */
  private place(pos: Pos): Pos {
    const player = this.playerSize();
    const rect = this.block.getBoundingClientRect();
    const clamped = clampKaraokePosition(pos, { w: rect.width, h: rect.height }, player, this.bottomInset());
    this.block.style.left = `${clamped.x * 100}%`;
    this.block.style.top = `${clamped.y * 100}%`;
    return clamped;
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (e.button > 0 || !this.player) return;
    e.stopPropagation();
    e.preventDefault();
    const rect = this.block.getBoundingClientRect();
    this.dragging = {
      pointerId: e.pointerId,
      dx: e.clientX - (rect.left + rect.width / 2),
      dy: e.clientY - (rect.top + rect.height / 2),
    };
    this.block.setPointerCapture?.(e.pointerId);
    this.block.classList.add('dragging');
  };

  private readonly onMove = (e: PointerEvent): void => {
    const d = this.dragging;
    if (!d || e.pointerId !== d.pointerId || !this.player) return;
    e.stopPropagation();
    const p = this.player.getBoundingClientRect();
    if (p.width <= 0 || p.height <= 0) return;
    this.pos = this.place({ x: (e.clientX - d.dx - p.left) / p.width, y: (e.clientY - d.dy - p.top) / p.height });
  };

  private readonly onUp = (e: PointerEvent): void => {
    const d = this.dragging;
    if (!d || e.pointerId !== d.pointerId) return;
    e.stopPropagation();
    this.dragging = null;
    this.block.classList.remove('dragging');
    this.block.releasePointerCapture?.(e.pointerId);
    this.opts.onPosition(this.pos);
  };
}
