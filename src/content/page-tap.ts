import type { AudioTap } from '../export/fast-audio';
import { tapStatus, tapTake } from './lyrics/bridge-client';
import type { PageSite } from './youtube-dom';

/** The audio the YouTube player downloaded, through the page bridge; undefined on other sites, or with `debug.noFastAudio` set (QA of the recording path). */
export async function pageTap(site: PageSite): Promise<AudioTap | undefined> {
  if (site === 'generic') return undefined;
  try {
    if ((await chrome.storage.local.get('debug.noFastAudio'))['debug.noFastAudio'] === true) return undefined;
  } catch {
    /* no storage: the tap is on */
  }
  return { status: tapStatus, take: tapTake };
}
