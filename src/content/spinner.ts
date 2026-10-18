import { findSpinner } from './youtube-dom';

/**
 * The player's own loading spinner (so it looks like what YouTube shows while it loads), with a short label under it
 * that says what we wait for. The spinner covers what the user waits for in Separate mode: the ML warm-up, the held
 * end of a video and the silent gap after a seek. Each reason switches on and off on its own; the label is the one of
 * the newest reason.
 *
 * The player hides the spinner again on its own state changes (it sets `display: none`), so it is kept up while any
 * reason is on.
 */
export class PlayerSpinner {
  private readonly reasons = new Map<string, string>();
  private readonly guard = new MutationObserver(() => this.paint());
  private label: HTMLElement | null = null;

  /** `text` switches the reason on (or changes its label); `null` switches it off. */
  set(reason: string, text: string | null): void {
    this.reasons.delete(reason); // re-adding puts it last: the newest reason names the wait
    if (text !== null) this.reasons.set(reason, text);
    this.paint();
  }

  private paint(): void {
    const spinner = findSpinner();
    if (!spinner) return;
    this.guard.disconnect();
    const text = [...this.reasons.values()].at(-1);
    spinner.style.display = text === undefined ? 'none' : 'block';
    if (this.label?.parentElement !== spinner) this.label = this.makeLabel(spinner);
    this.label.textContent = text ?? '';
    this.label.hidden = text === undefined;
    if (text !== undefined) this.guard.observe(spinner, { attributes: true, attributeFilter: ['style'] });
  }

  private makeLabel(spinner: HTMLElement): HTMLElement {
    const el = document.createElement('div');
    el.className = 'all-mixer-spinner-label';
    // The spinner is 64 px square centred in the player (its box has no height): 48 px puts the label right under the circle.
    el.style.cssText =
      'position:absolute;top:48px;left:50%;transform:translateX(-50%);white-space:nowrap;color:#fff;font:500 13px/1.3 Roboto,Arial,sans-serif;text-shadow:0 0 4px #000,0 0 8px #000;pointer-events:none';
    spinner.append(el);
    return el;
  }
}
