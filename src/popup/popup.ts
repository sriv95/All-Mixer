import type { ContentStatus, GetStatus, GetTabSettings, SetTabSettings } from '../shared/messages';
import { clampPct, normalizeSettings, type MixerSettings, type Mode, type SeparationQuality } from '../shared/settings';
import { detectSite } from '../content/youtube-dom';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const master = $<HTMLInputElement>('master');
const masterValue = $<HTMLOutputElement>('master-value');
const quality = $<HTMLSelectElement>('separation-quality');
const status = $<HTMLParagraphElement>('status');

let tabId: number | null = null;
let settings: MixerSettings = normalizeSettings({});

function render(): void {
  for (const tab of tabs) {
    const selected = tab.dataset.mode === settings.mode;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute('aria-controls')!).hidden = !selected;
  }
  master.value = String(settings.masterPct);
  masterValue.value = `${settings.masterPct}%`;
  quality.value = settings.separationQuality;
}

let pending = false;
function save(): void {
  render();
  // Coalesce slider drags to one message per frame.
  if (pending || tabId === null) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const msg: SetTabSettings = { type: 'set-tab-settings', tabId: tabId!, settings };
    void chrome.runtime.sendMessage(msg).then(refreshStatus);
  });
}

function setMode(mode: Mode): void {
  settings = { ...settings, mode };
  save();
}

const STATUS_TEXT: Record<ContentStatus['audio'], string> = {
  idle: '',
  'waiting-for-gesture': 'Click anywhere on the YouTube page once to enable the boost.',
  active: '',
  error: 'Audio error',
};

async function refreshStatus(): Promise<void> {
  if (tabId === null) return;
  const req: GetStatus = { type: 'get-status' };
  const s: ContentStatus | undefined = await chrome.tabs.sendMessage(tabId, req).catch(() => undefined);
  if (!s) {
    status.textContent = 'Reload this YouTube tab to start All Mixer!.';
  } else if (s.audio === 'error') {
    status.textContent = `${STATUS_TEXT.error}: ${s.error ?? 'unknown'}`;
  } else if (!s.videoFound && settings.masterPct !== 100) {
    status.textContent = 'No video player on this page yet.';
  } else {
    status.textContent = STATUS_TEXT[s.audio];
  }
}

function disableAll(message: string): void {
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select')) {
    el.disabled = true;
  }
  status.textContent = message;
}

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // `tab.url` is only visible for our host permissions, i.e. YouTube / YT Music.
  if (tab?.id === undefined || !tab.url || !detectSite(new URL(tab.url).hostname)) {
    render();
    disableAll('Open a youtube.com or music.youtube.com tab to use All Mixer!.');
    return;
  }
  tabId = tab.id;
  const req: GetTabSettings = { type: 'get-tab-settings', tabId };
  settings = normalizeSettings(await chrome.runtime.sendMessage(req));
  render();
  await refreshStatus();
}

for (const tab of tabs) {
  tab.addEventListener('click', () => setMode(tab.dataset.mode as Mode));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    setMode(next.dataset.mode as Mode);
  });
}

master.addEventListener('input', () => {
  settings = { ...settings, masterPct: clampPct(master.value) };
  save();
});

quality.addEventListener('change', () => {
  settings = normalizeSettings({ ...settings, separationQuality: quality.value as SeparationQuality });
  save();
});

$<HTMLButtonElement>('master-reset').addEventListener('click', () => {
  settings = { ...settings, masterPct: 100 };
  save();
});

void init();
