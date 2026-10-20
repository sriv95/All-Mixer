import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TimeDisplay, formatTime } from './time-display';

describe('formatTime', () => {
  it('formats like the player', () => {
    expect(formatTime(5.9)).toBe('0:05');
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(3725)).toBe('1:02:05');
  });
});

describe('TimeDisplay (youtube)', () => {
  let video: HTMLVideoElement;
  let presented: number | null;
  let td: TimeDisplay;
  const q = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;

  beforeEach(() => {
    document.body.innerHTML = `<div id="movie_player"><span class="ytp-time-current">1:40</span>
      <div class="ytp-progress-bar"><div class="ytp-play-progress" style="transform: scaleX(0.5)"></div>
      <div class="ytp-scrubber-container" style="transform: translateX(500px)"></div></div></div>`;
    Object.defineProperty(q('.ytp-progress-bar'), 'clientWidth', { value: 1000 });
    video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 200 });
    Object.defineProperty(video, 'currentTime', { value: 100, writable: true });
    presented = 98;
    td = new TimeDisplay('youtube', video, () => presented);
  });
  afterEach(() => td.destroy());

  it('shows the presented time in the text and on the bar', () => {
    expect(q('.ytp-time-current').textContent).toBe('1:38');
    expect(q('.ytp-play-progress').style.transform).toBe('scaleX(0.49)');
    expect(q('.ytp-scrubber-container').style.transform).toBe('translateX(490px)');
  });

  it('does not shift twice, and follows the presented time while YouTube writes nothing', () => {
    td.update();
    expect(q('.ytp-play-progress').style.transform).toBe('scaleX(0.49)');
    presented = 100;
    td.update();
    expect(q('.ytp-play-progress').style.transform).toBe('scaleX(0.5)');
    expect(q('.ytp-time-current').textContent).toBe('1:40');
  });

  it('shows the full duration once the ended video has played out', () => {
    Object.defineProperty(video, 'ended', { value: true });
    Object.defineProperty(video, 'currentTime', { value: 200 });
    presented = 199.9;
    td.update();
    expect(q('.ytp-time-current').textContent).toBe('3:20');
    presented = 197; // the delayed tail is still playing
    td.update();
    expect(q('.ytp-time-current').textContent).toBe('3:17');
  });

  it('finds the elements again when the player re-creates them', () => {
    document.body.innerHTML = `<div id="movie_player"><span class="ytp-time-current">1:40</span>
      <div class="ytp-progress-bar"><div class="ytp-play-progress" style="transform: scaleX(0.5)"></div>
      <div class="ytp-scrubber-container" style="transform: translateX(500px)"></div></div></div>`;
    Object.defineProperty(q('.ytp-progress-bar'), 'clientWidth', { value: 1000 });
    td.update();
    expect(q('.ytp-time-current').textContent).toBe('1:38');
    expect(q('.ytp-scrubber-container').style.transform).toBe('translateX(490px)');
  });

  it('leaves the player alone without a presented time', () => {
    td.destroy();
    document.body.innerHTML = '<div id="movie_player"><span class="ytp-time-current">1:40</span></div>';
    presented = null;
    td = new TimeDisplay('youtube', video, () => presented);
    expect(q('.ytp-time-current').textContent).toBe('1:40');
  });

  it('moves the bar back across a chapter boundary', () => {
    td.destroy();
    document.body.innerHTML = `<div id="movie_player"><div class="ytp-progress-bar">
      <div class="ytp-play-progress" style="transform: scaleX(1)"></div>
      <div class="ytp-play-progress" style="transform: scaleX(0.01)"></div></div></div>`;
    const [a, b] = [...document.querySelectorAll<HTMLElement>('.ytp-play-progress')];
    Object.defineProperty(a, 'offsetWidth', { value: 600 });
    Object.defineProperty(b, 'offsetWidth', { value: 400 });
    Object.defineProperty(video, 'currentTime', { value: 120.8, writable: true });
    presented = 118.8;
    td = new TimeDisplay('youtube', video, () => presented);
    expect(parseFloat(a.style.transform.slice(7))).toBeCloseTo(0.99, 5);
    expect(parseFloat(b.style.transform.slice(7))).toBe(0);
  });

  it('leaves the bar alone while the user drags it', () => {
    td.destroy();
    document.body.innerHTML = `<div id="movie_player" class="seeking-mode"><span class="ytp-time-current">1:40</span>
      <div class="ytp-progress-bar"><div class="ytp-play-progress" style="transform: scaleX(0.5)"></div></div></div>`;
    td = new TimeDisplay('youtube', video, () => presented);
    expect(q('.ytp-time-current').textContent).toBe('1:40');
    expect(q('.ytp-play-progress').style.transform).toBe('scaleX(0.5)');
  });

  it('gives screen readers the presented time', () => {
    td.destroy();
    document.body.innerHTML = `<div id="movie_player"><div class="ytp-progress-bar" aria-valuenow="100"
      aria-valuetext="1 Minutes 40 Seconds of 3 Minutes 20 Seconds"></div></div>`;
    td = new TimeDisplay('youtube', video, () => presented);
    expect(q('.ytp-progress-bar').getAttribute('aria-valuenow')).toBe('98');
    expect(q('.ytp-progress-bar').getAttribute('aria-valuetext')).toBe('1 Minutes 38 Seconds of 3 Minutes 20 Seconds');
  });
});
