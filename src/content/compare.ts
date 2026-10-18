/** How long the original plays after the popup's last "still held" message: the popup may close while its button is down. */
export const COMPARE_HOLD_MS = 800;

/**
 * "Hear the original": while the popup holds its button, the separator plays every stem at 100 %, which sums to the
 * original mix, with no change to the delay (so the picture stays in sync). The popup repeats "on" every 300 ms.
 */
export class Compare {
  private held = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onChange: () => void, private readonly holdMs = COMPARE_HOLD_MS) {}

  get active(): boolean {
    return this.held;
  }

  set(on: boolean): void {
    clearTimeout(this.timer);
    if (on) this.timer = setTimeout(() => this.set(false), this.holdMs);
    if (on === this.held) return;
    this.held = on;
    this.onChange();
  }
}
