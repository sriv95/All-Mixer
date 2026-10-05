/**
 * Protocol between the content script (isolated world) and src/page/bridge.ts
 * (main world, which can read YouTube's player object). window.postMessage only;
 * the page bridge never receives extension privileges.
 */

export const BRIDGE_TAG = '__allMixer';

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  /** 'asr' for auto-generated tracks. */
  kind?: string;
  name?: string;
  /** YouTube can auto-translate this track (see PlayerInfo.translationLanguages). */
  isTranslatable?: boolean;
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
  /** Languages YouTube can auto-translate translatable tracks into. */
  translationLanguages?: { languageCode: string; name: string }[];
}

export type BridgeRequest =
  | { kind: 'player-info'; videoId: string }
  | { kind: 'timedtext'; videoId: string; track: CaptionTrack; /** Auto-translate target language. */ tlang?: string };

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
