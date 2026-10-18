import { PAUSE_REQUEST_EVENT } from '../shared/bridge';

/** Events that cancel a deferred end: the user seeked / replayed, or the source changed. */
const CANCEL_EVENTS = ['seeking', 'emptied', 'loadstart'] as const;

/**
 * In Separate mode the sound and picture trail the video by `delayMs`, so when
 * the video really ends the user still has that much left to hear. Without
 * this, YouTube would load the next clip (autoplay / queue) over the tail.
 *
 * A capture listener on window sees `pause` (fired just before `ended`) and
 * `ended` before any listener on the element, so stopping them there also holds
 * back our own hold handlers. After the delay both are fired again, in order.
 * A pause click in the meantime (reported by the page bridge) fires `pause` at once and drops the `ended`.
 */
export function deferEnd(
  getVideo: () => HTMLMediaElement | null,
  delayMs: () => number,
  /** True while the end is held back, false when it was released or dropped. */
  onWait: (waiting: boolean) => void = () => {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let replaying = false;

  const onEnd = (e: Event) => {
    const video = getVideo();
    if (replaying || !video || e.target !== video || !video.ended) return;
    const d = delayMs();
    if (d <= 0) return;
    e.stopImmediatePropagation();
    if (e.type !== 'ended' || timer !== undefined) return;
    onWait(true);
    timer = setTimeout(() => {
      timer = undefined;
      onWait(false);
      replaying = true;
      try {
        if (video.ended) for (const type of ['pause', 'ended']) video.dispatchEvent(new Event(type));
      } finally {
        replaying = false;
      }
    }, d);
  };
  const onPauseRequest = (e: Event) => {
    const video = getVideo();
    if (!video || timer === undefined || e.target !== video) return;
    clearTimeout(timer);
    timer = undefined;
    onWait(false);
    replaying = true;
    try {
      video.dispatchEvent(new Event('pause'));
    } finally {
      replaying = false;
    }
  };
  const cancel = (e: Event) => {
    if (e.target !== getVideo()) return;
    if (timer !== undefined) onWait(false);
    clearTimeout(timer);
    timer = undefined;
  };

  window.addEventListener('pause', onEnd, true);
  window.addEventListener('ended', onEnd, true);
  window.addEventListener(PAUSE_REQUEST_EVENT, onPauseRequest, true);
  for (const type of CANCEL_EVENTS) window.addEventListener(type, cancel, true);
  return () => {
    if (timer !== undefined) onWait(false);
    clearTimeout(timer);
    window.removeEventListener('pause', onEnd, true);
    window.removeEventListener('ended', onEnd, true);
    window.removeEventListener(PAUSE_REQUEST_EVENT, onPauseRequest, true);
    for (const type of CANCEL_EVENTS) window.removeEventListener(type, cancel, true);
  };
}
