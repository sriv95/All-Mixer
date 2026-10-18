import type { ContentStatus } from './messages';
import type { Mode } from './settings';

/** What Separate mode is doing, as the popup banner and the toolbar badge show it. */
export type SepView =
  | { kind: 'off' }
  | { kind: 'warming' }
  | { kind: 'live'; delayS: string }
  | { kind: 'unavailable' | 'stopped' | 'error'; cause: string };

export function separationView(mode: Mode, s: ContentStatus | undefined): SepView {
  const sep = s?.separation;
  if (mode !== 'separate' || !sep) return { kind: 'off' };
  if (sep.state === 'loading') return { kind: 'warming' };
  if (sep.state === 'error') return { kind: 'error', cause: sep.error ?? 'unknown' };
  if (sep.state !== 'on') return { kind: 'off' };
  const choice = sep.choice;
  switch (choice?.state) {
    case 'warming':
      return { kind: 'warming' };
    case 'unavailable':
    case 'stopped':
      return { kind: choice.state, cause: choice.cause ?? 'unknown' };
    default:
      return { kind: 'live', delayS: (sep.latency.processingMs / 1000).toFixed(1) };
  }
}
