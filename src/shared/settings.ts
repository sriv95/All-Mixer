import { ML_MODELS, type MlModel } from '../worklet/protocol';
import { MAX_DELAY_S, MIN_DELAY_S } from '../ml/rof-plan';

export type Mode = 'default' | 'separate';

export interface MixerSettings {
  /** Which popup tab / audio mode is active. */
  mode: Mode;
  /** Default mode master volume, percent (0–600). */
  masterPct: number;
  /** Separate mode vocal volume, percent (0–600). Used once separation lands. */
  vocalPct: number;
  /** Separate mode instrumental volume, percent (0–600). Used once separation lands. */
  instrumentalPct: number;
  /** Separate mode ML model: 'mdx' (MDX-Net 9482 + Spleeter, the default) or a downloaded Mel-Band RoFormer: 'roformer' (Kim fine-tune, High quality) or 'deux' (Best quality). */
  mlModel: MlModel;
  /** RoFormer chunk length: true = chosen automatically from the speed of the GPU (smallest delay that works), false = `mlDelayS`. */
  mlAuto: boolean;
  /** Manual RoFormer delay budget, seconds (MIN_DELAY_S to MAX_DELAY_S): the audio delay stays below it. */
  mlDelayS: number;
}

const GAIN_MIN_PCT = 0;
const GAIN_MAX_PCT = 600;

export const DEFAULT_SETTINGS: Readonly<MixerSettings> = Object.freeze({
  mode: 'default',
  masterPct: 100,
  vocalPct: 100,
  instrumentalPct: 100,
  mlModel: 'mdx',
  mlAuto: true,
  mlDelayS: 4,
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
    mlModel: ML_MODELS.includes(r.mlModel as MlModel) ? (r.mlModel as MlModel) : DEFAULT_SETTINGS.mlModel,
    mlAuto: r.mlAuto !== false,
    mlDelayS: clampDelayS(r.mlDelayS),
  };
}

export function clampDelayS(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_SETTINGS.mlDelayS;
  return Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, Math.round(n)));
}

/** RoFormer delay budget for the engine selector, ms; null = automatic. */
export const mlDelayMsFor = (settings: MixerSettings): number | null => (settings.mlAuto ? null : settings.mlDelayS * 1000);

/** Linear gain for the master stage. Separate mode uses the per-stem gains instead. */
export function masterGainFor(settings: MixerSettings): number {
  return settings.mode === 'default' ? settings.masterPct / 100 : 1;
}

/** What the audio engine's separator should do for these settings (gains linear, 0–6). */
export function separationFor(settings: MixerSettings): {
  on: boolean;
  vocal: number;
  instrumental: number;
} {
  return {
    on: settings.mode === 'separate',
    vocal: settings.vocalPct / 100,
    instrumental: settings.instrumentalPct / 100,
  };
}
