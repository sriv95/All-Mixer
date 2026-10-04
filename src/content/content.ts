import type { ContentRequest, ContentStatus, GetMyTabSettings } from '../shared/messages';
import { DEFAULT_SETTINGS, masterGainFor, normalizeSettings, type MixerSettings } from '../shared/settings';
import { MasterChain } from './audio/master-chain';
import { detectSite, watchMainVideo } from './youtube-dom';

const site = detectSite(location.hostname);

if (site) {
  let settings: MixerSettings = { ...DEFAULT_SETTINGS };
  let video: HTMLVideoElement | null = null;
  const chain = new MasterChain();

  const apply = (raw: unknown) => {
    settings = normalizeSettings(raw);
    chain.setGain(masterGainFor(settings));
  };

  // The content script lives for the whole tab session, so the settings survive
  // YouTube's SPA navigation by default. Session storage (via the background)
  // covers full reloads of the same tab.
  watchMainVideo(site, (v) => {
    video = v;
    chain.setVideo(v);
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
        error: chain.error,
      };
      sendResponse(status);
    }
    return false;
  });

  const req: GetMyTabSettings = { type: 'get-my-tab-settings' };
  chrome.runtime.sendMessage(req).then(apply, (e) => console.warn('[All Mixer!] settings load failed:', e));
}
