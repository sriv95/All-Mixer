/** After these the audio delay line is empty: the sound comes back one delay later. */
const FLUSH_EVENTS = ['seeking', 'emptied', 'loadstart'] as const;

/**
 * In Separate mode a seek (or a new source) empties the audio delay line, so
 * when playback resumes there is no sound for `delayMs` while the picture
 * already shows the new position. `onWait(true)` covers that silence so the
 * user sees the player is busy. A pause stops the spinner and a later play
 * shows it for the time that was left, like the picture overlay does.
 */
export function watchDelayGap(
  getVideo: () => HTMLMediaElement | null,
  delayMs: () => number,
  onWait: (waiting: boolean) => void,
): () => void {
  let flushed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let endsAt = 0;
  /** Ms of the gap left when a pause cut it short. */
  let left = 0;

  const stop = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    onWait(false);
  };
  const onFlush = (e: Event) => {
    if (e.target !== getVideo()) return;
    stop();
    left = 0;
    flushed = true;
  };
  const onPlaying = (e: Event) => {
    if (e.target !== getVideo() || timer !== undefined) return;
    const ms = left > 0 ? left : flushed ? delayMs() : 0;
    flushed = false;
    left = 0;
    if (ms <= 0) return;
    onWait(true);
    endsAt = performance.now() + ms;
    timer = setTimeout(() => {
      timer = undefined;
      onWait(false);
    }, ms);
  };
  const onPause = (e: Event) => {
    if (e.target !== getVideo()) return;
    if (timer !== undefined) left = Math.max(0, endsAt - performance.now());
    stop();
  };

  for (const type of FLUSH_EVENTS) window.addEventListener(type, onFlush, true);
  window.addEventListener('playing', onPlaying, true);
  window.addEventListener('pause', onPause, true);
  return () => {
    stop();
    for (const type of FLUSH_EVENTS) window.removeEventListener(type, onFlush, true);
    window.removeEventListener('playing', onPlaying, true);
    window.removeEventListener('pause', onPause, true);
  };
}
