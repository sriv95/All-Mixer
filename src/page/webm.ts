// Just enough of EBML / WebM to cut the audio segments YouTube appends to its player (an init segment, then Clusters).

export const EBML_ID = 0x1a45dfa3;
export const CLUSTER_ID = 0x1f43b675;
const TIMECODE_ID = 0xe7;
const TIMECODE_SCALE_ID = [0x2a, 0xd7, 0xb1];
/** The WebM default: a Cluster timecode counts milliseconds. */
const DEFAULT_SCALE_NS = 1_000_000;

/** Element id at `i` (marker bits kept, 1 to 4 bytes) and its length. */
export function readId(b: Uint8Array, i: number): [number, number] | null {
  const first = b[i];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 4 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 4 || i + len > b.length) return null;
  let v = 0;
  for (let k = 0; k < len; k++) v = v * 256 + b[i + k]!;
  return [v, len];
}

/** Element size at `i` (1 to 8 bytes) and its length; null as a size = "unknown" (all ones). */
export function readSize(b: Uint8Array, i: number): [number | null, number] | null {
  const first = b[i];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || i + len > b.length) return null;
  const mask = 0xff >> len;
  let v = first & mask;
  let ones = v === mask;
  for (let k = 1; k < len; k++) {
    v = v * 256 + b[i + k]!;
    if (b[i + k] !== 0xff) ones = false;
  }
  return [ones ? null : v, len];
}

export const startsWithId = (b: Uint8Array, id: number): boolean => readId(b, 0)?.[0] === id;

export interface ClusterHead {
  /** Cluster Timecode, in units of the file's timecode scale. */
  timecode: number;
  /** Bytes of the whole Cluster (header and payload); null = unknown size (the next Cluster ends it). */
  total: number | null;
}

/** Header of a Cluster that starts at the beginning of `b`, if the Timecode is in `b`. */
export function clusterHead(b: Uint8Array): ClusterHead | null {
  const id = readId(b, 0);
  if (id?.[0] !== CLUSTER_ID) return null;
  const size = readSize(b, id[1]);
  if (!size) return null;
  const start = id[1] + size[1];
  // The Timecode is the first child, but a Void or a CRC-32 may come before it.
  for (let i = start; i < Math.min(b.length, start + 64); ) {
    const cid = readId(b, i);
    if (!cid) return null;
    const csize = readSize(b, i + cid[1]);
    if (!csize || csize[0] === null) return null;
    const at = i + cid[1] + csize[1];
    if (cid[0] === TIMECODE_ID) {
      let timecode = 0;
      for (let k = 0; k < csize[0]; k++) timecode = timecode * 256 + (b[at + k] ?? 0);
      return { timecode, total: size[0] === null ? null : start + size[0] };
    }
    i = at + csize[0];
  }
  return null;
}

/** Nanoseconds per Cluster timecode unit, from the init segment (Info > TimecodeScale). */
export function timecodeScaleNs(init: Uint8Array): number {
  const [a, b, c] = TIMECODE_SCALE_ID;
  for (let i = 0; i + 4 < init.length; i++) {
    if (init[i] !== a || init[i + 1] !== b || init[i + 2] !== c) continue;
    const size = readSize(init, i + 3);
    if (!size || size[0] === null || size[0] < 1 || size[0] > 4) continue;
    let v = 0;
    for (let k = 0; k < size[0]; k++) v = v * 256 + (init[i + 3 + size[1] + k] ?? 0);
    if (v > 0) return v;
  }
  return DEFAULT_SCALE_NS;
}
