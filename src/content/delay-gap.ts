/** After these the audio delay line is empty: the sound comes back one delay after playback resumes. */
const FLUSH_EVENTS = ['seeking', 'emptied', 'loadstart'] as const;
/** Gives up on a sound that never reports, so the spinner cannot stay for good. */
const GIVE_UP_MS = 5000;

/**
 * In Separate mode a seek (or a new video) empties the audio delay line, so
 * there is no sound for `delayMs` after playback resumes, while the picture
 * already shows the new position. This keeps `onWait(true)` from the seek, over
 * the loading of the video, until `whenAudible` says the sound is out of the
 * speakers. A pause hides it, and a later play brings it back if the sound
 * is still missing. Not while paused: a seek on a paused video shows it at play.
 */
export function watchDelayGap(
  getVideo: () => HTMLMediaElement | null,
  delayMs: () => number,
  /** Calls back when the audio that starts now is audible; returns the cancel function. */
  whenAudible: (cb: () => void) => () => void,
  onWait: (waiting: boolean) => void,
): () => void {
  let waiting = false;
  let cancelAudible: (() => void) | null = null;
  let giveUp: ReturnType<typeof setTimeout> | undefined;

  const disarm = () => {
    cancelAudible?.();
    cancelAudible = null;
    clearTimeout(giveUp);
  };
  const done = () => {
    disarm();
    waiting = false;
    onWait(false);
  };
  const onFlush = (e: Event) => {
    const video = getVideo();
    if (!video || e.target !== video) return;
    disarm();
    waiting = delayMs() > 0;
    onWait(waiting && !video.paused);
  };
  const onPlaying = (e: Event) => {
    if (!waiting || e.target !== getVideo()) return;
    onWait(true);
    if (cancelAudible) return;
    cancelAudible = whenAudible(done);
    giveUp = setTimeout(done, delayMs() + GIVE_UP_MS);
  };
  const onPause = (e: Event) => {
    if (waiting && e.target === getVideo()) onWait(false);
  };

  for (const type of FLUSH_EVENTS) window.addEventListener(type, onFlush, true);
  window.addEventListener('playing', onPlaying, true);
  window.addEventListener('pause', onPause, true);
  return () => {
    disarm();
    if (waiting) onWait(false);
    for (const type of FLUSH_EVENTS) window.removeEventListener(type, onFlush, true);
    window.removeEventListener('playing', onPlaying, true);
    window.removeEventListener('pause', onPause, true);
  };
}
