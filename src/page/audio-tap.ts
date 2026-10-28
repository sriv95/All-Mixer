// Keeps a copy of the audio the YouTube player appends to its MediaSource, so the export can read a whole video in seconds instead of
// recording it in real time. Passive: the player gets the same bytes it always did. Main world, installed at document_start (bridge.ts).
import type { TapData, TapStatus } from '../shared/bridge';
import { CLUSTER_ID, EBML_ID, clusterHead, startsWithId, timecodeScaleNs } from './webm';

/** More audio than this (about 3 h of Opus) is not kept: the tap gives up and the export records. */
export const TAP_MAX_BYTES = 160e6;
/** Time ranges closer than this are one range. */
const JOIN_S = 0.05;
const MAX_TAPS = 4;

interface Group {
  parts: Uint8Array[];
  have: number;
  /** Bytes of the whole Cluster; null = unknown. */
  expect: number | null;
  /** A second copy of a Cluster we already hold in full: its bytes are skipped. */
  dup: boolean;
}

const complete = (g: Group): boolean => g.expect === null || g.have >= g.expect;
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** The Clusters of one audio SourceBuffer, by timecode. The player appends a segment in pieces, and a seek can cut one short. */
export class ClusterStore {
  init: Uint8Array | null = null;
  /** Why the copy cannot be used (set once, the bytes are dropped). */
  unusable: string | null = null;
  bytes = 0;
  private scaleNs = 1_000_000;
  private readonly groups = new Map<number, Group[]>();
  private cur: Group | null = null;

  constructor(private readonly maxBytes = TAP_MAX_BYTES) {}

  giveUp(why: string): void {
    this.unusable ??= why;
    this.groups.clear();
    this.init = null;
    this.cur = null;
    this.bytes = 0;
  }

  /** One `appendBuffer` call. */
  push(b: Uint8Array): void {
    if (this.unusable) return;
    if (startsWithId(b, EBML_ID)) {
      if (this.init && !sameBytes(this.init, b)) return this.giveUp('the audio format changed');
      if (!this.init) {
        this.init = b;
        this.scaleNs = timecodeScaleNs(b);
        this.bytes += b.length;
      }
      this.cur = null;
      return;
    }
    let at = 0;
    while (at < b.length) {
      const rest = at === 0 ? b : b.subarray(at);
      if (startsWithId(rest, CLUSTER_ID)) {
        const head = clusterHead(rest);
        if (!head) return this.giveUp('a Cluster header was not in one piece');
        const have = this.groups.get(head.timecode) ?? [];
        const g: Group = { parts: [], have: 0, expect: head.total, dup: have.some(complete) };
        if (!g.dup) have.push(g);
        this.groups.set(head.timecode, have);
        this.cur = g;
      } else if (!this.cur) {
        return this.giveUp('audio data that is not a Cluster');
      }
      const g = this.cur!;
      const n = g.expect === null ? rest.length : Math.min(rest.length, Math.max(0, g.expect - g.have));
      if (n === 0) break; // bytes after a finished Cluster that are not a Cluster (a Cues or Void): nothing to keep
      if (!g.dup) {
        g.parts.push(rest.subarray(0, n));
        this.bytes += n;
      }
      g.have += n;
      at += n;
      if (this.bytes > this.maxBytes) return this.giveUp('the video is too long to keep');
    }
  }

  /** Start (s) of every Cluster we only hold in part. */
  incomplete(): number[] {
    const out: number[] = [];
    for (const [tc, gs] of this.groups) if (!gs.some(complete)) out.push((tc * this.scaleNs) / 1e9);
    return out.sort((x, y) => x - y);
  }

  /** The init segment and the best copy of every Cluster in time order: a file `decodeAudioData` reads. */
  file(): Uint8Array | null {
    if (this.unusable || !this.init) return null;
    const parts: Uint8Array[] = [this.init];
    for (const tc of [...this.groups.keys()].sort((x, y) => x - y)) {
      const gs = this.groups.get(tc)!;
      const best = gs.find(complete) ?? gs.reduce((a, c) => (c.have > a.have ? c : a));
      parts.push(...best.parts);
    }
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/** Time ranges that were in the player's buffer at some moment (what it has evicted since still counts: we kept the bytes). */
export class Coverage {
  private ranges: [number, number][] = [];
  add(start: number, end: number): void {
    if (!(end > start)) return;
    const out: [number, number][] = [];
    let s = start;
    let e = end;
    for (const r of this.ranges) {
      if (r[1] < s - JOIN_S) out.push(r);
      else if (r[0] > e + JOIN_S) {
        out.push([s, e]);
        [s, e] = r;
      } else {
        s = Math.min(s, r[0]);
        e = Math.max(e, r[1]);
      }
    }
    out.push([s, e]);
    this.ranges = out.sort((a, b) => a[0] - b[0]);
  }
  list(): [number, number][] {
    return this.ranges.map((r) => [r[0], r[1]]);
  }
}

interface Entry {
  ms: MediaSource;
  mime: string;
  store: ClusterStore;
  coverage: Coverage;
}

const taps: Entry[] = [];
const urls = new WeakMap<MediaSource, string>();

function entryFor(url: string): Entry | undefined {
  return taps.find((t) => urls.get(t.ms) === url);
}

/** What the tap holds for the media element whose `currentSrc` is `url`; null = it has no tap for that source. */
export function tapStatus(url: string): TapStatus | null {
  const t = entryFor(url);
  if (!t) return null;
  return { usable: !t.store.unusable, reason: t.store.unusable ?? undefined, mime: t.mime, covered: t.coverage.list(), incomplete: t.store.incomplete(), bytes: t.store.bytes };
}

export function tapTake(url: string): TapData | null {
  const t = entryFor(url);
  const file = t?.store.file();
  if (!t || !file) return null;
  return { mime: t.mime, data: file.buffer as ArrayBuffer }; // `file()` made the array for itself: its buffer is exactly the file
}

const copy = (d: BufferSource): Uint8Array => (ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice() : new Uint8Array(d).slice());

export function installAudioTap(): void {
  if (typeof MediaSource === 'undefined' || typeof SourceBuffer === 'undefined') return;
  const byBuffer = new WeakMap<SourceBuffer, Entry>();

  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (this: unknown, obj: Blob | MediaSource) {
    const url = createObjectURL.call(this, obj);
    if (obj instanceof MediaSource) urls.set(obj, url);
    return url;
  };

  const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (this: MediaSource, mime: string) {
    const sb = addSourceBuffer.call(this, mime);
    if (typeof mime === 'string' && /^audio\//i.test(mime)) {
      const entry: Entry = { ms: this, mime, store: new ClusterStore(), coverage: new Coverage() };
      // shortcut: only WebM (Opus) is read; an MP4 (AAC) player is left to the recording, add a fragment parser when that is common.
      if (!/^audio\/webm/i.test(mime)) entry.store.unusable = `${mime} is not read`;
      byBuffer.set(sb, entry);
      taps.push(entry);
      while (taps.length > MAX_TAPS) taps.shift();
      sb.addEventListener('updateend', () => {
        try {
          for (let i = 0; i < sb.buffered.length; i++) entry.coverage.add(sb.buffered.start(i), sb.buffered.end(i));
        } catch {
          /* the buffer was removed from its source */
        }
      });
      this.addEventListener('sourceclose', () => {
        const i = taps.indexOf(entry);
        if (i >= 0) taps.splice(i, 1);
      });
    }
    return sb;
  };

  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (this: SourceBuffer, data: BufferSource) {
    const entry = byBuffer.get(this);
    if (entry && !entry.store.unusable) {
      // The player must get its bytes whatever happens to our copy.
      try {
        if (this.timestampOffset !== 0) entry.store.giveUp('the audio is shifted in time');
        else entry.store.push(copy(data));
      } catch (e) {
        entry.store.giveUp(`the copy failed: ${String(e)}`);
      }
    }
    return appendBuffer.call(this, data);
  };
}
