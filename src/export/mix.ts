import { softClip } from '../content/audio/limiter';
import { PARTS } from '../worklet/protocol';
import { EXPORT_SAMPLE_RATE, TRACK_LABEL, partsOf, tracksOf, type ExportOptions, type Part, type Stem, type TrackId } from '../shared/export';
import { masterGainFor, separationFor, effectsFor, type MixerSettings } from '../shared/settings';
import { createEffects, hasEffects, type EffectsParams } from '../shared/effects';
import { PitchShifter } from '../worklet/pitch-shifter';
import { PITCH_LATENCY_SAMPLES } from '../worklet/protocol';

export type Pair = [Float32Array, Float32Array];

/** A piece of the recording and its stems; sample `i` of every array is input sample `start + i`. */
export interface StemSlice {
  start: number;
  length: number;
  /** The recording as it was. */
  dry: Pair;
  /** "Vocal for the instrumental": the instrumental is dry − vk (src/ml/karaoke.ts). */
  vk?: Pair;
  /** The vocal (A cappella). */
  vocal?: Pair;
  /** Parts of the instrumental the model took out. */
  parts?: Partial<Record<Part, Pair>>;
}

/** Transparent below 0.98; above it (a boosted mix) a soft knee so a file never clips. */
const limit = (x: number): number => (x > 0.98 || x < -0.98 ? softClip(x, 0.98, 0.999) : x);

/** With these, `mixSlice` hands the mix over as its two terms (levels applied, no master, no limit) for the pitch and effects stages instead of writing it. */
export interface MixTerms {
  vocal: Pair;
  instr: Pair;
}

/**
 * The tracks of one slice, with the live formula of the separator worklet (src/worklet/separator-processor.ts):
 *   mix = master * (vg * vocal + ig * (dg * drums + gg * guitar + ag * bass + pg * piano + og * (instrumental − parts)))
 * and in Separate tracks mode each stem alone, raw: the levels shape the mix track only (the stems are for re-mixing in an editor),
 * the global volume applies to every track.
 * Without a model (a slice with only `dry`) the mix is the recording at the master level.
 */
export function mixSlice(options: Pick<ExportOptions, 'tracks' | 'audio'>, s: StemSlice, terms?: MixTerms): Record<TrackId, Pair | undefined> {
  const a: MixerSettings = options.audio;
  const master = masterGainFor(a);
  const g = separationFor({ ...a, mode: 'separate', pitchSplit: false });
  const want = new Set<TrackId>(tracksOf(options));
  const n = s.length;
  const out = {} as Record<TrackId, Pair | undefined>;
  for (const id of want) out[id] = [new Float32Array(n), new Float32Array(n)];
  if (!s.vk || !s.vocal) {
    for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) (terms ? terms.instr : out.mix!)[c][i] = terms ? s.dry[c][i] : limit(master * s.dry[c][i]);
    return out;
  }
  const partGain: Record<Part, number> = { drums: g.drums, guitar: g.guitar, bass: g.bass, piano: g.piano };
  const parts = PARTS.filter((p) => s.parts?.[p]);
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < n; i++) {
      const instr = s.dry[c][i] - s.vk[c][i];
      const v = s.vocal[c][i];
      let rest = instr;
      let partsSum = 0;
      for (const p of parts) {
        const x = s.parts![p]![c][i];
        rest -= x;
        partsSum += partGain[p] * x;
      }
      const instrumental = g.instrumental * (partsSum + g.others * rest);
      const mix = out.mix;
      if (terms) {
        terms.vocal[c][i] = g.vocal * v;
        terms.instr[c][i] = instrumental;
      } else if (mix) mix[c][i] = limit(master * (g.vocal * v + instrumental));
      const set = (id: TrackId, x: number) => {
        const t = out[id];
        if (t) t[c][i] = limit(master * x);
      };
      set('vocals', v);
      set('instrumental', instr);
      for (const p of parts) set(p, s.parts![p]![c][i]);
      set('others', rest);
    }
  }
  return out;
}

/** File name of a track inside the zip or the stream name inside the MP4: `01-mix`, `02-vocals`. */
export const trackFile = (id: TrackId, index: number): string => `${String(index + 1).padStart(2, '0')}-${TRACK_LABEL[id].toLowerCase()}`;

/**
 * The raw stems of one slice, named like the Separate tracks of an export (`stemsOf`): the vocal, each part, and the rest of the
 * instrumental (`instrumental` when no part is split out). No gain and no limit: the player applies the levels live.
 */
export function stemsOfSlice(audio: Pick<MixerSettings, 'mlModel' | 'splitInstrumental' | 'splitGuitar'>, s: StemSlice): Partial<Record<Stem, Pair>> {
  const out: Partial<Record<Stem, Pair>> = {};
  if (!s.vk || !s.vocal) return out;
  const parts = partsOf(audio).filter((p) => s.parts?.[p]);
  const rest: Pair = [new Float32Array(s.length), new Float32Array(s.length)];
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < s.length; i++) {
      let x = s.dry[c][i] - s.vk[c][i];
      for (const p of parts) x -= s.parts![p]![c][i];
      rest[c][i] = x;
    }
  }
  out.vocals = s.vocal;
  for (const p of parts) out[p] = s.parts![p]!;
  out[parts.length ? 'others' : 'instrumental'] = rest;
  return out;
}

const zeros = (n: number): Pair => [new Float32Array(n), new Float32Array(n)];
const cat = (a: Float32Array, b: Float32Array): Float32Array => {
  const x = new Float32Array(a.length + b.length);
  x.set(a);
  x.set(b, a.length);
  return x;
};
/** What an effects render needs before a piece to have the reverb tail and the filters as they would be mid-song: the IR (2 s) plus margin. */
const PRE_ROLL = Math.round(2.5 * EXPORT_SAMPLE_RATE);

/** A piece of every track, `start` = the index of its first sample (the same for all tracks). */
export interface MixedPiece {
  start: number;
  tracks: Record<TrackId, Pair | undefined>;
}

/**
 * The mix of a whole export, slice by slice, in the order of live playback (separator worklet, then effects, then master gain and limiter):
 * levels, a pitch shifter per stem, the sum, EQ and reverb, master, limit. Pitch and effects shape the mix track only (the stems stay raw, as in `mixSlice`).
 * Without pitch and effects it is `mixSlice`, byte for byte.
 * - Pitch: the shifters keep their state across slices. They delay by PITCH_LATENCY_SAMPLES, so every track is delayed that much (the stems
 *   by a plain delay), the first PITCH_LATENCY_SAMPLES of output are dropped and `flush()` runs that many zeros through at the end:
 *   the file keeps the length and the alignment of the source.
 * - Effects: each piece is rendered offline with PRE_ROLL samples of the mix before it in front (dropped after), so the reverb tail and the filters carry over a seam.
 */
export class ExportMixer {
  private readonly pitch: [number, number];
  private readonly fx: EffectsParams;
  private readonly shifting: boolean;
  private shifters = [new PitchShifter(), new PitchShifter()];
  /** Each stem's last PITCH_LATENCY_SAMPLES (the delay that matches the shifters'). */
  private carry = new Map<TrackId, Pair>();
  /** The mix before the effects: the last PRE_ROLL samples. */
  private history = zeros(0);
  private skip = PITCH_LATENCY_SAMPLES;
  private emitted = 0;

  constructor(private readonly options: Pick<ExportOptions, 'tracks' | 'audio'>) {
    this.fx = effectsFor(options.audio);
    const g = separationFor(options.audio);
    this.pitch = [g.pitchVocal, g.pitchInstrumental];
    this.shifting = this.pitch.some((p) => p !== 0);
    if (!this.shifting) this.skip = 0;
  }

  /** Whether the pitch or effects stage does anything: if not, the export is `mixSlice` alone. */
  get active(): boolean {
    return this.shifting || hasEffects(this.fx);
  }

  async mix(s: StemSlice): Promise<MixedPiece | null> {
    if (!this.active) return { start: s.start, tracks: mixSlice(this.options, s) };
    const n = s.length;
    const terms: MixTerms = { vocal: zeros(n), instr: zeros(n) };
    const out = mixSlice(this.options, s, terms);
    const pre = zeros(n);
    if (this.shifting) {
      const [a, b] = this.shifters;
      a.process(terms.vocal[0], terms.vocal[1], terms.vocal[0], terms.vocal[1], n, this.pitch[0]);
      b.process(terms.instr[0], terms.instr[1], terms.instr[0], terms.instr[1], n, this.pitch[1]);
      for (const id of Object.keys(out) as TrackId[]) if (id !== 'mix') out[id] = this.delayed(id, out[id]!);
    }
    for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) pre[c][i] = terms.vocal[c][i] + terms.instr[c][i];
    const cut = Math.min(this.skip, n); // the start latency: nothing of the source is before it
    this.skip -= cut;
    if (cut === n) return null;
    const mix = pre.map((ch) => ch.subarray(cut)) as Pair;
    const lit = hasEffects(this.fx) ? await this.render(mix) : mix;
    const master = masterGainFor(this.options.audio);
    const tracks = {} as Record<TrackId, Pair | undefined>;
    for (const id of Object.keys(out) as TrackId[]) tracks[id] = id === 'mix' ? (lit.map((x) => x.map((v) => limit(master * v))) as Pair) : (out[id]!.map((x) => x.subarray(cut)) as Pair);
    const piece = { start: this.emitted, tracks };
    this.emitted += n - cut;
    return piece;
  }

  /** The end: the shifters' last PITCH_LATENCY_SAMPLES of sound (none without pitch). */
  async flush(): Promise<MixedPiece | null> {
    return this.shifting ? this.mix({ start: this.emitted, length: PITCH_LATENCY_SAMPLES, dry: zeros(PITCH_LATENCY_SAMPLES) }) : null;
  }

  /** `x` delayed by PITCH_LATENCY_SAMPLES, same length. */
  private delayed(id: TrackId, x: Pair): Pair {
    const old = this.carry.get(id) ?? zeros(PITCH_LATENCY_SAMPLES);
    const all = x.map((ch, c) => cat(old[c], ch)) as Pair;
    this.carry.set(id, all.map((ch) => ch.slice(x[0].length)) as Pair);
    return all.map((ch) => ch.subarray(0, x[0].length)) as Pair;
  }

  /** Render `x` through EQ and reverb with the earlier mix as pre-roll (createEffects on an OfflineAudioContext). */
  private async render(x: Pair): Promise<Pair> {
    const h = this.history[0].length;
    const n = x[0].length;
    const ctx = new OfflineAudioContext(2, h + n, EXPORT_SAMPLE_RATE);
    const buffer = ctx.createBuffer(2, h + n, EXPORT_SAMPLE_RATE);
    for (let c = 0; c < 2; c++) {
      const d = buffer.getChannelData(c);
      d.set(this.history[c], 0);
      d.set(x[c], h);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const fx = createEffects(ctx, this.fx);
    src.connect(fx.input);
    fx.output.connect(ctx.destination);
    src.start();
    const done = await ctx.startRendering();
    this.history = x.map((ch, c) => cat(this.history[c], ch).slice(-PRE_ROLL)) as Pair;
    return [done.getChannelData(0).slice(h), done.getChannelData(1).slice(h)];
  }
}
