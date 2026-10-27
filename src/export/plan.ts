import { EXPORT_SAMPLE_RATE, MAX_CHUNK_S } from '../shared/export';

/** The recording is cut in equal chunks of at most MAX_CHUNK_S: 200 s is 14 chunks of 14.3 s, not 13 of 15 s and one of 5 s. */
export interface ChunkPlan {
  count: number;
  /** Chunk length in seconds (the last one may be shorter by the rounding to samples). */
  seconds: number;
  /** Samples of a chunk at EXPORT_SAMPLE_RATE (the last chunk holds the rest). */
  samples: number;
  /** Samples of the whole recording. */
  total: number;
}

export function planChunks(durationS: number, maxS: number = MAX_CHUNK_S, rate: number = EXPORT_SAMPLE_RATE): ChunkPlan {
  const total = Math.max(1, Math.round(durationS * rate));
  const count = Math.max(1, Math.ceil(durationS / maxS));
  // Rounded up, so `count` chunks cover the recording; never above the maximum.
  const samples = Math.min(Math.ceil(total / count), Math.floor(maxS * rate));
  return { count: Math.ceil(total / samples), seconds: samples / rate, samples, total };
}

/** 1-based chunk that holds sample `at`. */
export const chunkAt = (plan: ChunkPlan, at: number): number => Math.min(plan.count, Math.floor(Math.max(0, at) / plan.samples) + 1);
