/**
 * Protocol between the content script (isolated world) and src/page/bridge.ts
 * (main world, which can read YouTube's player object). window.postMessage only;
 * the page bridge never receives extension privileges.
 */

export const BRIDGE_TAG = '__allMixer';

/** Fired on a media element (main world -> content script) when the page calls pause() on one that has ended or is already paused. */
export const PAUSE_REQUEST_EVENT = '__allMixerPauseRequest';

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  /** 'asr' for auto-generated tracks. */
  kind?: string;
  name?: string;
}

export interface PlayerInfo {
  videoId: string;
  title: string;
  author: string;
  /** Seconds; 0 when unknown. */
  lengthSeconds: number;
  /** YT Music only: MUSIC_VIDEO_TYPE_ATV (art track), _OMV (official video), _UGC … */
  musicVideoType?: string;
  captionTracks: CaptionTrack[];
  /** Language of the track the player would pick by default. */
  defaultCaptionLang?: string;
}

/** The audio the player appended to the MediaSource of a media element (src/page/audio-tap.ts): what is held and what it covers. */
export interface TapStatus {
  usable: boolean;
  /** Why it is not usable. */
  reason?: string;
  mime: string;
  /** Time ranges (s) that were in the player's buffer at some moment. */
  covered: [number, number][];
  /** Start (s) of every segment that was cut short (a seek during its download). */
  incomplete: number[];
  bytes: number;
}

/** The held audio as one file (init segment and segments in time order). */
export interface TapData {
  mime: string;
  data: ArrayBuffer;
}

export type BridgeRequest =
  | { kind: 'player-info'; videoId: string }
  | { kind: 'timedtext'; videoId: string; track: CaptionTrack }
  | { kind: 'audio-tap'; op: 'status' | 'take'; url: string };

export interface BridgeRequestMsg {
  [BRIDGE_TAG]: 'req';
  id: number;
  req: BridgeRequest;
}

export interface BridgeResponseMsg {
  [BRIDGE_TAG]: 'res';
  id: number;
  /** PlayerInfo | json3 string | null */
  data: unknown;
}

/** Page → content, unsolicited: the player just loaded captions for `videoId` (user turned CC on). */
export interface BridgeEventMsg {
  [BRIDGE_TAG]: 'evt';
  kind: 'captions';
  videoId: string;
}
