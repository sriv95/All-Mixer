import { FONT_FAMILIES, clampKaraokePosition, karaokeFontPx } from '../lyrics/karaoke-layout';
import { selectKaraokeLines, type KaraokeSlot } from '../lyrics/karaoke-lines';
import type { LyricLine } from '../lyrics/types';
import type { ExportText } from '../shared/export';
import type { KaraokeOutline } from '../shared/lyrics-prefs';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The rows of the text block at time `t`: one per row, null for a row that is empty (2-line mode keeps both rows). */
export function karaokeRows(lines: readonly LyricLine[] | null, t: number, count: 1 | 2): (KaraokeSlot | null)[] {
  const slots = lines ? selectKaraokeLines(lines, t, count).slots : [];
  const rows: (KaraokeSlot | null)[] = count === 2 && slots.length > 0 ? [null, null] : [];
  for (const slot of slots) rows[slot.row] = slot;
  return rows;
}

/** Stroke width (px at 720p) and glow blur / alpha per outline step: the canvas version of the overlay's text-shadows. */
const OUTLINE: Record<KaraokeOutline, { stroke: number; glow: number; glowAlpha: number }> = {
  none: { stroke: 0, glow: 0, glowAlpha: 0 },
  thin: { stroke: 1, glow: 0, glowAlpha: 0 },
  normal: { stroke: 2, glow: 6, glowAlpha: 0.8 },
  thick: { stroke: 4, glow: 8, glowAlpha: 0.9 },
};
const LINE_HEIGHT = 1.3;
/** The overlay's block is at most 90 % of the player wide. */
const MAX_WIDTH = 0.9;

/** Words that fit `maxW`; a word wider than that is broken by characters (text without spaces). */
function wrap(ctx: Ctx2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/(\s+)/)) {
    const next = line + word;
    if (!line || ctx.measureText(next.trimEnd()).width <= maxW) {
      line = next;
      continue;
    }
    out.push(line.trimEnd());
    line = word.trimStart();
  }
  if (line) out.push(line.trimEnd());
  // Single words that are still too wide.
  return out.flatMap((l) => {
    if (ctx.measureText(l).width <= maxW || [...l].length < 2) return [l];
    const parts: string[] = [];
    let cur = '';
    for (const ch of l) {
      if (cur && ctx.measureText(cur + ch).width > maxW) {
        parts.push(cur);
        cur = '';
      }
      cur += ch;
    }
    return cur ? [...parts, cur] : parts;
  });
}

/**
 * Draws the karaoke text block over a picture of `w` × `h`, laid out like the on-page overlay (src/content/lyrics/karaoke-overlay.ts):
 * font size from the picture height, rows of 1.3 em, the block centred on the position and kept inside the picture,
 * an optional dark box, the outline as a stroke.
 */
export function drawKaraoke(ctx: Ctx2D, w: number, h: number, rows: readonly (KaraokeSlot | null)[], style: ExportText): void {
  if (!rows.some((r) => r && r.text.trim())) return;
  const px = karaokeFontPx(h, style.karaokeFontSize);
  const scale = h / 720;
  const bg = style.karaokeBackground / 100;
  const padX = bg ? 0.5 * px : 0, padY = bg ? 0.15 * px : 0;
  ctx.save();
  ctx.font = `500 ${px}px ${FONT_FAMILIES[style.karaokeFont]}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const maxW = MAX_WIDTH * w - 2 * padX;
  const lines = rows.flatMap((row) => (row ? wrap(ctx, row.text, maxW).map((text) => ({ text, alpha: row.state === 'upcoming' ? 0.6 : 1 })) : [{ text: '', alpha: 1 }]));
  const lineH = px * LINE_HEIGHT;
  const blockW = Math.min(MAX_WIDTH * w, Math.max(0, ...lines.map((l) => ctx.measureText(l.text).width)) + 2 * padX);
  const blockH = lines.length * lineH + 2 * padY;
  const at = clampKaraokePosition(style.karaokePosition, { w: blockW, h: blockH }, { w, h }, 0);
  const left = at.x * w - blockW / 2, top = at.y * h - blockH / 2;
  if (bg) {
    ctx.fillStyle = `rgba(0,0,0,${bg})`;
    ctx.beginPath();
    ctx.roundRect(left, top, blockW, blockH, 0.3 * px);
    ctx.fill();
  }
  const o = OUTLINE[style.karaokeOutline];
  lines.forEach((l, i) => {
    if (!l.text) return;
    const x = at.x * w, y = top + padY + (i + 0.5) * lineH;
    ctx.globalAlpha = l.alpha;
    if (o.stroke) {
      ctx.strokeStyle = '#000';
      ctx.lineWidth = o.stroke * scale;
      ctx.shadowColor = `rgba(0,0,0,${o.glowAlpha})`;
      ctx.shadowBlur = o.glow * scale;
      ctx.strokeText(l.text, x, y);
      ctx.shadowBlur = 0;
    }
    ctx.fillStyle = style.karaokeColor;
    ctx.fillText(l.text, x, y);
  });
  ctx.restore();
}
