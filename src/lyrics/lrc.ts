import type { LyricLine, LyricWord } from './types';

export interface ParseLrcOptions {
  /** Duration given to the last line, seconds. Default 5. */
  lastLineDuration?: number;
}

const LINE_TIME = /^\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
const WORD_TIME = /<(\d+):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const OFFSET_TAG = /^\[offset\s*:\s*([+-]?\d+)\s*\]/i;

function toSeconds(min: string, sec: string, frac?: string): number {
  const f = frac ? Number(frac) / 10 ** frac.length : 0;
  return Number(min) * 60 + Number(sec) + f;
}

import { stripMarkup } from './markup';

interface RawWord {
  start: number;
  text: string;
}

/** Split text at `<mm:ss.xx>` tags. Returns null when there are none. */
function splitWords(body: string): RawWord[] | null {
  const words: RawWord[] = [];
  let lastIndex = 0;
  let pending: number | null = null;
  let found = false;
  const push = (text: string) => {
    text = stripMarkup(text);
    if (pending !== null && text !== '') words.push({ start: pending, text });
  };
  for (const m of body.matchAll(WORD_TIME)) {
    found = true;
    push(body.slice(lastIndex, m.index));
    pending = toSeconds(m[1], m[2], m[3]);
    lastIndex = m.index + m[0].length;
  }
  if (!found) return null;
  push(body.slice(lastIndex));
  return words;
}

/** Parse LRC / enhanced LRC text into sorted lines. Never throws. */
export function parseLrc(text: string, opts: ParseLrcOptions = {}): LyricLine[] {
  const lastDur = opts.lastLineDuration ?? 5;
  let offsetMs = 0;
  const raw: { start: number; text: string; words?: RawWord[] }[] = [];

  const src = String(text ?? '').replace(/^\uFEFF/, '');
  for (const rawLine of src.split(/\r\n|\r|\n/)) {
    let rest = rawLine.trim();
    const times: number[] = [];
    for (;;) {
      const m = LINE_TIME.exec(rest);
      if (!m) break;
      times.push(toSeconds(m[1], m[2], m[3]));
      rest = rest.slice(m[0].length);
    }
    if (times.length === 0) {
      const o = OFFSET_TAG.exec(rest);
      if (o) offsetMs = Number(o[1]);
      continue; // metadata or garbage
    }
    const split = splitWords(rest);
    let lineText: string;
    let words: RawWord[] | undefined;
    if (split && split.length > 0) {
      words = split;
      words[0].text = words[0].text.trimStart();
      words[words.length - 1].text = words[words.length - 1].text.trimEnd();
      words = words.filter((w) => w.text !== '');
      lineText = words.map((w) => w.text).join('');
    } else {
      lineText = stripMarkup(rest.replace(WORD_TIME, '')).trim();
    }
    for (const t of times) {
      const shift = t - times[0];
      raw.push({
        start: t,
        text: lineText,
        words: words?.length ? words.map((w) => ({ start: w.start + shift, text: w.text })) : undefined,
      });
    }
  }

  raw.sort((a, b) => a.start - b.start);
  const off = offsetMs / 1000;
  return raw.map((r, i) => {
    const start = r.start - off;
    const end = i + 1 < raw.length ? raw[i + 1].start - off : start + lastDur;
    const line: LyricLine = { start, end, text: r.text };
    if (r.words) {
      line.words = r.words.map((w, j): LyricWord => ({
        start: w.start - off,
        end: j + 1 < r.words!.length ? r.words![j + 1].start - off : end,
        text: w.text,
      }));
    }
    return line;
  });
}
