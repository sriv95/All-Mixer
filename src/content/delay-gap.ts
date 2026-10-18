/** After these the audio delay line is empty: the sound comes back one delay later. */
const FLUSH_EVENTS = ['seeking', 'emptied', 'loadstart'] as const;

/**
 * In Separate mode a seek (or a new source) empties the audio delay line, so
 * when playback resumes there is no sound for `delayMs` while the picture
 * already shows the new position. `onWait(true)` covers that silence so the
 * user sees the player is busy; a pause ends it early.
 */
export function watchDelayGap(
  getVideo: () => HTMLMediaElement | null,
  delayMs: () => number,
  onWait: (waiting: boolean) => void,
): () => void {
  let flushed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    onWait(false);
  };
  const onFlush = (e: Event) => {
    if (e.target !== getVideo()) return;
    stop();
    flushed = true;
  };
  const onPlaying = (e: Event) => {
    const d = delayMs();
    if (e.target !== getVideo() || !flushed || d <= 0) return;
    flushed = false;
    onWait(true);
    timer = setTimeout(() => {
      timer = undefined;
      onWait(false);
    }, d);
  };
  const onPause = (e: Event) => {
    if (e.target === getVideo()) stop();
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
