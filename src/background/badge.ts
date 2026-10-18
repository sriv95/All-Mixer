import type { SepView } from '../shared/separation-view';

const TITLE = 'All Mixer!';
/** The warming-up badge cycles through these, so the toolbar shows it is working. */
const DOTS = ['·', '··', '···'];
const DOT_MS = 400;
/** The warm-up takes 10 to 40 s: stop cycling after 2 minutes, whatever happens to the tab. */
const MAX_FRAMES = 300;

/** The toolbar badge for one tab: idle shows none, warming gray dots, live black ON, a stop a red ! on white. */
export function badgeFor(v: SepView, frame = DOTS.length - 1): { text: string; color: string; textColor: string; title: string } {
  switch (v.kind) {
    case 'off':
      return { text: '', color: '#000000', textColor: '#FFFFFF', title: TITLE };
    case 'warming':
      return { text: DOTS[frame], color: '#6B7280', textColor: '#FFFFFF', title: `${TITLE}: warming up, the original mix plays` };
    case 'live':
      return { text: 'ON', color: '#1B1B1F', textColor: '#FFFFFF', title: `${TITLE}: separating, ${v.delayS} s delay` };
    default:
      return { text: '!', color: '#FFFFFF', textColor: '#E11D2E', title: `${TITLE}: separation stopped, ${v.cause}` };
  }
}

export async function applyBadge(tabId: number, v: SepView, action: typeof chrome.action = chrome.action, frame?: number): Promise<void> {
  const b = badgeFor(v, frame);
  await Promise.all([
    action.setBadgeText({ tabId, text: b.text }),
    action.setBadgeBackgroundColor({ tabId, color: b.color }),
    action.setBadgeTextColor({ tabId, color: b.textColor }),
    action.setTitle({ tabId, title: b.title }),
  ]);
}

/** Sets the badges and runs the dots while a tab is warming up. */
export class Badges {
  private readonly timers = new Map<number, ReturnType<typeof setInterval>>();

  constructor(private readonly action: typeof chrome.action = chrome.action, private readonly ms = DOT_MS) {}

  set(tabId: number, v: SepView): Promise<void> {
    this.clear(tabId);
    if (v.kind !== 'warming') return applyBadge(tabId, v, this.action);
    let n = 0;
    this.timers.set(
      tabId,
      setInterval(() => {
        if (++n > MAX_FRAMES) return this.clear(tabId);
        applyBadge(tabId, v, this.action, n % DOTS.length).catch(() => this.clear(tabId)); // the tab is gone
      }, this.ms),
    );
    return applyBadge(tabId, v, this.action, 0);
  }

  clear(tabId: number): void {
    clearInterval(this.timers.get(tabId));
    this.timers.delete(tabId);
  }
}
