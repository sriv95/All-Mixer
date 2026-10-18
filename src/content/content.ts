import type { ContentRequest, ContentStatus, GetMyTabSettings } from '../shared/messages';
import { DEFAULT_SETTINGS, masterGainFor, mlDelayMsFor, normalizeSettings, separationFor, type MixerSettings } from '../shared/settings';
import { EngineSelector } from './audio/engine-select';
import { MasterChain } from './audio/master-chain';
import { MODEL_IDS, keyInstalled } from '../shared/model-store';
import { AvProbe } from './av-probe';
import { deferEnd } from './deferred-end';
import { watchDelayGap } from './delay-gap';
import { TimeDisplay } from './time-display';
import { initLyrics, type LyricsFeature } from './lyrics/init';
import { DelayedVideo } from './video-delay/delayed-video';
import { overlayDelayMs } from './video-delay/schedule';
import { detectSite, findSpinner, watchMainVideo, type PageSite } from './youtube-dom';

// Lyrics exist for YouTube / YT Music only; every other site gets the mixer without them.
// Frames (embeds, ads) run the mixer too, but a YouTube embed gets no lyrics UI.
const lyricsSite = window === window.top ? detectSite(location.hostname) : null;
const site: PageSite = lyricsSite ?? 'generic';

let settings: MixerSettings = { ...DEFAULT_SETTINGS };
let video: HTMLMediaElement | null = null;
let overlay: DelayedVideo | null = null;
let timeDisplay: TimeDisplay | null = null;
let debugBudget: number | null = null;
let debugDelayMs: number | null = null; // QA override, see debug-video-delay
const probe = new AvProbe();
const chain = new MasterChain(() => syncDelay(), undefined, probe);
const selector = new EngineSelector(chain);
// The player's own spinner covers what the user waits for: the ML warm-up, the held end of a video, and the silent
// gap after a seek. Each reason switches it on and off on its own.
// The player hides it again on its own state changes (it sets `display: none`), so keep it up while we wait.
const spinnerReasons = new Set<string>();
const spinnerGuard = new MutationObserver(() => paintSpinner());
const paintSpinner = () => {
  const spinner = findSpinner();
  if (!spinner) return;
  spinnerGuard.disconnect();
  const on = spinnerReasons.size > 0;
  spinner.style.display = on ? 'block' : 'none';
  if (on) spinnerGuard.observe(spinner, { attributes: true, attributeFilter: ['style'] });
};
const spinnerFor = (reason: string) => (waiting: boolean) => {
  if (waiting) spinnerReasons.add(reason);
  else spinnerReasons.delete(reason);
  paintSpinner();
};
// The warm-up takes 10 to 40 s: hold the video (sound and picture) behind the player's spinner until it is over, then resume what we paused.
let pausedForWarmup: HTMLMediaElement | null = null;
const warmupSpinner = spinnerFor('warmup');
selector.onChange = ({ state }) => {
  if (state === 'warming') {
    if (video && !video.paused) {
      video.pause();
      pausedForWarmup = video;
    }
    // A video the user had paused is not waiting for anything.
    warmupSpinner(pausedForWarmup !== null);
    return;
  }
  warmupSpinner(false);
  if (pausedForWarmup) {
    void pausedForWarmup.play().catch(() => {}); // autoplay rules can refuse; the user presses play then
    pausedForWarmup = null;
  }
};
// A RoFormer model was downloaded or updated in the background: load it if it is the one in use.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const id of MODEL_IDS) if (keyInstalled(id) in changes) selector.reload(id);
});
// The end of the video (autoplay / queue) waits for the delayed tail to play out.
deferEnd(() => video, () => overlay?.delayMs ?? 0, spinnerFor('end'));
watchDelayGap(() => video, () => overlay?.delayMs ?? 0, (cb) => chain.whenAudible(cb), spinnerFor('gap'));
// Lyrics follow what the user sees and hears, which trails currentTime by the picture delay (D1).
const lyrics: LyricsFeature = lyricsSite
  ? initLyrics(lyricsSite, () => overlay?.presentedTime() ?? null, () => overlay?.presentedBusy() ?? false)
  : { setVideo() {}, togglePanel() {}, modeChanged() {} };

// D1: the picture trails by the graph's total audio delay (processing + device).
const wantedDelayMs = (videoDelayMs = chain.latency.videoDelayMs): number => debugDelayMs ?? overlayDelayMs(settings.mode, videoDelayMs);

/** Apply the wanted picture delay; ignore moves under 5 ms (latency jitter). */
const syncDelay = (force = false, want = wantedDelayMs(), effectiveAt?: number) => {
  if (!overlay) return;
  if (!force && Math.abs(want - overlay.delayMs) < 5 && (want > 0) === (overlay.delayMs > 0)) return;
  overlay.setDelay(want, effectiveAt);
};

// Fires when separation switches on/off (at the moment the new audio reaches
// the speakers) and when device latency moves, e.g. a Bluetooth switch.
chain.onLatencyChange((info, at) => syncDelay(false, wantedDelayMs(info.videoDelayMs), at));

let modeKnown = false; // the first settings load is not a toggle
// Nothing starts (audio context, ML host) in a frame or page until it has media: most frames have none.
const push = () => {
  chain.setGain(masterGainFor(settings));
  const sep = separationFor(settings);
  chain.setSeparation(sep);
  selector.update({ on: sep.on, model: settings.mlModel, delayMs: mlDelayMsFor(settings), drums: settings.splitInstrumental });
  syncDelay();
};
const apply = (raw: unknown) => {
  const prevMode = settings.mode;
  settings = normalizeSettings(raw);
  if (settings.mode !== prevMode && modeKnown) lyrics.modeChanged();
  modeKnown = true;
  if (video) push();
};

// The content script lives for the whole tab session, so the settings survive
// YouTube's SPA navigation by default. Session storage (via the background)
// covers full reloads of the same tab.
watchMainVideo(site, (v) => {
  video = v;
  chain.setVideo(v);
  overlay?.destroy();
  overlay = null;
  timeDisplay?.destroy();
  timeDisplay = null;
  // An <audio> has no picture to delay.
  if (v instanceof HTMLVideoElement) {
    probe.attachVideo(v);
    lyrics.setVideo(v);
    overlay = new DelayedVideo(v, undefined, probe);
    if (lyricsSite) timeDisplay = new TimeDisplay(lyricsSite, v, () => overlay?.presentedTime() ?? null);
    syncDelay(true);
  }
  push();
});

chrome.runtime.onMessage.addListener((msg: ContentRequest, _sender, sendResponse) => {
  if (msg.type === 'apply-settings') {
    apply(msg.settings);
    sendResponse({ ok: true });
  } else if (msg.type === 'debug-video-delay') {
    // QA only: forced delay (lyrics follow it via overlay.delayMs) and budget.
    debugDelayMs = msg.delayMs;
    debugBudget = msg.budgetBytes ?? null;
    overlay?.setBudget(debugBudget);
    syncDelay(true);
    sendResponse({ ok: true });
  } else if (msg.type === 'get-status') {
    const status: ContentStatus = {
      site,
      videoFound: video !== null,
      audio: chain.state,
      gain: chain.requestedGain,
      videoDelay: { state: overlay?.state ?? 'off', delayMs: overlay?.delayMs ?? 0, stats: overlay?.stats },
      separation: { state: chain.separationState, latency: chain.latency, choice: selector.status, error: chain.separationError },
      error: chain.error,
      avProbe: probe.on ? probe.status : undefined,
    };
    sendResponse(status);
  }
  return false;
});

const req: GetMyTabSettings = { type: 'get-my-tab-settings' };
chrome.runtime.sendMessage(req).then(apply, (e) => console.warn('[All Mixer!] settings load failed:', e));
