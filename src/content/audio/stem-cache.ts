import { EXPORT_SAMPLE_RATE, type Stem } from '../../shared/export';
import { separationFor, type MixerSettings } from '../../shared/settings';
import type { Pair } from '../../export/mix';
import type { StemCache as PersistentCache } from '../../shared/stem-cache';
import type { StemSet } from '../../shared/stem-store';

/** The stems of a whole video in memory (Preload Audio): one stereo AudioBuffer per stem, at the sample rate of the models. */
export class StemCache {
  readonly buffers = new Map<Stem, AudioBuffer>();

  /** `key` identifies the video, `signature` the model and split switches the stems came from (src/shared/preload.ts). */
  constructor(readonly key: string, readonly signature: string, readonly duration: number, stems: readonly Stem[]) {
    const length = Math.max(1, Math.round(duration * EXPORT_SAMPLE_RATE));
    for (const s of stems) this.buffers.set(s, new AudioBuffer({ length, sampleRate: EXPORT_SAMPLE_RATE, numberOfChannels: 2 }));
  }

  /** Samples `start…` of the stems of one slice of the recording. */
  add(stems: Partial<Record<Stem, Pair>>, start: number): void {
    for (const [id, buf] of this.buffers) {
      const pair = stems[id];
      if (!pair) continue;
      buf.copyToChannel(pair[0] as Float32Array<ArrayBuffer>, 0, start);
      buf.copyToChannel(pair[1] as Float32Array<ArrayBuffer>, 1, start);
    }
  }

  /** The stems as a StemSet for the persistent cache. `copy`: fresh arrays (storing transfers, i.e. detaches, the arrays it is given). */
  toSet(copy = false): StemSet {
    const stems: StemSet['stems'] = {};
    let length = 0;
    for (const [id, b] of this.buffers) {
      length = b.length;
      stems[id] = [0, 1].map((c) => (copy ? b.getChannelData(c).slice() : b.getChannelData(c)));
    }
    return { sampleRate: EXPORT_SAMPLE_RATE, length, stems };
  }

  get bytes(): number {
    let n = 0;
    for (const b of this.buffers.values()) n += b.length * 2 * 4;
    return n;
  }
}

/** Saves the stems in the persistent cache from a copy (it transfers, i.e. detaches, its arrays: memory keeps its own). A failure only means no persistent copy. */
export const persistStems = (store: Pick<PersistentCache, 'put'>, key: string, cache: StemCache): Promise<boolean> => store.put(key, cache.toSet(true)).catch(() => false);

/**
 * Linear gain of each stem for the live sliders: the formula of the separator worklet and `mixSlice`,
 *   vg · vocal + ig · (dg · drums + gg · guitar + … + og · rest)
 * (the global volume is the master gain of the chain, after the cache).
 */
export function stemLevels(settings: MixerSettings, stems: Iterable<Stem>): Partial<Record<Stem, number>> {
  const g = separationFor({ ...settings, mode: 'separate', pitchSplit: false });
  const out: Partial<Record<Stem, number>> = {};
  for (const s of stems) {
    out[s] = s === 'vocals' ? g.vocal : g.instrumental * (s === 'others' || s === 'instrumental' ? g.others : g[s]);
  }
  return out;
}
