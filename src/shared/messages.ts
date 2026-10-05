import type { MixerSettings } from './settings';
import type { TrackInfo } from '../lyrics/types';
import type { OverlayState } from '../content/video-delay/delayed-video';
import type { Site } from '../content/youtube-dom';
import type { SeparationState } from '../content/audio/master-chain';
import type { EngineChoice } from '../content/audio/engine-select';
import type { LatencyInfo } from '../content/audio/latency';

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
  videoDelay: { state: OverlayState; delayMs: number };
  /** Separate mode engine; absent from content scripts older than SRI-7. */
  separation?: {
    state: SeparationState;
    latency: LatencyInfo;
    /** ML probe state for the popup (cause: short text for the UI). */
    choice?: EngineChoice;
    error?: string;
  };
  error?: string;
}

/** Content script → background: fetch lyrics from LRCLIB (cached). Response: FoundLyrics | null. */
export interface FetchLyrics {
  type: 'fetch-lyrics';
  track: TrackInfo;
}

export type BackgroundRequest = GetMyTabSettings | GetTabSettings | SetTabSettings | FetchLyrics;
export type ContentRequest = ApplySettings | GetStatus;
