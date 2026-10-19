import type { ApplySettings, BackgroundRequest } from '../shared/messages';
import { TabStore } from './tab-store';
import { LyricsCache } from './lyrics-cache';
import { findLyrics, searchLyrics } from '../lyrics/lrclib';
import { ModelManager } from './model-manager';
import { Badges } from './badge';
import type { ModelId } from '../shared/model-store';

const store = new TabStore(chrome.storage.session);
const lyricsCache = new LyricsCache(chrome.storage.local);
const models = new ModelManager(chrome.storage.local);
const badges = new Badges();

// A stopped service worker would end the download: any extension API call resets its idle timer.
function install(id: ModelId): void {
  const t = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
  void models.install(id).finally(() => clearInterval(t));
}

async function handle(msg: BackgroundRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'get-my-tab-settings': {
      const tabId = sender.tab?.id;
      return tabId === undefined ? null : store.get(tabId);
    }
    case 'get-tab-settings':
      return store.get(msg.tabId);
    case 'set-tab-settings': {
      const settings = await store.set(msg.tabId, msg.settings);
      const apply: ApplySettings = { type: 'apply-settings', settings };
      // The content script may not be there (non-YouTube tab, or tab opened before install).
      await chrome.tabs.sendMessage(msg.tabId, apply).catch(() => {});
      return settings;
    }
    case 'fetch-lyrics':
      return lyricsCache.getOrFetch(msg.track, (t) => findLyrics(t));
    case 'search-lyrics':
      return searchLyrics(msg.q);
    case 'pin-lyrics':
      return lyricsCache.pin(msg.videoId, msg.found);
    case 'unpin-lyrics':
      return lyricsCache.unpin(msg.videoId);
    case 'set-badge': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) await badges.set(tabId, msg.view);
      return null;
    }
    case 'model-check':
      return models.check();
    case 'model-install':
      install(msg.id);
      return null;
  }
}

chrome.runtime.onMessage.addListener((msg: BackgroundRequest, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => {
    // LRCLIB being down is not a bug here: warn, so it stays out of the extension's Errors list.
    const lyrics = msg.type === 'fetch-lyrics' || msg.type === 'search-lyrics';
    (lyrics ? console.warn : console.error)('[All Mixer!]', e);
    sendResponse(null);
  });
  return true; // async response
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void store.remove(tabId);
  badges.clear(tabId);
});

// A full page load drops the tab's badge: stop the warming dots with it.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') badges.clear(tabId);
});
