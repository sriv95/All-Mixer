import type { KaraokeStyle, LyricsPrefs } from '../../shared/lyrics-prefs';

/** Size steps of the Size setting, percent. */
export const KARAOKE_SIZES = [50, 75, 100, 125, 150, 200] as const;

export function nearestSize(size: number): number {
  return KARAOKE_SIZES.reduce((best, n) => (Math.abs(n - size) < Math.abs(best - size) ? n : best));
}

export interface StylePreset {
  id: string;
  label: string;
  style: KaraokeStyle;
}

/** One-tap looks for the karaoke text. The first is the stock look. */
export const STYLE_PRESETS: readonly StylePreset[] = [
  { id: 'default', label: 'Default', style: { karaokeColor: '#ffffff', karaokeFontSize: 100, karaokeFont: 'default', karaokeOutline: 'normal', karaokeBackground: 0 } },
  { id: 'bigYellow', label: 'Big yellow', style: { karaokeColor: '#ffeb3b', karaokeFontSize: 150, karaokeFont: 'default', karaokeOutline: 'thick', karaokeBackground: 0 } },
  { id: 'cleanBox', label: 'Clean box', style: { karaokeColor: '#ffffff', karaokeFontSize: 100, karaokeFont: 'sans', karaokeOutline: 'none', karaokeBackground: 50 } },
  { id: 'cyanGlow', label: 'Cyan glow', style: { karaokeColor: '#4dd0e1', karaokeFontSize: 125, karaokeFont: 'sans', karaokeOutline: 'thick', karaokeBackground: 0 } },
];

/** The stock look plus no line transition: what "Reset style" sets. */
export const RESET_STYLE: Partial<LyricsPrefs> = { ...STYLE_PRESETS[0].style, karaokeAnimation: 'none' };

/** The built-in presets, then "My style" when one is saved. */
export function stylePresets(prefs: LyricsPrefs): StylePreset[] {
  return [...STYLE_PRESETS, ...(prefs.karaokeMyStyle ? [{ id: 'mine', label: 'My style', style: prefs.karaokeMyStyle }] : [])];
}

/** The preset the current look equals (size compared by its nearest step), if any. */
export function matchedStylePreset(prefs: LyricsPrefs): StylePreset | undefined {
  return stylePresets(prefs).find((p) => (Object.keys(p.style) as (keyof KaraokeStyle)[]).every((k) => p.style[k] === (k === 'karaokeFontSize' ? nearestSize(prefs[k]) : prefs[k])));
}

export const pickStyle = (p: KaraokeStyle): KaraokeStyle => ({
  karaokeColor: p.karaokeColor,
  karaokeFontSize: p.karaokeFontSize,
  karaokeFont: p.karaokeFont,
  karaokeOutline: p.karaokeOutline,
  karaokeBackground: p.karaokeBackground,
});

/** Vertical places for the text, centered horizontally. `bottom` is the default position. */
export const POSITION_PRESETS = [
  { id: 'top', label: 'Top', y: 0.12 },
  { id: 'middle', label: 'Middle', y: 0.5 },
  { id: 'bottom', label: 'Bottom', y: 0.82 },
] as const;

const POSITION_TOLERANCE = 0.01;

export function matchedPosition(prefs: LyricsPrefs): (typeof POSITION_PRESETS)[number] | undefined {
  const { x, y } = prefs.karaokePosition;
  return POSITION_PRESETS.find((p) => Math.abs(x - 0.5) < POSITION_TOLERANCE && Math.abs(y - p.y) < POSITION_TOLERANCE);
}
