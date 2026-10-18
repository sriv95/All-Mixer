import type { ApplySettings, BackgroundRequest } from '../shared/messages';
import { TabStore } from './tab-store';
import { LyricsCache } from './lyrics-cache';
import { findLyrics } from '../lyrics/lrclib';

const store = new TabStore(chrome.storage.session);
const lyricsCache = new LyricsCache(chrome.storage.local);

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
  }
}

chrome.runtime.onMessage.addListener((msg: BackgroundRequest, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => {
    console.error('[All Mixer!]', e);
    sendResponse(null);
  });
  return true; // async response
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void store.remove(tabId);
});
