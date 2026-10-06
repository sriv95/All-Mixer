/**
 * YouTube timed text (`/api/timedtext?fmt=json3`) → caption cues.
 * Auto-generated (ASR) tracks carry per-word offsets (`segs[].tOffsetMs`),
 * which we use for word-level timing; manual tracks give one cue per line.
 */

import { stripMarkup } from './markup';

export interface CaptionWord {
  start: number;
  text: string;
}

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
  /** Per-word timing; only for ASR tracks. */
  words?: CaptionWord[];
}

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}
interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
  aAppend?: number;
}

/** Strip music notes / [Music] style annotations. Returns '' for pure annotations. */
export function cleanCaptionText(s: string): string {
  return stripMarkup(s)
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[♪♫♬]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseJson3(raw: string | unknown): CaptionCue[] {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return [];
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const events = (data as { events?: Json3Event[] } | null)?.events;
  if (!Array.isArray(events)) return [];

  const cues: CaptionCue[] = [];
  for (const ev of events) {
    if (!ev || !Array.isArray(ev.segs) || ev.aAppend) continue;
    const start = (ev.tStartMs ?? 0) / 1000;
    const end = start + (ev.dDurationMs ?? 0) / 1000;
    const hasOffsets = ev.segs.length > 1 || ev.segs.some((s) => s.tOffsetMs !== undefined);
    const words: CaptionWord[] = [];
    let text = '';
    for (const seg of ev.segs) {
      const t = seg.utf8 ?? '';
      text += t;
      if (hasOffsets) {
        const w = cleanCaptionText(t);
        if (w) words.push({ start: start + (seg.tOffsetMs ?? 0) / 1000, text: w });
      }
    }
    const clean = cleanCaptionText(text.replace(/\n/g, ' '));
    if (!clean) continue;
    cues.push(words.length > 1 ? { start, end, text: clean, words } : { start, end, text: clean });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/** Flatten cues to timed words. Cues without word timing are spread evenly across the cue. */
export function captionWords(cues: CaptionCue[]): CaptionWord[] {
  const out: CaptionWord[] = [];
  for (const c of cues) {
    if (c.words) {
      out.push(...c.words.flatMap((w) => splitWords(w.text).map((text) => ({ start: w.start, text }))));
      continue;
    }
    const ws = splitWords(c.text);
    const dur = Math.max(0.1, c.end - c.start);
    ws.forEach((text, i) => out.push({ start: c.start + (dur * i) / ws.length, text }));
  }
  return out;
}

function splitWords(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}
