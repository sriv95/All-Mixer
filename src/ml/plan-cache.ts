/**
 * Speed of the GPU for a model, remembered between warm-ups (the extension page keeps it in chrome.storage.local, the
 * worker looks it up). The RoFormer warm-up first times a step at the 2 s geometry on a session of its own (create,
 * compile, 8 runs: ~13 s of a 34 s warm-up for High quality at a 6 s limit); a remembered speed skips that and goes
 * straight to the chunk plan, which is still timed and gated as before. A speed that no longer holds fails that gate
 * and the worker measures afresh.
 */
export interface SpeedEntry {
  /** p90 of one block step at the default geometry, ms (the `baseMs` the planner takes). */
  baseMs: number;
  /** Date.now() when it was measured. */
  at: number;
}
export type SpeedCache = Record<string, SpeedEntry>;

/** The GPU's load and temperature change: an old speed is not trusted. */
export const SPEED_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_ENTRIES = 8;

/** What the speed depends on: the model files, the code that runs them, and the GPU. */
export function speedKey(p: { model: string; modelVersion: number; appVersion: string; adapter: string }): string {
  return [p.model, p.modelVersion, p.appVersion, p.adapter].join('|');
}

export function lookupSpeed(cache: SpeedCache | undefined, key: string, now = Date.now()): number | null {
  const e = cache?.[key];
  if (!e || !Number.isFinite(e.baseMs) || e.baseMs <= 0 || !(now - e.at >= 0 && now - e.at < SPEED_TTL_MS)) return null;
  return e.baseMs;
}

/** A copy of `cache` with the new entry, the oldest entries dropped beyond a few (other GPUs, old versions). */
export function rememberSpeed(cache: SpeedCache | undefined, key: string, baseMs: number, now = Date.now()): SpeedCache {
  const next: SpeedCache = { ...cache, [key]: { baseMs, at: now } };
  const keys = Object.keys(next).sort((a, b) => next[b].at - next[a].at);
  for (const k of keys.slice(MAX_ENTRIES)) delete next[k];
  return next;
}
