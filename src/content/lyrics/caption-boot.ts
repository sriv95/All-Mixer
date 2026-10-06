/**
 * Start of each video on youtube.com: the player only gives us its caption data (and the token we need to
 * fetch it) once CC has been on, so lyrics from captions need CC on for a moment.
 *
 * - CC was already on: leave everything alone (`onInitial(true)`).
 * - CC was off: turn it on to load the captions, tell `onInitial(false)` (the caller keeps YouTube's caption
 *   text hidden), and turn CC off again once the captions arrived. The user can turn CC on later to see them.
 */
export interface CaptionBootDeps {
  /** CC button state; null while there is no usable button (player loading, ad, video without captions). */
  state(): 'on' | 'off' | null;
  /** Press the CC button. */
  toggle(): void;
  /** CC state at the start of the video, called once per `start`. */
  onInitial(wasOn: boolean): void;
}

const POLL_MS = 300;
const GIVE_UP_MS = 15_000;
/** After the captions event: time for the lyrics to be fetched and aligned before CC goes off. */
const RESTORE_DELAY_MS = 1500;
/** No captions event after turning CC on: restore anyway. */
const RESTORE_FALLBACK_MS = 10_000;
/** A CC change this soon after our own press is ours, not the user's. */
const OWN_WINDOW_MS = 2000;

export class CaptionBoot {
  private videoId: string | null = null;
  private poll: ReturnType<typeof setTimeout> | undefined;
  private restore: ReturnType<typeof setTimeout> | undefined;
  private restoring = false;
  private ownAt = -Infinity;

  constructor(
    private readonly deps: CaptionBootDeps,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A new video: read the CC state once the button is ready. */
  start(videoId: string): void {
    this.cancel();
    this.videoId = videoId;
    const until = this.now() + GIVE_UP_MS;
    const tick = (): void => {
      const s = this.deps.state();
      if (s) {
        this.deps.onInitial(s === 'on');
        if (s === 'off') {
          this.press();
          this.restoring = true;
          this.restore = setTimeout(() => this.restoreOff(), RESTORE_FALLBACK_MS);
        }
        return;
      }
      if (this.now() < until) this.poll = setTimeout(tick, POLL_MS);
    };
    tick();
  }

  /** The player loaded the captions of `videoId`. */
  captionsLoaded(videoId: string): void {
    if (!this.restoring || videoId !== this.videoId) return;
    clearTimeout(this.restore);
    this.restore = setTimeout(() => this.restoreOff(), RESTORE_DELAY_MS);
  }

  /** True shortly after our own press: a CC change then is not the user's. */
  isOwnChange(): boolean {
    return this.now() - this.ownAt < OWN_WINDOW_MS;
  }

  /** The user pressed CC: from now on they decide. */
  userToggled(): void {
    if (this.isOwnChange()) return;
    this.cancel();
  }

  cancel(): void {
    clearTimeout(this.poll);
    clearTimeout(this.restore);
    this.poll = this.restore = undefined;
    this.restoring = false;
  }

  private restoreOff(): void {
    this.restore = undefined;
    if (!this.restoring) return;
    this.restoring = false;
    if (this.deps.state() === 'on') this.press();
  }

  private press(): void {
    this.ownAt = this.now();
    this.deps.toggle();
  }
}
