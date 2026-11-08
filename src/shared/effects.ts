/** Whole-mix effects: a 3-band EQ into a dry/wet reverb. No DOM or chrome deps; works on any BaseAudioContext (live or offline). */
export interface EffectsParams {
  /** Reverb dry/wet, 0 (dry) to 1 (wet). */
  reverb: number;
  /** EQ gains, dB (−EQ_MAX_DB to +EQ_MAX_DB): low shelf, mid peak, high shelf. */
  low: number;
  mid: number;
  high: number;
}

export interface EffectsStage {
  input: AudioNode;
  output: AudioNode;
  /** Move every control to `p` (smoothed). */
  set(p: EffectsParams): void;
}

export const EQ_MAX_DB = 12;
export const NO_EFFECTS: Readonly<EffectsParams> = { reverb: 0, low: 0, mid: 0, high: 0 };
export const hasEffects = (p: EffectsParams): boolean => p.reverb !== 0 || p.low !== 0 || p.mid !== 0 || p.high !== 0;

const REVERB_SECONDS = 2;
const TAU = 0.015;

/** Stereo noise with an exponential decay (≈ −60 dB at the end); a seeded generator keeps live and export identical. */
export function reverbImpulse(ctx: BaseAudioContext, seconds = REVERB_SECONDS): AudioBuffer {
  const len = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  let seed = 12345;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      d[i] = ((seed / 2 ** 31) - 1) * Math.exp((-6.9 * i) / len);
    }
  }
  return buf;
}

/** input → low → mid → high ─┬─ dry ───────────┬→ output
 *                            └─ convolver → wet ┘ */
export function createEffects(ctx: BaseAudioContext, p: EffectsParams = NO_EFFECTS): EffectsStage {
  const band = (type: BiquadFilterType, frequency: number) => new BiquadFilterNode(ctx, { type, frequency, Q: 1 });
  const low = band('lowshelf', 250), mid = band('peaking', 1000), high = band('highshelf', 4000);
  const dry = new GainNode(ctx, { gain: 1 }), wet = new GainNode(ctx, { gain: 0 });
  const output = new GainNode(ctx, { gain: 1 });
  const verb = new ConvolverNode(ctx, { buffer: reverbImpulse(ctx), disableNormalization: false });
  low.connect(mid).connect(high);
  high.connect(dry).connect(output);
  high.connect(verb).connect(wet).connect(output);
  const set = (q: EffectsParams) => {
    const t = ctx.currentTime;
    const mix = Math.min(1, Math.max(0, q.reverb));
    const db = (v: number) => Math.min(EQ_MAX_DB, Math.max(-EQ_MAX_DB, v));
    low.gain.setTargetAtTime(db(q.low), t, TAU);
    mid.gain.setTargetAtTime(db(q.mid), t, TAU);
    high.gain.setTargetAtTime(db(q.high), t, TAU);
    dry.gain.setTargetAtTime(1 - mix, t, TAU);
    wet.gain.setTargetAtTime(mix, t, TAU);
  };
  set(p);
  return { input: low, output, set };
}
