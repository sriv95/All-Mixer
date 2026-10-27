import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRICS_PREFS } from '../shared/lyrics-prefs';
import { textFromPrefs, type ExportText } from '../shared/export';
import type { LyricLine } from '../lyrics/types';
import { drawKaraoke, karaokeRows, type Ctx2D } from './karaoke-render';

const lines: LyricLine[] = [
  { start: 0, end: 5, text: 'first line' },
  { start: 5, end: 10, text: 'second line' },
  { start: 10, end: 15, text: 'third line' },
];

/** Records the calls of a 2D context; every character is 10 px wide. */
function recorder() {
  const calls: { fn: string; args: unknown[]; font?: string; fill?: unknown; alpha?: number; width?: number }[] = [];
  const state: Record<string, unknown> = { font: '', fillStyle: '', globalAlpha: 1, lineWidth: 1 };
  const ctx = new Proxy(state, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s: string) => ({ width: s.length * 10 });
      return (...args: unknown[]) => void calls.push({ fn: k, args, font: t.font as string, fill: t.fillStyle, alpha: t.globalAlpha as number, width: t.lineWidth as number });
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  }) as unknown as Ctx2D;
  return { ctx, calls, texts: () => calls.filter((c) => c.fn === 'fillText') };
}

const style = (over: Partial<ExportText> = {}): ExportText => ({ ...textFromPrefs(DEFAULT_LYRICS_PREFS), ...over });

describe('karaokeRows', () => {
  it('uses the overlay line selection: current line, nothing during a long gap', () => {
    expect(karaokeRows(lines, 2, 1).map((r) => r?.text)).toEqual(['first line']);
    expect(karaokeRows(null, 2, 1)).toEqual([]);
    expect(karaokeRows([{ start: 100, end: 105, text: 'late' }], 2, 1)).toEqual([]);
  });

  it('two lines: the next line is an upcoming row, an empty row stays', () => {
    const rows = karaokeRows(lines, 2, 2);
    expect(rows.map((r) => [r?.text, r?.state])).toEqual([['first line', 'current'], ['second line', 'upcoming']]);
  });
});

describe('drawKaraoke', () => {
  it('draws the line in the chosen colour at the chosen place, inside the picture', () => {
    const { ctx, texts } = recorder();
    drawKaraoke(ctx, 1280, 720, karaokeRows(lines, 2, 1), style({ karaokeColor: '#ffeb3b', karaokePosition: { x: 0.5, y: 0.82 } }));
    const [t] = texts();
    expect(t.args[0]).toBe('first line');
    expect(t.fill).toBe('#ffeb3b');
    expect(t.args[1]).toBeCloseTo(640, 0);
    expect(t.args[2] as number).toBeGreaterThan(0.7 * 720);
    expect(t.args[2] as number).toBeLessThan(720);
  });

  it('size follows the picture height like the overlay (4 % of it, times the size setting)', () => {
    const a = recorder();
    drawKaraoke(a.ctx, 1280, 720, karaokeRows(lines, 2, 1), style({ karaokeFontSize: 100 }));
    expect(a.texts()[0].font).toMatch(/^500 28\.8px /);
    const b = recorder();
    drawKaraoke(b.ctx, 1920, 1080, karaokeRows(lines, 2, 1), style({ karaokeFontSize: 150 }));
    expect(b.texts()[0].font).toMatch(/^500 64.8px /);
  });

  it('font, outline and background options reach the canvas', () => {
    const r = recorder();
    drawKaraoke(r.ctx, 1280, 720, karaokeRows(lines, 2, 1), style({ karaokeFont: 'serif', karaokeOutline: 'thick', karaokeBackground: 50 }));
    expect(r.texts()[0].font).toContain('Georgia');
    expect(r.calls.some((c) => c.fn === 'strokeText' && c.width === 4)).toBe(true);
    const box = r.calls.find((c) => c.fn === 'fill');
    expect(box?.fill).toBe('rgba(0,0,0,0.5)');
    const none = recorder();
    drawKaraoke(none.ctx, 1280, 720, karaokeRows(lines, 2, 1), style({ karaokeOutline: 'none', karaokeBackground: 0 }));
    expect(none.calls.some((c) => c.fn === 'strokeText' || c.fn === 'roundRect')).toBe(false);
  });

  it('two lines are two rows, the upcoming one dimmer', () => {
    const r = recorder();
    drawKaraoke(r.ctx, 1280, 720, karaokeRows(lines, 2, 2), style({ karaokeLines: 2 }));
    const t = r.texts();
    expect(t.map((x) => x.args[0])).toEqual(['first line', 'second line']);
    expect(t[0].alpha).toBe(1);
    expect(t[1].alpha).toBe(0.6);
    expect(t[1].args[2] as number).toBeGreaterThan(t[0].args[2] as number);
  });

  it('wraps a line wider than 90 % of the picture and never writes outside it', () => {
    const r = recorder();
    const long: LyricLine[] = [{ start: 0, end: 5, text: 'word '.repeat(30).trim() }];
    drawKaraoke(r.ctx, 640, 360, karaokeRows(long, 1, 1), style());
    const t = r.texts();
    expect(t.length).toBeGreaterThan(1);
    for (const x of t) expect((x.args[0] as string).length * 10).toBeLessThanOrEqual(0.9 * 640);
    for (const x of t) expect(x.args[2] as number).toBeLessThan(360);
  });

  it('draws nothing without a line', () => {
    const r = recorder();
    drawKaraoke(r.ctx, 1280, 720, [], style());
    expect(r.calls.length).toBe(0);
  });
});
