import { GPU_PREFERENCES, ML_MODELS, type GpuPreference, type MlModel } from '../worklet/protocol';
import { MAX_DELAY_S, MIN_DELAY_S } from '../ml/rof-plan';

export type Mode = 'default' | 'separate';

export interface MixerSettings {
  /** Which popup tab / audio mode is active. */
  mode: Mode;
  /** Global volume (a boost on top of either mode), percent (0–600). */
  masterPct: number;
  /** Separate mode vocal volume, percent (0–100). Used once separation lands. */
  vocalPct: number;
  /** Separate mode instrumental volume, percent (0–100). Used once separation lands. */
  instrumentalPct: number;
  /** Separate mode ML model: 'mdx' (MDX-Net 9482 + Spleeter, the default) or a downloaded RoFormer: 'roformer' (Kim fine-tune, High quality), 'deux' (Best Vocal) or 'sw' (Focus Instrumental Splitting: six stems in one pass; the Drums, Guitar, Bass and Piano levels apply and the split switches are off). */
  mlModel: MlModel;
  /** Split instrumental (Advanced): a second model takes the drums out of the instrumental, which then has a Drums and an Others gain. Costs GPU time and delay. */
  splitInstrumental: boolean;
  /** Split instrumental (Advanced): a third model takes the guitar out of the instrumental too (needs a fast GPU). The Guitar gain applies to it; Drums and Guitar can be on together. */
  splitGuitar: boolean;
  /** Drums gain inside the instrumental, percent (0–100); the instrumental gain applies on top. Used when splitInstrumental is on. */
  drumsPct: number;
  /** Guitar gain inside the instrumental, percent (0–100). Used when splitGuitar is on. */
  guitarPct: number;
  /** Bass and piano gain inside the instrumental, percent (0–100). Used with the 'sw' model. */
  bassPct: number;
  pianoPct: number;
  /** Gain of the rest of the instrumental (everything but the drums, guitar, bass and piano that are split out), percent (0–100). */
  othersPct: number;
  /** Delay limit, seconds (MIN_DELAY_S to MAX_DELAY_S): the audio delay stays below it (the drum split adds its own wait on top); a longer limit gives the model a longer chunk. */
  mlDelayS: number;
  /** Which GPU Separate mode prefers: the browser's choice, the fast one or the power-saving one. */
  gpu: GpuPreference;
  /** Global pitch, semitones (−PITCH_MAX to +PITCH_MAX), the same in both modes; the tempo does not change. */
  pitch: number;
  /** Separate mode (Advanced): the vocal and the instrumental get their own pitch instead of the global one. */
  pitchSplit: boolean;
  /** Vocal pitch, semitones. Used when pitchSplit is on. */
  vocalPitch: number;
  /** Instrumental pitch, semitones. Used when pitchSplit is on. */
  instrPitch: number;
}

const GAIN_MIN_PCT = 0;
const GAIN_MAX_PCT = 100;

export const DEFAULT_SETTINGS: Readonly<MixerSettings> = Object.freeze({
  mode: 'default',
  masterPct: 100,
  vocalPct: 100,
  instrumentalPct: 100,
  mlModel: 'mdx',
  splitInstrumental: false,
  splitGuitar: false,
  drumsPct: 100,
  guitarPct: 100,
  bassPct: 100,
  pianoPct: 100,
  othersPct: 100,
  mlDelayS: MIN_DELAY_S,
  gpu: 'auto',
  pitch: 0,
  pitchSplit: false,
  vocalPitch: 0,
  instrPitch: 0,
});

/** Pitch range, semitones either way: a key change for singing; wider shifts sound rough. */
export const PITCH_MAX = 6;

export function clampPitch(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.min(PITCH_MAX, Math.max(-PITCH_MAX, Math.round(n)));
}

export function clampPct(value: unknown, fallback = 100, min = GAIN_MIN_PCT, max = GAIN_MAX_PCT): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Only Global Volume boosts: 0–600 %. */
export const clampMasterPct = (value: unknown): number => clampPct(value, DEFAULT_SETTINGS.masterPct, GAIN_MIN_PCT, 600);

/** Global volume slider stops: 5 % steps to 50, 10 % to 100, 100 % to 600. */
export const MASTER_STEPS: readonly number[] = [
  ...Array.from({ length: 11 }, (_, i) => i * 5),
  60, 70, 80, 90, 100, 200, 300, 400, 500, 600,
];
const MASTER_UNITY = MASTER_STEPS.indexOf(100);
/** The slider spends 3 positions per step above 100 %, so 100 % sits in the middle (position 15 of 30). */
const ABOVE_UNITY_POS = 3;
export const MASTER_POS_MAX = MASTER_UNITY * 2;

export function masterPosOf(pct: number): number {
  const nearest = MASTER_STEPS.reduce((best, s, i) => (Math.abs(s - pct) < Math.abs(MASTER_STEPS[best] - pct) ? i : best), 0);
  return nearest <= MASTER_UNITY ? nearest : MASTER_UNITY + (nearest - MASTER_UNITY) * ABOVE_UNITY_POS;
}

/** Slider position to a stop. A move too small to leave the current stop still steps once, so arrow keys work above 100 %. */
export function masterPctAt(pos: number, current: number): number {
  const p = Math.min(MASTER_POS_MAX, Math.max(0, Math.round(pos)));
  let i = p <= MASTER_UNITY ? p : MASTER_UNITY + Math.round((p - MASTER_UNITY) / ABOVE_UNITY_POS);
  if (MASTER_STEPS[i] === current && p !== masterPosOf(current)) {
    i += p > masterPosOf(current) ? 1 : -1;
  }
  return MASTER_STEPS[Math.min(MASTER_STEPS.length - 1, Math.max(0, i))];
}

/** Others can only be turned down: 0–100 %. */
export const clampOthersPct = (value: unknown): number => clampPct(value, DEFAULT_SETTINGS.othersPct, GAIN_MIN_PCT, 100);

/** Turn any stored / messaged value into a valid settings object. */
export function normalizeSettings(raw: unknown): MixerSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof MixerSettings, unknown>>;
  return {
    mode: r.mode === 'separate' ? 'separate' : 'default',
    masterPct: clampMasterPct(r.masterPct),
    vocalPct: clampPct(r.vocalPct, DEFAULT_SETTINGS.vocalPct),
    instrumentalPct: clampPct(r.instrumentalPct, DEFAULT_SETTINGS.instrumentalPct),
    mlModel: ML_MODELS.includes(r.mlModel as MlModel) ? (r.mlModel as MlModel) : DEFAULT_SETTINGS.mlModel,
    splitInstrumental: r.splitInstrumental === true,
    splitGuitar: r.splitGuitar === true,
    drumsPct: clampPct(r.drumsPct, DEFAULT_SETTINGS.drumsPct),
    guitarPct: clampPct(r.guitarPct, DEFAULT_SETTINGS.guitarPct),
    bassPct: clampPct(r.bassPct, DEFAULT_SETTINGS.bassPct),
    pianoPct: clampPct(r.pianoPct, DEFAULT_SETTINGS.pianoPct),
    othersPct: clampOthersPct(r.othersPct),
    mlDelayS: clampDelayS(r.mlDelayS),
    gpu: GPU_PREFERENCES.includes(r.gpu as GpuPreference) ? (r.gpu as GpuPreference) : DEFAULT_SETTINGS.gpu,
    pitch: clampPitch(r.pitch),
    pitchSplit: r.pitchSplit === true,
    vocalPitch: clampPitch(r.vocalPitch),
    instrPitch: clampPitch(r.instrPitch),
  };
}

export function clampDelayS(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_SETTINGS.mlDelayS;
  return Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, Math.round(n)));
}

/** RoFormer delay limit for the engine selector, ms. */
export const mlDelayMsFor = (settings: MixerSettings): number => settings.mlDelayS * 1000;

/** Linear gain for the master stage: the global volume, in both modes (Separate mode adds its per-stem gains before it). */
export function masterGainFor(settings: MixerSettings): number {
  return settings.masterPct / 100;
}

/** What the audio engine's separator should do for these settings (gains linear, 0–6). */
export function separationFor(settings: MixerSettings): {
  on: boolean;
  vocal: number;
  instrumental: number;
  drums: number;
  guitar: number;
  bass: number;
  piano: number;
  others: number;
  /** Semitones. */
  pitchVocal: number;
  pitchInstrumental: number;
} {
  const sw = settings.mlModel === 'sw'; // the all-stems model splits the drums, guitar, bass and piano in one pass, whatever the switches say
  const drums = sw || settings.splitInstrumental, guitar = sw || settings.splitGuitar;
  // Own pitches only exist in Separate mode; the Default tab always uses the global one.
  const own = settings.mode === 'separate' && settings.pitchSplit;
  return {
    pitchVocal: own ? settings.vocalPitch : settings.pitch,
    pitchInstrumental: own ? settings.instrPitch : settings.pitch,
    on: settings.mode === 'separate',
    vocal: settings.vocalPct / 100,
    instrumental: settings.instrumentalPct / 100,
    drums: drums ? settings.drumsPct / 100 : 1,
    guitar: guitar ? settings.guitarPct / 100 : 1,
    bass: sw ? settings.bassPct / 100 : 1,
    piano: sw ? settings.pianoPct / 100 : 1,
    others: drums || guitar ? settings.othersPct / 100 : 1,
  };
}
