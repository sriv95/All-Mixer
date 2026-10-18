import type { ContentStatus, GetStatus, GetTabSettings, SetTabSettings } from '../shared/messages';
import { clampPct, normalizeSettings, type MixerSettings, type Mode } from '../shared/settings';
import type { MlModel } from '../worklet/protocol';
import { detectSite } from '../content/youtube-dom';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const master = $<HTMLInputElement>('master');
const masterValue = $<HTMLOutputElement>('master-value');
const vocal = $<HTMLInputElement>('vocal');
const vocalValue = $<HTMLOutputElement>('vocal-value');
const instrumental = $<HTMLInputElement>('instrumental');
const instrumentalValue = $<HTMLOutputElement>('instrumental-value');
const mlModel = $<HTMLSelectElement>('ml-model');
const mlGate = $<HTMLInputElement>('ml-gate');
const presets = [...document.querySelectorAll<HTMLButtonElement>('.presets button')];
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
  vocal.value = String(settings.vocalPct);
  vocalValue.value = `${settings.vocalPct}%`;
  instrumental.value = String(settings.instrumentalPct);
  instrumentalValue.value = `${settings.instrumentalPct}%`;
  mlModel.value = settings.mlModel;
  mlGate.checked = settings.mlGate;
  for (const b of presets) {
    const on = Number(b.dataset.vocal) === settings.vocalPct && Number(b.dataset.instrumental) === settings.instrumentalPct;
    b.setAttribute('aria-pressed', String(on));
  }
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
  if (mode !== 'separate') {
    // Do not wait for refreshStatus: drop the stale separation text and the warming poll now.
    clearTimeout(pollTimer);
    status.textContent = '';
  }
  save();
}

const STATUS_TEXT: Record<ContentStatus['audio'], string> = {
  idle: '',
  'waiting-for-gesture': 'Click anywhere on the YouTube page once to enable the boost.',
  active: '',
  error: 'Audio error',
};

function separationText(s: ContentStatus): string {
  const sep = s.separation;
  if (settings.mode !== 'separate' || !sep) return '';
  if (sep.state === 'loading') return 'Starting separation…';
  if (sep.state === 'on') {
    const choice = sep.choice;
    switch (choice?.state) {
      case 'warming':
        return 'Separation warming up… Playing the original mix.';
      case 'unavailable':
        return `Separation unavailable: ${choice.cause ?? 'unknown'}. Playing the original mix.`;
      case 'stopped':
        return 'Separation stopped: this device is too slow (ML missed its deadline). Playing the original mix. Switch to Default and back to retry.';
      default:
        return `Separation on · ${Math.round(sep.latency.processingMs)} ms delay`;
    }
  }
  if (sep.state === 'error') return `Separation unavailable: ${sep.error ?? 'unknown'}. Playing the original mix.`;
  return '';
}

// While the separator starts or ML warms up, poll so the popup moves on from "Starting separation…" by itself.
const LOADING_POLL_MS = 500;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

async function refreshStatus(): Promise<void> {
  if (tabId === null) return;
  clearTimeout(pollTimer);
  const req: GetStatus = { type: 'get-status' };
  const s: ContentStatus | undefined = await chrome.tabs.sendMessage(tabId, req).catch(() => undefined);
  if (!s) {
    status.textContent = 'Reload this YouTube tab to start All Mixer!.';
  } else if (s.audio === 'error') {
    status.textContent = `${STATUS_TEXT.error}: ${s.error ?? 'unknown'}`;
  } else if (!s.videoFound && settings.masterPct !== 100) {
    status.textContent = 'No video player on this page yet.';
  } else {
    status.textContent = separationText(s) || STATUS_TEXT[s.audio];
  }
  const warming = s?.separation?.state === 'loading' || s?.separation?.choice?.state === 'warming';
  if (warming && settings.mode === 'separate') {
    pollTimer = setTimeout(() => void refreshStatus(), LOADING_POLL_MS);
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

vocal.addEventListener('input', () => {
  settings = { ...settings, vocalPct: clampPct(vocal.value) };
  save();
});

instrumental.addEventListener('input', () => {
  settings = { ...settings, instrumentalPct: clampPct(instrumental.value) };
  save();
});

mlModel.addEventListener('change', () => {
  settings = { ...settings, mlModel: mlModel.value as MlModel };
  save();
});

mlGate.addEventListener('change', () => {
  settings = { ...settings, mlGate: mlGate.checked };
  save();
});

for (const b of presets) {
  b.addEventListener('click', () => {
    settings = { ...settings, vocalPct: Number(b.dataset.vocal), instrumentalPct: Number(b.dataset.instrumental) };
    save();
  });
}

$<HTMLButtonElement>('master-reset').addEventListener('click', () => {
  settings = { ...settings, masterPct: 100 };
  save();
});

void init();
