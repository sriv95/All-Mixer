import type { ContentRequest, ContentStatus, GetMyTabSettings } from '../shared/messages';
import { DEFAULT_SETTINGS, masterGainFor, normalizeSettings, type MixerSettings } from '../shared/settings';
import { MasterChain } from './audio/master-chain';
import { DelayedVideo } from './video-delay/delayed-video';
import { overlayDelayMs } from './video-delay/schedule';
import { detectSite, watchMainVideo } from './youtube-dom';

const site = detectSite(location.hostname);

if (site) {
  let settings: MixerSettings = { ...DEFAULT_SETTINGS };
  let video: HTMLVideoElement | null = null;
  let overlay: DelayedVideo | null = null;
  const chain = new MasterChain(() => syncDelay());

  const wantedDelayMs = (): number => {
    if (settings.mode === 'separate') {
      // SRI-8: Duke wires SRI-7 latency here
      return 0;
    }
    return overlayDelayMs(settings.mode, chain.deviceLatencyMs);
  };

  /** Apply the wanted picture delay; ignore moves under 5 ms (latency jitter). */
  const syncDelay = (force = false) => {
    if (!overlay) return;
    const want = wantedDelayMs();
    if (!force && Math.abs(want - overlay.delayMs) < 5 && (want > 0) === (overlay.delayMs > 0)) return;
    overlay.setDelay(want);
  };

  // outputLatency can change at runtime (e.g. Bluetooth connects).
  setInterval(() => {
    if (chain.state === 'active') syncDelay();
  }, 2000);

  const apply = (raw: unknown) => {
    settings = normalizeSettings(raw);
    // SRI-7: engine reads settings.separationQuality
    chain.setGain(masterGainFor(settings));
    syncDelay();
  };

  // The content script lives for the whole tab session, so the settings survive
  // YouTube's SPA navigation by default. Session storage (via the background)
  // covers full reloads of the same tab.
  watchMainVideo(site, (v) => {
    video = v;
    chain.setVideo(v);
    overlay?.destroy();
    overlay = new DelayedVideo(v);
    syncDelay(true);
  });

  chrome.runtime.onMessage.addListener((msg: ContentRequest, _sender, sendResponse) => {
    if (msg.type === 'apply-settings') {
      apply(msg.settings);
      sendResponse({ ok: true });
    } else if (msg.type === 'get-status') {
      const status: ContentStatus = {
        site,
        videoFound: video !== null,
        audio: chain.state,
        gain: chain.requestedGain,
        videoDelay: { state: overlay?.state ?? 'off', delayMs: overlay?.delayMs ?? 0 },
        error: chain.error,
      };
      sendResponse(status);
    }
    return false;
  });

  const req: GetMyTabSettings = { type: 'get-my-tab-settings' };
  chrome.runtime.sendMessage(req).then(apply, (e) => console.warn('[All Mixer!] settings load failed:', e));
}
