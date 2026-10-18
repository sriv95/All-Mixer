import { beforeEach, describe, expect, it } from 'vitest';
import { PlayerSpinner } from './spinner';

describe('PlayerSpinner', () => {
  let spinner: PlayerSpinner;
  const el = () => document.querySelector<HTMLElement>('.ytp-spinner')!;
  const label = () => document.querySelector<HTMLElement>('.all-mixer-spinner-label')!;

  beforeEach(() => {
    document.body.innerHTML = '<div id="movie_player"><div class="ytp-spinner" style="display: none;"></div></div>';
    spinner = new PlayerSpinner();
  });

  it('shows the spinner with the label of the newest reason, and hides it when none is left', () => {
    spinner.set('gap', 'Syncing the sound');
    expect(el().style.display).toBe('block');
    expect(label().textContent).toBe('Syncing the sound');
    spinner.set('warmup', 'Preparing vocal separation… 3 s');
    expect(label().textContent).toBe('Preparing vocal separation… 3 s');
    spinner.set('warmup', null);
    expect(label().textContent).toBe('Syncing the sound');
    spinner.set('gap', null);
    expect(el().style.display).toBe('none');
    expect(label().hidden).toBe(true);
  });

  it('puts the spinner back when the player hides it while a reason is on', async () => {
    spinner.set('gap', 'Syncing the sound');
    el().style.display = 'none';
    await Promise.resolve();
    expect(el().style.display).toBe('block');
  });
});
