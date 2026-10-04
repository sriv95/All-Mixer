import { DEFAULT_SETTINGS, normalizeSettings, type MixerSettings } from '../shared/settings';

/** Minimal slice of chrome.storage.StorageArea we use (easy to fake in tests). */
export interface KeyValueArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export const tabKey = (tabId: number) => `tab:${tabId}`;

/**
 * Per-tab settings. Backed by chrome.storage.session: survives SPA navigation,
 * reloads and service-worker restarts, and is cleared when the browser closes.
 */
export class TabStore {
  constructor(private readonly area: KeyValueArea) {}

  async get(tabId: number): Promise<MixerSettings> {
    const key = tabKey(tabId);
    const items = await this.area.get(key);
    return key in items ? normalizeSettings(items[key]) : { ...DEFAULT_SETTINGS };
  }

  async set(tabId: number, settings: unknown): Promise<MixerSettings> {
    const clean = normalizeSettings(settings);
    await this.area.set({ [tabKey(tabId)]: clean });
    return clean;
  }

  async remove(tabId: number): Promise<void> {
    await this.area.remove(tabKey(tabId));
  }
}
