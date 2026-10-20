import { PAUSE_REQUEST_EVENT } from '../shared/bridge';

/**
 * Holds a playing video for the ML warm-up (10 to 40 s) without telling the player: it keeps showing "playing"
 * (pause button, no paused state, no replay screen) behind our spinner, and picks up again when the video resumes.
 * A real browser check showed YouTube stays in its playing state with no error through a 38 s hold.
 *
 * Our own pause() fires a `pause` event; a capture listener on window stops it before the player sees it.
 * If the user presses pause meanwhile, the player calls pause() on an element that is already paused: the page bridge
 * reports it, we let the player see a `pause` at last, and the video stays paused when the warm-up ends.
 */
export class WarmupHold {
  private held: HTMLMediaElement | null = null;
  private swallow = false;
  private clearSwallow: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly getVideo: () => HTMLMediaElement | null,
    /** The hold ended without `release()`: the user paused. */
    private readonly onUserPause: () => void = () => {},
  ) {
    window.addEventListener('pause', this.onPause, true);
    window.addEventListener(PAUSE_REQUEST_EVENT, this.onPauseRequest, true);
  }

  get active(): boolean {
    return this.held !== null;
  }

  /**
   * Pause a playing video out of sight. A video that is not playing is left alone. Called again while held, it pauses
   * the video once more if something started it (a new song, play after a user pause).
   */
  hold(): void {
    const video = this.getVideo();
    if (!video || video.paused) return;
    this.held = video;
    this.swallow = true;
    // The event is queued, not sent in pause(): never let the flag outlive it.
    this.clearSwallow = setTimeout(() => (this.swallow = false), 1000);
    video.pause();
  }

  /** Resume what `hold()` paused. */
  release(): void {
    const video = this.held;
    this.held = null;
    if (video) void video.play().catch(() => {}); // autoplay rules can refuse; the user presses play then
  }

  destroy(): void {
    clearTimeout(this.clearSwallow);
    window.removeEventListener('pause', this.onPause, true);
    window.removeEventListener(PAUSE_REQUEST_EVENT, this.onPauseRequest, true);
  }

  private readonly onPause = (e: Event): void => {
    if (!this.swallow || e.target !== this.held) return;
    this.swallow = false;
    clearTimeout(this.clearSwallow);
    e.stopImmediatePropagation();
  };

  private readonly onPauseRequest = (e: Event): void => {
    const video = this.held;
    if (!video || e.target !== video) return;
    this.held = null;
    video.dispatchEvent(new Event('pause')); // the player and our hold handlers see the pause now
    this.onUserPause();
  };
}
