import { PAUSE_REQUEST_EVENT, PLAY_REQUEST_EVENT } from '../shared/bridge';

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
 * The player still thinks it is playing, and the page bridge reports its calls
 * on the ended element: pause() fires `pause` at once (our hold handlers freeze
 * the tail) and keeps the time left; play() is cancelled and fires `play` /
 * `playing` instead, so the tail continues instead of the video restarting.
 */
export function deferEnd(
  getVideo: () => HTMLMediaElement | null,
  delayMs: () => number,
  /** True while the end is held back, false when it was released or dropped. */
  onWait: (waiting: boolean) => void = () => {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let endsAt = 0;
  /** Set while the user paused the tail: ms of it that are left. */
  let left: number | null = null;
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
    endsAt = performance.now() + ms;
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
    left = null;
  };

  const onEnd = (e: Event) => {
    const video = getVideo();
    if (replaying || !video || e.target !== video || !video.ended) return;
    const d = delayMs();
    if (d <= 0) return;
    e.stopImmediatePropagation();
    if (e.type === 'ended' && timer === undefined && left === null) wait(video, d);
  };
  const onPauseRequest = (e: Event) => {
    const video = getVideo();
    if (!video || timer === undefined || e.target !== video) return;
    left = Math.max(0, endsAt - performance.now());
    clearTimeout(timer);
    timer = undefined;
    onWait(false);
    fire(video, 'pause');
  };
  const onPlayRequest = (e: Event) => {
    const video = getVideo();
    if (!video || left === null || e.target !== video) return;
    e.preventDefault(); // no restart from 0: the tail goes on
    const ms = left;
    left = null;
    fire(video, 'play', 'playing');
    wait(video, ms);
  };
  const onCancel = (e: Event) => {
    if (e.target === getVideo()) drop();
  };

  window.addEventListener('pause', onEnd, true);
  window.addEventListener('ended', onEnd, true);
  window.addEventListener(PAUSE_REQUEST_EVENT, onPauseRequest, true);
  window.addEventListener(PLAY_REQUEST_EVENT, onPlayRequest, true);
  for (const type of CANCEL_EVENTS) window.addEventListener(type, onCancel, true);
  return () => {
    drop();
    window.removeEventListener('pause', onEnd, true);
    window.removeEventListener('ended', onEnd, true);
    window.removeEventListener(PAUSE_REQUEST_EVENT, onPauseRequest, true);
    window.removeEventListener(PLAY_REQUEST_EVENT, onPlayRequest, true);
    for (const type of CANCEL_EVENTS) window.removeEventListener(type, onCancel, true);
  };
}
