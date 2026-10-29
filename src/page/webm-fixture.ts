// Synthetic WebM pieces for tests.
/** EBML with a 4-byte size, the way YouTube's segments are written. */
const size4 = (n: number): number[] => [0x10 | ((n >>> 24) & 0x0f), (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
export const el = (id: number[], payload: number[]): number[] => [...id, ...size4(payload.length), ...payload];
export const initSegment = (scaleNs = 1_000_000): Uint8Array =>
  Uint8Array.from([...el([0x1a, 0x45, 0xdf, 0xa3], [0x42, 0x86, 0x81, 0x01]), ...el([0x15, 0x49, 0xa9, 0x66], [0x2a, 0xd7, 0xb1, 0x84, scaleNs >>> 24, (scaleNs >>> 16) & 255, (scaleNs >>> 8) & 255, scaleNs & 255])]);
/** A Cluster with Timecode `tc` and `body` filler bytes (a SimpleBlock's worth). */
export const cluster = (tc: number, body = 100): Uint8Array => Uint8Array.from(el([0x1f, 0x43, 0xb6, 0x75], [0xe7, 0x82, (tc >> 8) & 255, tc & 255, ...new Array<number>(body).fill(7)]));
