import type { SepView } from '../shared/separation-view';

const TITLE = 'All Mixer!';

/** The toolbar badge for one tab: idle shows none, warming gray dots, live black ON, a stop a red ! on white. */
export function badgeFor(v: SepView): { text: string; color: string; textColor: string; title: string } {
  switch (v.kind) {
    case 'off':
      return { text: '', color: '#000000', textColor: '#FFFFFF', title: TITLE };
    case 'warming':
      return { text: '···', color: '#6B7280', textColor: '#FFFFFF', title: `${TITLE}: warming up, the original mix plays` };
    case 'live':
      return { text: 'ON', color: '#1B1B1F', textColor: '#FFFFFF', title: `${TITLE}: separating, ${v.delayS} s delay` };
    default:
      return { text: '!', color: '#FFFFFF', textColor: '#E11D2E', title: `${TITLE}: separation stopped, ${v.cause}` };
  }
}

export async function applyBadge(tabId: number, v: SepView, action: typeof chrome.action = chrome.action): Promise<void> {
  const b = badgeFor(v);
  await Promise.all([
    action.setBadgeText({ tabId, text: b.text }),
    action.setBadgeBackgroundColor({ tabId, color: b.color }),
    action.setBadgeTextColor({ tabId, color: b.textColor }),
    action.setTitle({ tabId, title: b.title }),
  ]);
}
