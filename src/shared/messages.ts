import type { MixerSettings } from './settings';
import type { Site } from '../content/youtube-dom';

/** Content script → background: "what are my settings?" (tab id comes from sender). */
export interface GetMyTabSettings {
  type: 'get-my-tab-settings';
}

/** Popup → background. */
export interface GetTabSettings {
  type: 'get-tab-settings';
  tabId: number;
}

/** Popup → background: store and forward to the tab's content script. */
export interface SetTabSettings {
  type: 'set-tab-settings';
  tabId: number;
  settings: MixerSettings;
}

/** Background → content script. */
export interface ApplySettings {
  type: 'apply-settings';
  settings: MixerSettings;
}

/** Popup → content script. */
export interface GetStatus {
  type: 'get-status';
}

export type AudioState =
  | 'idle' // no boost requested yet, page audio untouched
  | 'waiting-for-gesture' // AudioContext needs a click/key on the page first
  | 'active'
  | 'error';

export interface ContentStatus {
  site: Site;
  videoFound: boolean;
  audio: AudioState;
  /** Requested master gain, linear (1 = 100 %). */
  gain: number;
  error?: string;
}

export type BackgroundRequest = GetMyTabSettings | GetTabSettings | SetTabSettings;
export type ContentRequest = ApplySettings | GetStatus;
