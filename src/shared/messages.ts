import type { MixerSettings } from './settings';
import type { ModelId } from './model-store';
import type { TrackInfo } from '../lyrics/types';
import type { FoundLyrics } from '../lyrics/lrclib-types';
import type { OverlayState, VideoDelayStats } from '../content/video-delay/delayed-video';
import type { PageSite } from '../content/youtube-dom';
import type { SeparationState } from '../content/audio/master-chain';
import type { EngineChoice } from '../content/audio/engine-select';
import type { LatencyInfo } from '../content/audio/latency';
import type { SepView } from './separation-view';

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

/** SRI-95 debug probe: latest picture / sound edges (performance.now() ms) and the offsets between them. */
export interface AvProbeStatus {
  audioOn?: { inputAt: number; audibleAt: number };
  audioOff?: { inputAt: number; audibleAt: number };
  videoOn?: number;
  videoOff?: number;
  overlayOn?: number;
  overlayOff?: number;
  /** performance.now() of the last media event, by name. */
  events: Record<string, number>;
  /** Sound minus picture at the last start / stop; want ≈ 0. */
  playOffsetMs?: number;
  pauseOffsetMs?: number;
  /** Chrome's own audio-input vs. video offset at the last start. */
  pipelineMs?: number;
  /** Last 20 pause / play transitions, each paired with its media event (SRI-102). */
  transitions?: AvTransition[];
  /** Why offsets may be empty: probe flag on, MediaElementSource attached, AudioContext state. */
  probeOn?: boolean;
  audioAttached?: boolean;
  ctxState?: string;
}

export interface AvTransition {
  kind: 'pause' | 'play';
  at: number;
  playOffsetMs?: number;
  pauseOffsetMs?: number;
  pipelineMs?: number;
  /** Analyser level in the 1.5 s after the event (SRI-184): max RMS / peak and ms to the first sample over the edge threshold. */
  level?: { rms: number; peak: number; firstAboveMs?: number };
  /** Edges not seen in the window. */
  missing: string[];
}

export interface ContentStatus {
  site: PageSite;
  videoFound: boolean;
  audio: AudioState;
  /** Requested master gain, linear (1 = 100 %). */
  gain: number;
  videoDelay: { state: OverlayState; delayMs: number; stats?: VideoDelayStats };
  /** Separate mode engine; absent from content scripts older than SRI-7. */
  separation?: {
    state: SeparationState;
    latency: LatencyInfo;
    /** ML probe state for the popup (cause: short text for the UI). */
    choice?: EngineChoice;
    error?: string;
  };
  error?: string;
  /** Only when localStorage['allMixer.avProbe'] === '1'. */
  avProbe?: AvProbeStatus;
}

/** Content script → background: fetch lyrics from LRCLIB (cached). Response: FoundLyrics | null. */
export interface FetchLyrics {
  type: 'fetch-lyrics';
  track: TrackInfo;
}

/** Content script → background: free-text LRCLIB search. Response: LrclibRecord[] (usable lyrics only). */
export interface SearchLyrics {
  type: 'search-lyrics';
  q: string;
}

/** Content script → background: use these lyrics for this video from now on. */
export interface PinLyrics {
  type: 'pin-lyrics';
  videoId: string;
  found: FoundLyrics;
}

/** Content script → background: back to the automatic lyrics for this video. */
export interface UnpinLyrics {
  type: 'unpin-lyrics';
  videoId: string;
}

/** Popup → background: look for newer RoFormer models (the result lands in chrome.storage.local, see model-store.ts). */
export interface ModelCheck {
  type: 'model-check';
}

/** Popup → background: download the newest version of one RoFormer model (progress lands in chrome.storage.local). */
export interface ModelInstall {
  type: 'model-install';
  id: ModelId;
}

/** Content script → background: what Separate mode is doing in this tab, for the toolbar badge. */
export interface SetBadge {
  type: 'set-badge';
  view: SepView;
}

export type BackgroundRequest =
  | GetMyTabSettings
  | GetTabSettings
  | SetTabSettings
  | FetchLyrics
  | SearchLyrics
  | PinLyrics
  | UnpinLyrics
  | ModelCheck
  | ModelInstall
  | SetBadge;
/**
 * QA only (sent via chrome.tabs.sendMessage from extension contexts): force the
 * picture delay, ignoring the graph latency. null clears it. `budgetBytes`
 * overrides the frame memory budget; >= 1e12 reproduces the old behaviour.
 */
interface DebugVideoDelay {
  type: 'debug-video-delay';
  delayMs: number | null;
  budgetBytes?: number | null;
}

/** Popup → content script, repeated while its button is held: play every stem at 100 % (the original mix). */
export interface HoldOriginal {
  type: 'hold-original';
  on: boolean;
}

export type ContentRequest = ApplySettings | GetStatus | HoldOriginal | DebugVideoDelay;
