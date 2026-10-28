import { softClip } from '../content/audio/limiter';
import { PARTS } from '../worklet/protocol';
import { TRACK_LABEL, partsOf, tracksOf, type ExportOptions, type Part, type Stem, type TrackId } from '../shared/export';
import { masterGainFor, separationFor, type MixerSettings } from '../shared/settings';

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

/**
 * The tracks of one slice, with the live formula of the separator worklet (src/worklet/separator-processor.ts):
 *   mix = master * (vg * vocal + ig * (dg * drums + gg * guitar + ag * bass + pg * piano + og * (instrumental − parts)))
 * and in Separate tracks mode each stem alone, raw: the levels shape the mix track only (the stems are for re-mixing in an editor),
 * the global volume applies to every track.
 * Without a model (a slice with only `dry`) the mix is the recording at the master level.
 */
export function mixSlice(options: Pick<ExportOptions, 'tracks' | 'audio'>, s: StemSlice): Record<TrackId, Pair | undefined> {
  const a: MixerSettings = options.audio;
  const master = masterGainFor(a);
  const g = separationFor({ ...a, mode: 'separate', pitchSplit: false });
  const want = new Set<TrackId>(tracksOf(options));
  const n = s.length;
  const out = {} as Record<TrackId, Pair | undefined>;
  for (const id of want) out[id] = [new Float32Array(n), new Float32Array(n)];
  if (!s.vk || !s.vocal) {
    for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) out.mix![c][i] = limit(master * s.dry[c][i]);
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
      if (mix) mix[c][i] = limit(master * (g.vocal * v + instrumental));
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
