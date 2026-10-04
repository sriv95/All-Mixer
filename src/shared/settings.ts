export type Mode = 'default' | 'separate';

export type SeparationQuality = 'auto' | 'light' | 'quality';

export const SEPARATION_QUALITIES: readonly SeparationQuality[] = ['auto', 'light', 'quality'];

export interface MixerSettings {
  /** Which popup tab / audio mode is active. */
  mode: Mode;
  /** Default mode master volume, percent (0–600). */
  masterPct: number;
  /** Separate mode vocal volume, percent (0–600). Used once separation lands. */
  vocalPct: number;
  /** Separate mode instrumental volume, percent (0–600). Used once separation lands. */
  instrumentalPct: number;
  /** Separate mode engine choice: light = DSP, quality = ML, auto = engine decides. */
  separationQuality: SeparationQuality;
}

export const GAIN_MIN_PCT = 0;
export const GAIN_MAX_PCT = 600;

export const DEFAULT_SETTINGS: Readonly<MixerSettings> = Object.freeze({
  mode: 'default',
  masterPct: 100,
  vocalPct: 100,
  instrumentalPct: 100,
  separationQuality: 'auto',
});

export function clampPct(value: unknown, fallback = 100): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(GAIN_MAX_PCT, Math.max(GAIN_MIN_PCT, Math.round(n)));
}

/** Turn any stored / messaged value into a valid settings object. */
export function normalizeSettings(raw: unknown): MixerSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof MixerSettings, unknown>>;
  return {
    mode: r.mode === 'separate' ? 'separate' : 'default',
    masterPct: clampPct(r.masterPct, DEFAULT_SETTINGS.masterPct),
    vocalPct: clampPct(r.vocalPct, DEFAULT_SETTINGS.vocalPct),
    instrumentalPct: clampPct(r.instrumentalPct, DEFAULT_SETTINGS.instrumentalPct),
    separationQuality: SEPARATION_QUALITIES.find((q) => q === r.separationQuality) ?? 'auto',
  };
}

/**
 * Linear gain for the master stage. Separate mode is not wired yet
 * (Marquess's separation engine), so it plays at unity for now.
 */
export function masterGainFor(settings: MixerSettings): number {
  return settings.mode === 'default' ? settings.masterPct / 100 : 1;
}
