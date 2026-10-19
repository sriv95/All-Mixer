import type { ContentRequest, ContentStatus, GetMyTabSettings, SetBadge } from '../shared/messages';
import { separationView } from '../shared/separation-view';
import { DEFAULT_SETTINGS, masterGainFor, mlDelayMsFor, normalizeSettings, separationFor, type MixerSettings } from '../shared/settings';
import { EngineSelector } from './audio/engine-select';
import { MasterChain } from './audio/master-chain';
import { MODEL_IDS, keyInstalled } from '../shared/model-store';
import { AvProbe } from './av-probe';
import { deferEnd } from './deferred-end';
import { watchDelayGap } from './delay-gap';
import { PlayerSpinner } from './spinner';
import { TimeDisplay } from './time-display';
import { WarmupHold } from './warmup-hold';
import { initLyrics, type LyricsFeature } from './lyrics/init';
import { DelayedVideo } from './video-delay/delayed-video';
import { overlayDelayMs } from './video-delay/schedule';
import { detectSite, watchMainVideo, type PageSite } from './youtube-dom';

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
const spinner = new PlayerSpinner();
const spinnerFor = (reason: string, text: string) => (waiting: boolean) => spinner.set(reason, waiting ? text : null);
// The warm-up takes 10 to 40 s: hold the video (sound and picture) behind the player's spinner until it is over, then
// resume what we paused. The player is not told: it keeps showing "playing".
const WARMUP_LABEL = 'Preparing vocal separation';
let warmupTimer: ReturnType<typeof setInterval> | undefined;
/** The warm-up takes 10 to 40 s with no progress to report: count the seconds so it does not look stuck. */
const warmupSpinner = (on: boolean) => {
  clearInterval(warmupTimer);
  if (!on) return spinner.set('warmup', null);
  const t0 = performance.now();
  const tick = () => spinner.set('warmup', `${WARMUP_LABEL}… ${Math.round((performance.now() - t0) / 1000)} s`);
  tick();
  warmupTimer = setInterval(tick, 1000);
};
const warmupHold = new WarmupHold(() => video, () => warmupSpinner(false));
// The toolbar badge follows Separate mode. Only a frame that owns the media reports: the others would clear it.
let lastBadge = '';
const reportBadge = () => {
  if (!video) return;
  const view = separationView(settings.mode, status());
  const key = JSON.stringify(view);
  if (key === lastBadge) return;
  lastBadge = key;
  const msg: SetBadge = { type: 'set-badge', view };
  chrome.runtime.sendMessage(msg).catch(() => {});
};
selector.onChange = ({ state }) => {
  reportBadge();
  if (state === 'warming') {
    warmupHold.hold();
    // A video the user had paused is not waiting for anything.
    warmupSpinner(warmupHold.active);
    return;
  }
  warmupSpinner(false);
  warmupHold.release();
};
// A RoFormer model was downloaded or updated in the background: load it if it is the one in use.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const id of MODEL_IDS) if (keyInstalled(id) in changes) selector.reload(id);
});
// The end of the video (autoplay / queue) waits for the delayed tail to play out.
deferEnd(() => video, () => overlay?.delayMs ?? 0, spinnerFor('end', 'Playing the last seconds'));
watchDelayGap(() => video, () => overlay?.delayMs ?? 0, (cb) => chain.whenAudible(cb), spinnerFor('gap', 'Syncing the sound'));
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
chain.onLatencyChange((info, at) => {
  syncDelay(false, wantedDelayMs(info.videoDelayMs), at);
  reportBadge();
});

let modeKnown = false; // the first settings load is not a toggle
// Nothing starts (audio context, ML host) in a frame or page until it has media: most frames have none.
const push = () => {
  chain.setGain(masterGainFor(settings));
  const sep = separationFor(settings);
  chain.setSeparation(sep);
  selector.update({ on: sep.on, model: settings.mlModel, delayMs: mlDelayMsFor(settings), drums: settings.splitInstrumental && settings.mlModel !== 'sw', guitar: settings.splitGuitar && settings.mlModel !== 'sw', gpu: settings.gpu }); // the all-stems model has its own splits
  syncDelay();
};
const apply = (raw: unknown) => {
  const prevMode = settings.mode;
  settings = normalizeSettings(raw);
  if (settings.mode !== prevMode && modeKnown) lyrics.modeChanged();
  modeKnown = true;
  if (video) {
    push();
    reportBadge();
  }
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

function status(): ContentStatus {
  return {
    site,
    videoFound: video !== null,
    audio: chain.state,
    gain: chain.requestedGain,
    videoDelay: { state: overlay?.state ?? 'off', delayMs: overlay?.delayMs ?? 0, stats: overlay?.stats },
    separation: { state: chain.separationState, latency: chain.latency, choice: selector.status, error: chain.separationError },
    error: chain.error,
    avProbe: probe.on ? probe.status : undefined,
  };
}

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
    sendResponse(status());
  }
  return false;
});

const req: GetMyTabSettings = { type: 'get-my-tab-settings' };
chrome.runtime.sendMessage(req).then(apply, (e) => console.warn('[All Mixer!] settings load failed:', e));
