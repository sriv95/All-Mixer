import { PAUSE_REQUEST_EVENT } from '../shared/bridge';

/** Events that cancel a deferred end: the user seeked, or the source changed. */
const CANCEL_EVENTS = ['seeking', 'emptied', 'loadstart'] as const;

/**
 * In Separate mode the sound and picture trail the video by `delayMs`, so when
 * the video really ends the user still has that much left to hear. Without
 * this, YouTube would load the next clip (autoplay / queue) over the tail.
 *
 * A capture listener on window sees `pause` (fired just before `ended`) and
 * `ended` before any listener on the element, so stopping them there also holds
 * back our own hold handlers. After the delay both are fired again, in order.
 *
 * The player still thinks it is playing, so a pause click calls pause() on the ended element, which fires nothing:
 * the page bridge reports it, and `pause` is fired at once (our hold handlers freeze the tail, and the player moves on
 * to its own ended state, as a pause at the end of a video does without us).
 */
export function deferEnd(
  getVideo: () => HTMLMediaElement | null,
  delayMs: () => number,
  /** True while the end is held back, false when it was released or dropped. */
  onWait: (waiting: boolean) => void = () => {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let replaying = false;

  const fire = (video: HTMLMediaElement, ...types: string[]) => {
    replaying = true;
    try {
      for (const type of types) video.dispatchEvent(new Event(type));
    } finally {
      replaying = false;
    }
  };
  const wait = (video: HTMLMediaElement, ms: number) => {
    onWait(true);
    timer = setTimeout(() => {
      timer = undefined;
      onWait(false);
      if (video.ended) fire(video, 'pause', 'ended');
    }, ms);
  };
  const drop = () => {
    if (timer !== undefined) onWait(false);
    clearTimeout(timer);
    timer = undefined;
  };

  const onEnd = (e: Event) => {
    const video = getVideo();
    if (replaying || !video || e.target !== video || !video.ended) return;
    const d = delayMs();
    if (d <= 0) return;
    e.stopImmediatePropagation();
    if (e.type === 'ended' && timer === undefined) wait(video, d);
  };
  const onPauseRequest = (e: Event) => {
    const video = getVideo();
    if (!video || timer === undefined || e.target !== video) return;
    drop();
    fire(video, 'pause');
  };
  const onCancel = (e: Event) => {
    if (e.target === getVideo()) drop();
  };

  window.addEventListener('pause', onEnd, true);
  window.addEventListener('ended', onEnd, true);
  window.addEventListener(PAUSE_REQUEST_EVENT, onPauseRequest, true);
  for (const type of CANCEL_EVENTS) window.addEventListener(type, onCancel, true);
  return () => {
    drop();
    window.removeEventListener('pause', onEnd, true);
    window.removeEventListener('ended', onEnd, true);
    window.removeEventListener(PAUSE_REQUEST_EVENT, onPauseRequest, true);
    for (const type of CANCEL_EVENTS) window.removeEventListener(type, onCancel, true);
  };
}
