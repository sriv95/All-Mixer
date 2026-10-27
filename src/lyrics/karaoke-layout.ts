import type { KaraokeFont } from '../shared/lyrics-prefs';

// Karaoke text layout shared by the on-page overlay, the popup preview and the export renderer.

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

export const FONT_FAMILIES: Record<KaraokeFont, string> = {
  default: '"YouTube Noto",Roboto,Arial,sans-serif',
  sans: 'system-ui,"Segoe UI",Helvetica,Arial,sans-serif',
  serif: 'Georgia,"Times New Roman",serif',
  mono: 'ui-monospace,Menlo,Consolas,monospace',
};
