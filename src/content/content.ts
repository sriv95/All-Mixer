import type { ContentRequest, ContentStatus, GetMyTabSettings, SetBadge } from '../shared/messages';
import { ExportRunner } from './export-run';
import { PreloadRunner, holdingReason } from './preload-run';
import { separationView } from '../shared/separation-view';
import { DEFAULT_SETTINGS, masterGainFor, mlDelayMsFor, normalizeSettings, separationFor, type MixerSettings } from '../shared/settings';
import { EngineSelector } from './audio/engine-select';
import { MasterChain } from './audio/master-chain';
import { PreloadPlayer } from './audio/preload-player';
import { stemLevels, type StemCache } from './audio/stem-cache';
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
import { detectSite, onNavigate, watchMainVideo, type PageSite } from './youtube-dom';

/** How long the top frame without media waits before it answers the popup. */
const NO_MEDIA_REPLY_MS = 150;

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
const chain = new MasterChain(() => {
  syncDelay();
  reportBadge(); // the separator can fail or finish loading after the engine choice was made
}, undefined, probe);
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
// Playback that starts during the warm-up (a new song, play after a user pause, a video that was paused when it began)
// would run the original mix behind the spinner: hold it again.
window.addEventListener(
  'playing',
  (e) => {
    if (e.target !== video || selector.status.state !== 'warming') return;
    const wasActive = warmupHold.active;
    warmupHold.hold();
    if (!wasActive) warmupSpinner(warmupHold.active);
  },
  true,
);
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
  : { setVideo() {}, togglePanel() {}, current: () => null, modeChanged() {} };

// Export (src/export/engine.ts): while it records, the live separation is off so the GPU and the picture are the export's.
const exporter = new ExportRunner({
  site,
  video: () => video,
  lyrics: () => lyrics.current(),
  onChange: () => {
    if (video) push();
  },
});

// Preload Audio (src/content/preload-run.ts): the whole video is separated up front; the stems play from memory (PreloadPlayer).
const preloader = new PreloadRunner({
  site,
  video: () => video,
  exporting: () => exporter.running,
  onChange: () => {
    if (video) push();
  },
});
let player: PreloadPlayer | null = null;
let playerCache: StemCache | null = null;

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
  // Live separation is off while an export or a preload records (the GPU and the picture are theirs), and in Preload mode.
  const busy = exporter.running || preloader.running;
  const preloadMode = settings.mode === 'separate' && settings.preload;
  preloader.release();
  const cache = preloadMode && !busy ? preloader.ready() : null;
  const cacheOn = !!cache && !!video && PreloadPlayer.fits(cache, video, cache.key);
  // The pitch stage lives in the live worklet: the cache plays at the original pitch (the popup says so).
  const sep = separationFor(busy || preloadMode ? { ...settings, mode: 'default', ...(cacheOn ? { pitch: 0 } : {}) } : settings);
  chain.setSeparation(sep);
  chain.setPreloadActive(cacheOn);
  syncPlayer(cache, cacheOn);
  selector.update({ on: sep.on, model: settings.mlModel, delayMs: mlDelayMsFor(settings), drums: settings.splitInstrumental && settings.mlModel !== 'sw', guitar: settings.splitGuitar && settings.mlModel !== 'sw', gpu: settings.gpu }); // the all-stems model has its own splits
  syncDelay();
};
/** The player follows the cache of the open video: made when the cache first plays, dropped with the cache or the element. */
const syncPlayer = (cache: StemCache | null, on: boolean) => {
  if (player && playerCache !== cache) {
    player.dispose();
    player = null;
  }
  const bus = on && cache && video && !player ? chain.preloadBus : null;
  if (bus && cache && video) {
    player = new PreloadPlayer(bus.ctx, bus.out, video, cache);
    playerCache = cache;
  }
  if (!player || !cache) return;
  player.setLevels(stemLevels(settings, cache.buffers.keys()));
  player.setActive(on);
};
const apply = (raw: unknown) => {
  const prevMode = settings.mode;
  const prevPreload = settings.preload;
  settings = normalizeSettings(raw);
  // Leaving Preload mode (or the Separate tab) while it loads would leave a muted video recording behind a popup that no longer shows it.
  if (preloader.running && !(settings.preload && settings.mode === 'separate')) preloader.cancel();
  // Switching to Preload Audio starts the preload (a settings load after a reload is not a switch).
  if (settings.preload && !prevPreload && modeKnown && settings.mode === 'separate' && video && !preloader.running && !preloader.ready()) preloader.start(settings);
  if (settings.mode !== prevMode && modeKnown) lyrics.modeChanged();
  modeKnown = true;
  if (video) {
    push();
    reportBadge();
  }
};

// What decides whether the cache plays changes with the clip (an ad, another video) and the speed.
for (const e of ['durationchange', 'ratechange', 'emptied'] as const) window.addEventListener(e, (ev) => ev.target === video && push(), true);
onNavigate(() => video && push());

// The content script lives for the whole tab session, so the settings survive
// YouTube's SPA navigation by default. Session storage (via the background)
// covers full reloads of the same tab.
watchMainVideo(site, (v) => {
  player?.dispose();
  player = null;
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
    export: exporter.progress,
    preload: preloader.status(settings, holdingReason(preloader.ready(), video), player?.playing ? { level: player.level(), driftMs: player.driftMs() } : undefined),
    duration: video?.duration,
    lyricsSynced: lyrics.current() !== null,
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
  } else if (msg.type === 'export-start') {
    // Like get-status: the frame that plays the media answers; the top frame says so when there is none.
    if (preloader.running) sendResponse({ ok: false, error: 'Preloading is running in this tab. Wait for it, or cancel it first.' });
    else if (video) sendResponse(exporter.start(msg.options));
    else if (window === window.top) {
      setTimeout(() => sendResponse({ ok: false, error: 'There is no video to export on this page.' }), NO_MEDIA_REPLY_MS);
      return true;
    }
  } else if (msg.type === 'preload-start') {
    if (video) sendResponse(preloader.start(settings));
    else if (window === window.top) {
      setTimeout(() => sendResponse({ ok: false, error: 'There is no video to preload on this page.' }), NO_MEDIA_REPLY_MS);
      return true;
    }
  } else if (msg.type === 'preload-cancel') {
    preloader.cancel();
    sendResponse({ ok: true });
  } else if (msg.type === 'export-cancel') {
    exporter.cancel();
    sendResponse({ ok: true });
  } else if (msg.type === 'get-status') {
    // Every frame hears this and the popup takes the first answer: a frame without media stays quiet, and the top frame
    // answers late, so the frame that plays the media is heard whenever there is one.
    if (video) sendResponse(status());
    else if (window === window.top) {
      setTimeout(() => sendResponse(status()), NO_MEDIA_REPLY_MS);
      return true;
    }
  }
  return false;
});

const req: GetMyTabSettings = { type: 'get-my-tab-settings' };
chrome.runtime.sendMessage(req).then(apply, (e) => console.warn('[All Mixer!] settings load failed:', e));
